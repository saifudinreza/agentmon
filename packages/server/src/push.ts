// =====================================================================================
// FILE INI: pengirim notifikasi Web Push = "KANTOR POS" yang membangunkan HP lewat layanan push browser.
// =====================================================================================
//
// Relay tidak punya jalur langsung ke HP yang terkunci. Yang ada adalah layanan push milik browser (Google untuk
// Chrome, Mozilla untuk Firefox, Apple untuk Safari). Tiap HP mendaftarkan "alamat kotak posnya" (langganan), dan relay
// menitipkan surat ke alamat itu. Surat dienkripsi untuk HP itu saja, dan relay membuktikan identitasnya dengan kunci
// VAPID, jadi tidak ada akun pihak ketiga (Firebase dan sejenisnya) yang perlu dibuat.
//
// YANG DIJAGA DI SINI:
//   - KUNCI VAPID hanya dari variabel lingkungan (hosting gratis tidak punya disk). Pasangannya diperiksa cocok saat
//     mulai, supaya salah salin kunci ketahuan sekarang, bukan saat notifikasi pertama gagal.
//   - ALAMAT LANGGANAN dibatasi ke layanan push yang dikenal. Relay mengirim permintaan HTTP ke alamat yang diberikan
//     HP; tanpa batas, HP yang sudah terpasang bisa menyuruh relay menghubungi alamat internal hosting (SSRF).
//   - ISI PUSH hanya jenis dan nomor (lihat shared/push.ts). Tidak ada kode atau teks dari agent (FR-34).
//   - LOG tidak pernah memuat alamat langganan (alamat itu cukup untuk mengirim notifikasi ke HP), hanya jumlah dan kode.
//   - LANGGANAN MATI (layanan push menjawab 404 atau 410) dihapus otomatis. Kegagalan sementara (jaringan, 429, 5xx)
//     TIDAK menghapus apa pun. Penolakan kunci (401/403) juga tidak menghapus: itu salah kunci relay, bukan HP.
import { createECDH } from "node:crypto";
import { PushPayloadSchema, PushSubscriptionRequestSchema, VAPID_PUBLIC_KEY_PATTERN, type PushPayload, type PushSubscriptionRequest } from "@agentmon/shared";
import webpush from "web-push";
import type { PushStore, StoredSubscription } from "./db/push";
import type { RelayDirectory } from "./directory";
import { silentLogger, type Logger } from "./logger";

// ---- Kunci VAPID -----------------------------------------------------------------------
export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

const VAPID_PRIVATE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 byte, base64url tanpa isian

/**
 * Membaca kunci VAPID dari lingkungan. Tidak diisi sama sekali = push mati (bukan galat). Diisi sebagian atau salah =
 * `problem` berisi alasannya, dan push tetap mati: relay sendiri tetap boleh jalan, jangan sampai salah ketik
 * menjatuhkan seluruh layanan. Nilai kunci tidak pernah dimasukkan ke pesan.
 */
export function parseVapidConfig(env: Record<string, string | undefined>): { config?: VapidConfig; problem?: string } {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  if (!publicKey && !privateKey && !subject) return {};
  if (!publicKey || !privateKey || !subject) return { problem: "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, dan VAPID_SUBJECT harus diisi bersama-sama" };
  if (!VAPID_PUBLIC_KEY_PATTERN.test(publicKey)) return { problem: "VAPID_PUBLIC_KEY bukan kunci publik VAPID yang sah" };
  if (!VAPID_PRIVATE_KEY_PATTERN.test(privateKey)) return { problem: "VAPID_PRIVATE_KEY bukan kunci pribadi VAPID yang sah" };
  // Subjek berupa kontak operator relay yang dilihat layanan push: alamat https atau mailto.
  if (!/^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/.test(subject)) return { problem: "VAPID_SUBJECT harus berupa alamat https:// atau mailto:" };
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (ecdh.getPublicKey().toString("base64url") !== publicKey) return { problem: "VAPID_PUBLIC_KEY tidak cocok dengan VAPID_PRIVATE_KEY" };
  } catch {
    return { problem: "VAPID_PRIVATE_KEY bukan kunci pribadi P-256 yang sah" };
  }
  return { config: { publicKey, privateKey, subject } };
}

/** Membuat pasangan kunci VAPID baru (untuk perintah operator, bukan dipanggil saat relay berjalan). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

// ---- Alamat langganan yang boleh dihubungi ---------------------------------------------
// Akhiran nama host layanan push yang dikenal. Sama persis, atau subdomainnya.
const KNOWN_PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge, Brave, Opera, dan peramban Android lain
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari dan PWA di iOS (web.push.apple.com)
  "notify.windows.com", // layanan notifikasi Windows (sebagian Edge)
];

/**
 * Aturan alamat langganan: HTTPS, tanpa nama pengguna atau sandi, port standar, dan host layanan push yang dikenal.
 * `extraHosts` menambah akhiran host (dari PUSH_ALLOWED_HOSTS) bila ada layanan push sah yang belum ada di daftar.
 */
export function createEndpointPolicy(extraHosts: readonly string[] = []): (endpoint: string) => boolean {
  const hosts = [...KNOWN_PUSH_HOSTS, ...extraHosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== "")];
  return (endpoint) => {
    // PENTING: pustaka web-push menentukan tujuan dengan parser URL LAMA (url.parse), sedangkan `new URL` adalah parser
    // WHATWG, dan keduanya tidak sepakat untuk karakter seperti ; ' { ` " atau "https:host" tanpa garis miring. Memeriksa
    // host lewat satu parser lalu mengirim lewat parser lain membuka SSRF ("https://169.254.169.254;.fcm.googleapis.com/"
    // terbaca host fcm di satu sisi dan 169.254.169.254 di sisi lain). Karena itu bagian host dibaca LANGSUNG dari teksnya
    // dan hanya karakter nama host biasa yang lolos: tidak ada karakter yang bisa ditafsirkan berbeda.
    if (!endpoint.startsWith("https://")) return false;
    // Backslash tidak memotong apa pun di sini, jadi alamat yang memuatnya di bagian host ditolak oleh aturan karakter di bawah.
    const authority = endpoint.slice("https://".length).split(/[/?#]/, 1)[0] ?? "";
    const match = /^([A-Za-z0-9.-]+)(?::443)?$/.exec(authority);
    if (!match) return false; // nama pengguna (@), karakter aneh, port lain, atau kosong
    const host = match[1]!.toLowerCase();
    // Pengaman kedua: parser WHATWG harus membaca host yang sama.
    let parsedHost: string;
    try {
      parsedHost = new URL(endpoint).hostname;
    } catch {
      return false;
    }
    if (parsedHost !== host) return false;
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  };
}

/**
 * Saat push mati (kunci VAPID belum diisi atau salah), langganan yang masih tersimpan tidak boleh dihitung sebagai
 * HP yang "bisa dihubungi": tidak akan ada notifikasi yang dikirim, dan daemon yang mengira ada HP akan menahan aksi
 * menunggu keputusan yang tidak pernah diminta.
 */
export function withPushPresence<D extends RelayDirectory>(directory: D, pushEnabled: boolean): RelayDirectory {
  return pushEnabled ? directory : { ...directory, devicesWithPush: undefined };
}

// Batas waktu TOTAL satu pengiriman. Opsi `timeout` milik web-push hanya batas soket diam: server yang menetes satu
// byte tiap beberapa detik bisa menahan satu pekerja tanpa batas.
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PushSendError("batas waktu pengiriman terlewati")), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Memeriksa langganan dari HP: bentuknya, alamatnya, dan bahwa kunci publiknya benar-benar titik kurva P-256. */
export function validateSubscription(input: unknown, isAllowedEndpoint: (endpoint: string) => boolean): PushSubscriptionRequest | undefined {
  const parsed = PushSubscriptionRequestSchema.safeParse(input);
  if (!parsed.success || !isAllowedEndpoint(parsed.data.endpoint)) return undefined;
  try {
    // Menolak titik yang bukan di kurva. Tanpa ini, kunci rusak tersimpan dan gagal terus di setiap pengiriman.
    // computeSecret butuh kunci sendiri, jadi dibuatkan yang sementara; hasil rahasianya dibuang.
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(Buffer.from(parsed.data.keys.p256dh, "base64url"));
  } catch {
    return undefined;
  }
  return parsed.data;
}

// ---- Pengiriman ------------------------------------------------------------------------
export type PushTransport = (
  subscription: { endpoint: string; p256dh: string; auth: string },
  body: string,
  options: { ttlSeconds: number; urgency: "high" | "normal"; vapid: VapidConfig; timeoutMs: number },
) => Promise<void>;

/** Kegagalan pengiriman. `statusCode` ada bila layanan push menjawab; kosong untuk galat jaringan atau batas waktu. */
export class PushSendError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "PushSendError";
  }
}

/** Pengirim sungguhan lewat pustaka web-push. Pesan galat pustaka tidak diteruskan (bisa memuat alamat langganan). */
export const webPushTransport: PushTransport = async (subscription, body, options) => {
  try {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, body, {
      TTL: options.ttlSeconds,
      urgency: options.urgency,
      timeout: options.timeoutMs,
      vapidDetails: { subject: options.vapid.subject, publicKey: options.vapid.publicKey, privateKey: options.vapid.privateKey },
    });
  } catch (error) {
    // Yang dilempar pustaka bisa apa saja (bahkan null); hanya dua bidang dibaca, dan pesan aslinya tidak diteruskan.
    const detail = (typeof error === "object" && error !== null ? error : {}) as { statusCode?: unknown; code?: unknown };
    const statusCode = typeof detail.statusCode === "number" ? detail.statusCode : undefined;
    const code = typeof detail.code === "string" ? detail.code : "tidak-diketahui";
    throw new PushSendError(statusCode ? `layanan push menjawab ${statusCode}` : `gagal terhubung (${code})`, statusCode);
  }
};

export type PushResult = {
  /** Langganan yang dicoba dikirimi. */
  attempted: number;
  /** Diterima layanan push (belum tentu sudah tampil di HP). */
  delivered: number;
  /** Langganan yang mati dan sudah dihapus. */
  removed: number;
  /** Gagal dan masih disimpan (sementara, atau salah kunci relay). */
  failed: number;
};

export type PushService = {
  /** Notifikasi ke semua HP yang masih dipasangkan dengan laptop ini. */
  notifyMachine(machineId: string, payload: PushPayload): Promise<PushResult>;
  /** Notifikasi ke satu HP. */
  notifyDevice(deviceId: string, payload: PushPayload): Promise<PushResult>;
};

export type PushServiceOptions = {
  store: Pick<PushStore, "forMachine" | "forDevice" | "removeByIds">;
  vapid: VapidConfig;
  isAllowedEndpoint: (endpoint: string) => boolean;
  transport?: PushTransport;
  logger?: Logger;
  /** Berapa pengiriman berjalan bersamaan. */
  concurrency?: number;
  /** Batas soket diam untuk pustaka push. */
  timeoutMs?: number;
  /** Batas waktu TOTAL satu pengiriman, apa pun yang terjadi di jaringan. */
  deadlineMs?: number;
};

// Batas ukuran Web Push 4096 byte setelah dienkripsi; isi yang sah jauh di bawah ini.
const MAX_BODY_BYTES = 2048;
// Permintaan izin kedaluwarsa dalam hitungan menit, jadi notifikasi yang tertunda lebih lama tidak berguna dan membingungkan.
const TTL_SECONDS = { approval: 600, done: 3600, test: 120 } as const;

export function createPushService(options: PushServiceOptions): PushService {
  const transport = options.transport ?? webPushTransport;
  const logger = options.logger ?? silentLogger;
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadlineMs = options.deadlineMs ?? 20_000;

  async function deliver(subscriptions: StoredSubscription[], payload: PushPayload): Promise<PushResult> {
    // Isi yang tidak sah adalah kesalahan pemanggil, bukan kegagalan jaringan: lempar, jangan diam.
    const checked = PushPayloadSchema.parse(payload);
    const body = JSON.stringify(checked);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new RangeError("isi push terlalu besar");

    const result: PushResult = { attempted: 0, delivered: 0, removed: 0, failed: 0 };
    const dead: string[] = [];
    let keyRejected = false;
    // Hitungan jawaban bukan-sukses per kode (untuk operator: 400 terus-menerus berarti ada yang salah di sisi kita).
    const outcomes = new Map<string, number>();
    const tally = (key: string) => outcomes.set(key, (outcomes.get(key) ?? 0) + 1);

    // Baris lama yang alamatnya tidak lolos aturan sekarang tidak pernah dihubungi; dihapus saja.
    const sendable = subscriptions.filter((s) => {
      if (options.isAllowedEndpoint(s.endpoint)) return true;
      dead.push(s.id);
      return false;
    });

    const queue = [...sendable];
    const worker = async () => {
      for (let sub = queue.shift(); sub; sub = queue.shift()) {
        result.attempted += 1;
        try {
          await withDeadline(
            transport(sub, body, { ttlSeconds: TTL_SECONDS[checked.kind], urgency: checked.kind === "approval" ? "high" : "normal", vapid: options.vapid, timeoutMs }),
            deadlineMs,
          );
          result.delivered += 1;
        } catch (error) {
          const status = error instanceof PushSendError ? error.statusCode : undefined;
          tally(status === undefined ? "jaringan" : String(status));
          if (status === 404 || status === 410) dead.push(sub.id);
          else {
            result.failed += 1;
            if (status === 401 || status === 403) keyRejected = true;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

    if (dead.length > 0) {
      try {
        await options.store.removeByIds(dead);
        result.removed = dead.length;
      } catch {
        logger.error(`push: gagal menghapus ${dead.length} langganan mati`);
      }
    }
    // Dicatat sekali per pengiriman, hanya angka. Penolakan kunci dicatat tegas: itu salah konfigurasi relay.
    if (keyRejected) {
      logger.error(
        "push: layanan push menolak relay (401/403). Periksa VAPID_PUBLIC_KEY dan VAPID_PRIVATE_KEY; bila kunci baru saja diganti, HP harus berlangganan ulang karena langganan lama terikat ke kunci lama",
      );
    }
    if (result.attempted > 0 || result.removed > 0) {
      const codes = [...outcomes].map(([code, count]) => `${code}x${count}`).join(" ");
      logger.info(`push: ${result.delivered}/${result.attempted} terkirim, ${result.failed} gagal, ${result.removed} langganan mati dihapus${codes ? ` (jawaban: ${codes})` : ""}`);
    }
    return result;
  }

  return {
    notifyMachine: async (machineId, payload) => deliver(await options.store.forMachine(machineId), payload),
    notifyDevice: async (deviceId, payload) => deliver(await options.store.forDevice(deviceId), payload),
  };
}
