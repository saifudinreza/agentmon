// =====================================================================================
// FILE INI: API baca riwayat untuk HP = "LOKET ARSIP" yang melayani HP yang sudah terpasang.
// =====================================================================================
//
//   GET /api/machines
//       Laptop yang dipasangkan dengan HP ini, beserta apakah sedang tersambung ke relay.
//   GET /api/machines/:machineId/sessions
//       Sesi laptop itu, dari yang paling baru aktif.
//   GET /api/machines/:machineId/sessions/:sessionId/events?afterSeq=N&limit=M
//       Event satu sesi, berurutan menurut nomor urut, mulai SETELAH `afterSeq`. HP memakainya untuk
//       memuat riwayat dan untuk mengambil yang terlewat setelah koneksi putus atau HP dikunci.
//   GET /api/push/key, PUT /api/push/subscription, DELETE /api/push/subscription
//       Web Push: apakah push menyala dan kunci publik VAPID, mendaftarkan langganan HP ini (menggantikan yang
//       lama), dan mencabutnya. Hanya ada bila relay diberi penyimpanan langganan.
//
// ANALOGI: arsip kantor. Siapa pun boleh minta berkas, tetapi petugas memeriksa kartu anggota (token HP)
// dan memastikan laptop yang diminta memang milik anggota itu.
//
// KEAMANAN:
//   - Semua jalur butuh token HP (Bearer). Token salah = 401.
//   - HP hanya boleh membaca laptop yang dipasangkan dengannya. Laptop yang tidak dipasangkan dijawab
//     SAMA dengan laptop yang tidak ada (404), supaya tidak bisa dipakai mencari tahu laptop mana yang
//     terdaftar.
//   - Laju dibatasi per HP, dan ukuran halaman dibatasi (maksimal 500 event).
//   - CORS hanya untuk asal PWA yang diizinkan.
import { ApprovalsResponseSchema, DevicesResponseSchema, EventsResponseSchema, PushConfigResponseSchema, type DeviceMachine, type PendingApproval, type SessionSummary } from "@agentmon/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { computePendingApprovals } from "./approvals";
import type { DbDirectory } from "./db/directory";
import type { PairingService } from "./db/pairing";
import type { PushStore } from "./db/push";
import { MAX_PAGE_SIZE, type Store } from "./db/store";
import { clientAddress } from "./client-ip";
import { validateSubscription } from "./push";
import { createKeyedRateLimiter } from "./rate-limit";

export type DeviceApiOptions = {
  directory: Pick<DbDirectory, "authenticate" | "isPaired" | "machinesOf">;
  store: Pick<Store, "listSessions" | "listEvents" | "listRecentByType">;
  isMachineOnline: (machineId: string) => boolean;
  /** Daftar dan pencabut perangkat. Tanpa ini, /api/devices tidak dipasang. */
  devices?: Pick<PairingService, "listPeerDevices" | "revokeDevice">;
  /** Dipanggil setelah sebuah perangkat dicabut, untuk memutus koneksinya seketika. */
  onDeviceRevoked?: (deviceId: string) => void;
  /**
   * Web Push. Tanpa ini, /api/push/* tidak dipasang. `vapidPublicKey` kosong berarti push belum dikonfigurasi di relay:
   * HP diberi tahu `enabled: false` dan pendaftaran langganan ditolak (503).
   */
  push?: {
    store: Pick<PushStore, "replace" | "removeAll">;
    vapidPublicKey?: string;
    isAllowedEndpoint: (endpoint: string) => boolean;
  };
  /** Asal PWA yang boleh memanggil dari browser, misalnya ["https://app.contoh.com"]. */
  allowedOrigins?: string[];
  /** Batas laju per HP (permintaan yang sah). */
  limits?: { burst: number; refillPerSecond: number };
  /** Batas permintaan yang GAGAL autentikasi per alamat IP (lihat `authenticate`). */
  authFailureLimits?: { burst: number; refillPerSecond: number };
  /** Relay di belakang proxy hosting: alamat IP dibaca dari X-Forwarded-For (lihat client-ip.ts). */
  trustProxy?: boolean;
  now?: () => number;
};

export const DEFAULT_DEVICE_API_LIMITS = { burst: 60, refillPerSecond: 5 };
// Longgar untuk pengguna sah yang sesekali salah (token basi di satu HP), ketat untuk penyerang.
export const DEFAULT_AUTH_FAILURE_LIMITS = { burst: 30, refillPerSecond: 1 };

// Permintaan izin yang lebih tua dari ini tidak mungkin masih menunggu (batas waktu bawaan 9 menit), jadi tidak perlu dibaca.
const APPROVAL_LOOKBACK_MS = 30 * 60 * 1000;

const MAX_ID_LENGTH = 200;
const DEFAULT_EVENTS_LIMIT = 200;
// Langganan dari browser hanya beberapa ratus byte; batas ini menolak kiriman raksasa sebelum dibaca.
const MAX_PUSH_BODY_BYTES = 4096;

function bearer(c: Context): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  return match?.[1];
}

// Bilangan bulat dari parameter alamat; nilai yang bukan angka sah memakai nilai bawaan.
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^-?\d{1,9}$/.test(raw)) return fallback;
  return Math.min(Math.max(Number(raw), min), max);
}

export function mountDeviceApi(app: Hono, options: DeviceApiOptions): void {
  const { directory, store } = options;
  const limits = options.limits ?? DEFAULT_DEVICE_API_LIMITS;
  const limiter = createKeyedRateLimiter({
    capacity: limits.burst,
    refillPerSecond: limits.refillPerSecond,
    ...(options.now ? { now: options.now } : {}),
  });

  // Permintaan bertoken salah dihitung per alamat IP. Token 256 bit tidak bisa ditebak, tetapi tiap permintaan
  // bertoken salah tetap menjalankan satu kueri database; tanpa batas, satu klien bisa membebani database
  // dengan token acak. Batas ini sama dengan yang dipakai endpoint pairing (per IP).
  const failureLimits = options.authFailureLimits ?? DEFAULT_AUTH_FAILURE_LIMITS;
  const failures = createKeyedRateLimiter({
    capacity: failureLimits.burst,
    refillPerSecond: failureLimits.refillPerSecond,
    ...(options.now ? { now: options.now } : {}),
  });

  const allowed = new Set(options.allowedOrigins ?? []);
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ["GET", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      maxAge: 600,
    }),
  );

  // Memeriksa HP: token sah dan belum melewati batas laju. Mengembalikan nomor HP, atau Response penolakan.
  const authenticate = async (c: Context): Promise<{ deviceId: string } | Response> => {
    const address = clientAddress(c, options.trustProxy);
    // Alamat yang sudah menghabiskan jatah kegagalannya ditolak SEBELUM menyentuh database. Pengguna sah di
    // balik alamat yang sama (satu jaringan) ikut tertahan sampai jatahnya pulih; HP mencoba lagi sendiri.
    if (!failures.canTake(address)) return c.json({ error: "rate-limited" }, 429);
    const token = bearer(c);
    const deviceId = token ? await directory.authenticate("device", token) : undefined;
    if (!deviceId) {
      failures.take(address);
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!limiter.take(deviceId)) return c.json({ error: "rate-limited" }, 429);
    return { deviceId };
  };

  // Laptop harus dipasangkan dengan HP ini. Tidak dipasangkan dan tidak ada dijawab sama.
  const machineGuard = async (c: Context, deviceId: string, machineId: string): Promise<Response | undefined> => {
    if (machineId.length > MAX_ID_LENGTH || !(await directory.isPaired(machineId, deviceId))) return c.json({ error: "not-found" }, 404);
    return undefined;
  };

  app.get("/api/machines", async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const rows = await directory.machinesOf(auth.deviceId);
    const machines: DeviceMachine[] = rows.map((m) => ({ id: m.id, name: m.name, online: options.isMachineOnline(m.id) }));
    return c.json({ machines });
  });

  if (options.devices) {
    const peers = options.devices;
    // Perangkat yang berbagi laptop dengan HP ini; yang sedang dipakai ditandai `current`.
    app.get("/api/devices", async (c) => {
      const auth = await authenticate(c);
      if (auth instanceof Response) return auth;
      const list = await peers.listPeerDevices(auth.deviceId);
      return c.json(DevicesResponseSchema.parse({ devices: list.map((d) => ({ ...d, current: d.id === auth.deviceId })) }));
    });
    // Mencabut perangkat (termasuk dirinya sendiri). Berlaku seketika: koneksinya diputus dan tokennya ditolak.
    app.delete("/api/devices/:deviceId", async (c) => {
      const auth = await authenticate(c);
      if (auth instanceof Response) return auth;
      const target = c.req.param("deviceId");
      if (target.length > MAX_ID_LENGTH || !(await peers.revokeDevice({ deviceId: auth.deviceId }, target))) return c.json({ error: "not-found" }, 404);
      options.onDeviceRevoked?.(target);
      return c.json({ ok: true });
    });
  }

  if (options.push) {
    const push = options.push;
    // Apakah push menyala, dan kunci publik untuk berlangganan di browser. Kunci publik bukan rahasia, tetapi tetap
    // hanya diberikan ke HP yang sudah terpasang.
    app.get("/api/push/key", async (c) => {
      const auth = await authenticate(c);
      if (auth instanceof Response) return auth;
      return c.json(PushConfigResponseSchema.parse(push.vapidPublicKey ? { enabled: true, publicKey: push.vapidPublicKey } : { enabled: false }));
    });
    // Mendaftarkan langganan HP ini. Menggantikan langganan lamanya (satu HP, satu langganan).
    app.put(
      "/api/push/subscription",
      bodyLimit({ maxSize: MAX_PUSH_BODY_BYTES, onError: (c) => c.json({ error: "too-large" }, 413) }),
      async (c) => {
        const auth = await authenticate(c);
        if (auth instanceof Response) return auth;
        if (!push.vapidPublicKey) return c.json({ error: "push-disabled" }, 503);
        const subscription = validateSubscription(await c.req.json().catch(() => undefined), push.isAllowedEndpoint);
        if (!subscription) return c.json({ error: "invalid-subscription" }, 400);
        await push.store.replace(auth.deviceId, { endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
        return c.json({ ok: true });
      },
    );
    // Berhenti menerima notifikasi di HP ini. Aman dipanggil berulang.
    app.delete("/api/push/subscription", async (c) => {
      const auth = await authenticate(c);
      if (auth instanceof Response) return auth;
      await push.store.removeAll(auth.deviceId);
      return c.json({ ok: true });
    });
  }

  // Antrean izin yang menunggu untuk SEMUA laptop yang dipasangkan dengan HP ini. Dihitung dari riwayat event.
  app.get("/api/approvals", async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const now = new Date(options.now ? options.now() : Date.now());
    const since = new Date(now.getTime() - APPROVAL_LOOKBACK_MS);
    const machines = await directory.machinesOf(auth.deviceId);
    const lists = await Promise.all(
      machines.map(async (machine) =>
        computePendingApprovals(await store.listRecentByType(machine.id, ["approval.requested", "approval.resolved", "approval.auto_resolved"], since), now),
      ),
    );
    const approvals: PendingApproval[] = lists.flat();
    return c.json(ApprovalsResponseSchema.parse({ approvals }));
  });

  app.get("/api/machines/:machineId/sessions", async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const machineId = c.req.param("machineId");
    const denied = await machineGuard(c, auth.deviceId, machineId);
    if (denied) return denied;
    const sessions: SessionSummary[] = await store.listSessions(machineId, { limit: intParam(c.req.query("limit"), 50, 1, MAX_PAGE_SIZE) });
    return c.json({ sessions });
  });

  app.get("/api/machines/:machineId/sessions/:sessionId/events", async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const machineId = c.req.param("machineId");
    const sessionId = c.req.param("sessionId");
    const denied = await machineGuard(c, auth.deviceId, machineId);
    if (denied) return denied;
    if (sessionId.length > MAX_ID_LENGTH) return c.json({ error: "not-found" }, 404);

    const limit = intParam(c.req.query("limit"), DEFAULT_EVENTS_LIMIT, 1, MAX_PAGE_SIZE);
    const afterSeq = intParam(c.req.query("afterSeq"), -1, -1, 2_000_000_000);
    const events = await store.listEvents({ machineId, sessionId, afterSeq, limit });
    // Halaman penuh berarti mungkin masih ada lanjutannya; halaman yang tidak penuh berarti sudah habis.
    return c.json(EventsResponseSchema.parse({ events, hasMore: events.length >= limit }));
  });
}
