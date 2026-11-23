// =====================================================================================
// FILE INI: pintu HTTP untuk pairing = "LOKET" yang menghadap laptop dan HP.
// =====================================================================================
//
//   POST /pair/code     laptop (token laptop) minta kode sekali pakai.
//   GET  /pair/devices  laptop (token laptop) melihat HP yang terpasang, untuk memberi tahu
//                       pemiliknya saat ada perangkat baru.
//   POST /pair/redeem   HP menukar kode menjadi kredensial. Tanpa token: kodenya sendiri yang
//                       menjadi bukti. Bila HP sudah punya kredensial (memasangkan laptop kedua),
//                       ia mengirim tokennya di header Authorization supaya tidak dibuatkan
//                       perangkat baru.
//
// Logika sebenarnya ada di db/pairing.ts. File ini hanya: memeriksa siapa penelepon, membatasi
// laju, memeriksa bentuk masukan, dan menerjemahkan hasil ke kode status HTTP.
//
// KEAMANAN:
//   - Penukaran dibatasi lajunya per alamat IP dan juga secara keseluruhan. Kodenya sendiri 192 bit
//     sehingga tidak bisa ditebak; pembatasan ini menjaga relay dari dibanjiri, dan dari orang
//     yang mencoba kode curian.
//   - Semua kegagalan kode (tidak dikenal, terpakai, kedaluwarsa) dijawab SAMA persis.
//   - Isi permintaan dibatasi 4 KiB.
//   - CORS hanya untuk asal (origin) yang diizinkan, karena PWA biasanya dihosting di alamat
//     berbeda dari relay. Tanpa daftar, tidak ada asal lain yang diizinkan.
import { PairRedeemRequestSchema, PostE2eMessageSchema, type PairCodeResponse, type PairedDevicesResponse, type PairRedeemResponse } from "@agentmon/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { PairingService } from "./db/pairing";
import type { RelayDirectory } from "./directory";
import { clientAddress } from "./client-ip";
import { createKeyedRateLimiter, createRateLimiter } from "./rate-limit";

export type PairingRoutesOptions = {
  pairing: PairingService;
  /** Dipakai untuk memeriksa token laptop (dan token HP lama). */
  directory: RelayDirectory;
  /** Asal PWA yang boleh memanggil /pair/redeem dari browser, misalnya ["https://app.contoh.com"]. */
  allowedOrigins?: string[];
  /**
   * Relay berada di belakang proxy (hosting): alamat IP penelepon dibaca dari header
   * X-Forwarded-For yang ditambahkan proxy tepercaya. Jangan nyalakan bila relay terbuka langsung
   * ke internet, karena klien bisa memalsukan header itu.
   */
  trustProxy?: boolean;
  /** Dipanggil setelah sebuah perangkat dicabut, untuk memutus koneksinya seketika. */
  onDeviceRevoked?: (deviceId: string) => void;
  /** Dipanggil setelah sebuah laptop mencabut dirinya dari relay, untuk memutus sambungannya seketika. */
  onMachineRemoved?: (machineId: string) => void;
  /** Batas laju; bawaannya diatur untuk pemakaian manusia dan bisa diganti test. */
  limits?: Partial<PairingLimits>;
  now?: () => number;
};

export type PairingLimits = {
  redeemBurstPerIp: number; // percobaan beruntun yang boleh dari satu IP
  redeemRefillPerSecondPerIp: number;
  redeemBurstGlobal: number; // semua IP digabung
  redeemRefillPerSecondGlobal: number;
  codeBurstPerMachine: number;
  codeRefillPerSecondPerMachine: number;
};

export const DEFAULT_PAIRING_LIMITS: PairingLimits = {
  redeemBurstPerIp: 10,
  redeemRefillPerSecondPerIp: 0.1, // 1 percobaan per 10 detik setelah lonjakan awal
  redeemBurstGlobal: 100,
  redeemRefillPerSecondGlobal: 10,
  codeBurstPerMachine: 5,
  codeRefillPerSecondPerMachine: 1 / 12,
};

const MAX_BODY_BYTES = 4096;
// Pesan E2E laptop ke HP (tantangan, jawaban pairing, kunci): kecil, tetapi cukup longgar untuk kunci terbungkus.
const MAX_E2E_MESSAGE_BYTES = 16 * 1024;

function bearer(c: Context): string | undefined {
  const header = c.req.header("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}

export function mountPairingRoutes(app: Hono, options: PairingRoutesOptions): void {
  const { pairing, directory } = options;
  const limits: PairingLimits = { ...DEFAULT_PAIRING_LIMITS, ...options.limits };
  const clock = options.now ? { now: options.now } : {};

  const perIp = createKeyedRateLimiter({ capacity: limits.redeemBurstPerIp, refillPerSecond: limits.redeemRefillPerSecondPerIp, ...clock });
  const global = createRateLimiter({ capacity: limits.redeemBurstGlobal, refillPerSecond: limits.redeemRefillPerSecondGlobal, ...clock });
  const perMachine = createKeyedRateLimiter({
    capacity: limits.codeBurstPerMachine,
    refillPerSecond: limits.codeRefillPerSecondPerMachine,
    ...clock,
  });

  // Pesan E2E ke HP: beberapa per pairing, jadi lebih longgar dari permintaan kode, tetapi tetap dibatasi.
  const e2eMessages = createKeyedRateLimiter({ capacity: 30, refillPerSecond: 1, ...clock });

  const clientKey = (c: Context): string => clientAddress(c, options.trustProxy);

  // Laptop: token wajib. Mengembalikan nomor laptop, atau undefined bila ditolak.
  const machineOf = async (c: Context): Promise<string | undefined> => {
    const token = bearer(c);
    if (!token) return undefined;
    return directory.authenticate("machine", token);
  };

  app.post("/pair/code", async (c) => {
    const machineId = await machineOf(c);
    if (!machineId) return c.json({ error: "unauthorized" }, 401);
    if (!perMachine.take(machineId)) return c.json({ error: "rate-limited" }, 429);

    const result = await pairing.createCode(machineId);
    if (!result.ok) {
      return result.reason === "too-many-codes" ? c.json({ error: "too-many-codes" }, 429) : c.json({ error: "unauthorized" }, 401);
    }
    const body: PairCodeResponse = { code: result.code, expiresAt: result.expiresAt.toISOString() };
    return c.json(body, 201);
  });

  app.get("/pair/devices", async (c) => {
    const machineId = await machineOf(c);
    if (!machineId) return c.json({ error: "unauthorized" }, 401);
    const body: PairedDevicesResponse = { devices: await pairing.listDevices(machineId) };
    return c.json(body);
  });

  // Laptop menitipkan pesan untuk SATU HP-nya (tantangan sidik jari, jawaban pairing, kunci baru). Relay tidak membaca isinya: yang menjaga
  // keaslian adalah tanda tangan laptop yang diperiksa HP. HP yang bukan milik laptop ini, atau sudah dicabut, dijawab 404 yang sama.
  app.post(
    "/pair/e2e/messages",
    bodyLimit({ maxSize: MAX_E2E_MESSAGE_BYTES, onError: (c) => c.json({ error: "too-large" }, 413) }),
    async (c) => {
      const machineId = await machineOf(c);
      if (!machineId) return c.json({ error: "unauthorized" }, 401);
      if (!e2eMessages.take(machineId)) return c.json({ error: "rate-limited" }, 429);
      const parsed = PostE2eMessageSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: "bad-request" }, 400);
      if (!(await pairing.postE2eMessage(machineId, parsed.data.deviceId, parsed.data.kind, JSON.stringify(parsed.data.body)))) return c.json({ error: "not-found" }, 404);
      return c.json({ ok: true }, 201);
    },
  );

  // Laptop mencabut sebuah HP (HP hilang). Hanya HP yang dipasangkan dengan laptop ini; selain itu 404 yang sama.
  app.delete("/pair/devices/:deviceId", async (c) => {
    const machineId = await machineOf(c);
    if (!machineId) return c.json({ error: "unauthorized" }, 401);
    if (!perMachine.take(machineId)) return c.json({ error: "rate-limited" }, 429);
    const deviceId = c.req.param("deviceId");
    if (deviceId.length > 200 || !(await pairing.revokeDevice({ machineId }, deviceId))) return c.json({ error: "not-found" }, 404);
    options.onDeviceRevoked?.(deviceId);
    return c.json({ ok: true });
  });

  // Laptop mencabut DIRINYA SENDIRI dari relay (perintah `uninstall`). Hanya laptop pemegang tokennya yang bisa, dan hanya dirinya:
  // tidak ada nomor di jalur permintaan, jadi tidak ada jalan menghapus laptop lain. Token langsung tidak berlaku; permintaan kedua
  // dijawab 401 seperti token yang salah. Datanya (pasangan HP, sesi, riwayat event) ikut terhapus oleh basis data.
  app.delete("/machine", async (c) => {
    const machineId = await machineOf(c);
    if (!machineId) return c.json({ error: "unauthorized" }, 401);
    if (!perMachine.take(machineId)) return c.json({ error: "rate-limited" }, 429);
    if (!(await pairing.forgetMachine(machineId))) return c.json({ error: "unauthorized" }, 401);
    options.onMachineRemoved?.(machineId);
    return c.json({ ok: true });
  });

  const allowed = new Set(options.allowedOrigins ?? []);
  app.use(
    "/pair/redeem",
    cors({
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      maxAge: 600,
    }),
  );
  app.post(
    "/pair/redeem",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "too-large" }, 413) }),
    async (c) => {
      // Laju diperiksa SEBELUM pekerjaan apa pun, termasuk membaca isi permintaan.
      if (!global.take() || !perIp.take(clientKey(c))) return c.json({ error: "rate-limited" }, 429);

      const parsed = PairRedeemRequestSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: "bad-request" }, 400);

      const existingDeviceToken = bearer(c);
      const result = await pairing.redeem({
        code: parsed.data.code,
        name: parsed.data.name,
        ...(existingDeviceToken !== undefined ? { existingDeviceToken } : {}),
        ...(parsed.data.e2e !== undefined ? { e2e: parsed.data.e2e } : {}),
      });
      if (!result.ok) {
        return result.reason === "invalid-device" ? c.json({ error: "unauthorized" }, 401) : c.json({ error: "invalid-code" }, 400);
      }
      const body: PairRedeemResponse = {
        deviceId: result.deviceId,
        machineId: result.machineId,
        machineName: result.machineName,
        ...(result.deviceToken !== undefined ? { deviceToken: result.deviceToken } : {}),
      };
      return c.json(body);
    },
  );
}
