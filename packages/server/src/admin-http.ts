// =====================================================================================
// FILE INI: pendaftaran laptop lewat HTTP = "LOKET ANGGOTA BARU" yang hanya dibuka bagi pemegang rahasia admin.
// =====================================================================================
//
//   POST /admin/machines   { id, name, rotate? }  ->  201 { machineId, token }
//
// Relay yang baru di-deploy tidak punya satu pun laptop. Tanpa jalan masuk ini, satu-satunya cara membuat baris dan
// token laptop adalah memanggil fungsi internal lewat kode.
//
// KEAMANAN:
//   - Loket ini HANYA ada bila relay diberi ADMIN_SECRET (minimal 32 karakter). Tanpa itu, /admin/* tidak ada (404).
//   - Rahasia dibandingkan dengan waktu tetap (lewat hash), supaya tidak bisa ditebak dari selisih waktu jawaban.
//   - Percobaan dengan rahasia salah dibatasi lajunya per alamat IP DAN secara keseluruhan; yang sudah kehabisan
//     jatah ditolak (429) SEBELUM rahasianya diperiksa, jadi penebak tidak bisa terus mencoba.
//   - Pendaftaran yang berhasil juga dibatasi lajunya, supaya rahasia yang bocor tidak bisa dipakai membanjiri tabel.
//   - Token dibuat DI RELAY (acak 256 bit), hanya hash-nya yang disimpan, dan token dikembalikan SEKALI. Tidak
//     pernah masuk log, dan jawabannya tidak boleh disimpan cache.
//   - Tidak ada CORS: loket ini bukan untuk browser.
//   - Nomor yang sudah terdaftar ditolak (409) kecuali diminta mengganti token (`rotate`), supaya pendaftaran ganda
//     tidak diam-diam memutus laptop yang sedang berjalan. Mengganti token memutus sambungan lama seketika.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MachineRegisterRequestSchema, type MachineRegisterResponse } from "@agentmon/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { clientAddress } from "./client-ip";
import type { MachineRegistry } from "./db/machines";
import { silentLogger, type Logger } from "./logger";
import { createKeyedRateLimiter } from "./rate-limit";

export const MIN_ADMIN_SECRET_LENGTH = 32;

/**
 * Membaca ADMIN_SECRET dari lingkungan. Kosong = loket tidak dibuka (bukan galat). Terlalu pendek = tidak dibuka
 * dan `problem` menjelaskan alasannya: rahasia lemah lebih berbahaya daripada loket yang tertutup. Nilainya
 * tidak pernah dimasukkan ke pesan.
 */
export function parseAdminSecret(env: Record<string, string | undefined>): { secret?: string; problem?: string } {
  const raw = env.ADMIN_SECRET;
  if (raw === undefined || raw === "") return {};
  const secret = raw.trim();
  if (secret.length < MIN_ADMIN_SECRET_LENGTH) {
    return { problem: `ADMIN_SECRET terlalu pendek (minimal ${MIN_ADMIN_SECRET_LENGTH} karakter); pendaftaran laptop TIDAK dibuka` };
  }
  return { secret };
}

export type AdminLimits = {
  /** Percobaan rahasia salah per alamat IP. */
  failureBurstPerIp: number;
  failureRefillPerSecondPerIp: number;
  /** Percobaan rahasia salah dari semua alamat sekaligus (penebak yang berganti alamat). */
  failureBurstGlobal: number;
  failureRefillPerSecondGlobal: number;
  /** Pendaftaran yang berhasil, secara keseluruhan. */
  successBurst: number;
  successRefillPerSecond: number;
};

export const DEFAULT_ADMIN_LIMITS: AdminLimits = {
  failureBurstPerIp: 5,
  failureRefillPerSecondPerIp: 1 / 60, // 1 percobaan per menit setelah lonjakan awal
  failureBurstGlobal: 30,
  failureRefillPerSecondGlobal: 1 / 30,
  successBurst: 10,
  successRefillPerSecond: 1 / 60,
};

export type AdminRoutesOptions = {
  secret: string;
  registry: MachineRegistry;
  /** Dipanggil setelah token sebuah laptop diganti, untuk memutus sambungan lamanya seketika. */
  onMachineRotated?: (machineId: string) => void;
  logger?: Logger;
  /** Relay di belakang proxy hosting: alamat IP dibaca dari X-Forwarded-For (lihat client-ip.ts). */
  trustProxy?: boolean;
  limits?: Partial<AdminLimits>;
  now?: () => number;
  /** Hanya untuk test: pembuat token. Bawaannya 32 byte acak sebagai heksadesimal. */
  newToken?: () => string;
};

const MAX_BODY_BYTES = 2048;
const GLOBAL_KEY = "global";

const digest = (value: string) => createHash("sha256").update(value).digest();

function bearer(c: Context): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  return match?.[1];
}

export function mountAdminRoutes(app: Hono, options: AdminRoutesOptions): void {
  const logger = options.logger ?? silentLogger;
  const limits: AdminLimits = { ...DEFAULT_ADMIN_LIMITS, ...options.limits };
  const clock = options.now ? { now: options.now } : {};
  const secretDigest = digest(options.secret);
  const newToken = options.newToken ?? (() => randomBytes(32).toString("hex"));

  const failuresPerIp = createKeyedRateLimiter({ capacity: limits.failureBurstPerIp, refillPerSecond: limits.failureRefillPerSecondPerIp, ...clock });
  const failuresGlobal = createKeyedRateLimiter({ capacity: limits.failureBurstGlobal, refillPerSecond: limits.failureRefillPerSecondGlobal, ...clock });
  const successes = createKeyedRateLimiter({ capacity: limits.successBurst, refillPerSecond: limits.successRefillPerSecond, ...clock });

  // Jawaban yang membawa token tidak boleh disimpan cache perantara.
  const json = (c: Context, body: unknown, status: 200 | 201 | 400 | 401 | 404 | 409 | 413 | 429) => {
    c.header("cache-control", "no-store");
    return c.json(body, status);
  };

  app.post(
    "/admin/machines",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => json(c, { error: "too-large" }, 413) }),
    async (c) => {
      const address = clientAddress(c, options.trustProxy);
      // Jatah kegagalan habis: ditolak SEBELUM rahasia diperiksa, supaya penebak tidak tahu apakah tebakannya benar.
      if (!failuresPerIp.canTake(address) || !failuresGlobal.canTake(GLOBAL_KEY)) return json(c, { error: "rate-limited" }, 429);

      const given = bearer(c);
      // Hash 32 byte di kedua sisi: panjang sama, jadi timingSafeEqual aman dan tidak membocorkan panjang rahasia.
      if (!given || !timingSafeEqual(digest(given), secretDigest)) {
        failuresPerIp.take(address);
        failuresGlobal.take(GLOBAL_KEY);
        logger.error("pendaftaran laptop ditolak: rahasia admin salah atau tidak ada");
        return json(c, { error: "unauthorized" }, 401);
      }

      if (!successes.canTake(GLOBAL_KEY)) return json(c, { error: "rate-limited" }, 429);

      const parsed = MachineRegisterRequestSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return json(c, { error: "bad-request" }, 400);
      const { id, name, rotate } = parsed.data;

      const token = newToken();
      if (rotate) {
        if ((await options.registry.rotate({ id, name, token })) === "missing") return json(c, { error: "not-found" }, 404);
        options.onMachineRotated?.(id);
      } else if ((await options.registry.register({ id, name, token })) === "exists") {
        return json(c, { error: "already-registered" }, 409);
      }

      successes.take(GLOBAL_KEY);
      // Hanya nomor (bukan rahasia) yang dicatat; tidak pernah token atau rahasia admin.
      logger.info(`laptop ${rotate ? "diganti tokennya" : "terdaftar"}: ${id}`);
      return json(c, { machineId: id, token } satisfies MachineRegisterResponse, 201);
    },
  );
}
