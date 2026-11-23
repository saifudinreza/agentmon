// =====================================================================================
// FILE INI: penyimpanan kunci E2E di laptop = "BRANKAS KUNCI" (issue #033; desain di docs/security-e2e.md bagian 4.1, 4.2, 4.7, 7).
// =====================================================================================
//
// Laptop adalah AKAR KEPERCAYAAN: daftar HP yang dipercaya disimpan di sini, bukan di relay. Berkas `e2e.json` di folder data
// (izin hanya pemilik, ditulis atomik) memuat identitas tanda tangan laptop (Ed25519), pasangan kunci pertukaran (X25519), kunci
// data per `kid`, dan HP yang dipercaya beserta kunci publiknya.
//
// E2E menyala bila ada SATU saja HP yang dipercaya dan belum dicabut. Selama belum ada, perilaku lama berlaku (relay milik sendiri;
// docs bagian 8). Berkas yang rusak TIDAK diganti diam-diam dengan yang baru (itu akan memutus semua HP tanpa kabar): galatnya jelas.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fromB64, generateDataKey, generateKxKeyPair, generateSignKeyPair, toB64, type Sodium } from "@agentmon/shared/crypto";
import { z } from "zod";

const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(256);
const keyPair = z.strictObject({ publicKey: b64, privateKey: b64 });
const trustedDevice = z.strictObject({
  name: z.string().min(1).max(200),
  /** Kunci publik X25519 dan Ed25519 HP, dari pairing yang DIKONFIRMASI di laptop (bukan dari relay). */
  kx: b64,
  sign: b64,
  confirmedAt: z.string().min(1),
  revokedAt: z.string().min(1).optional(),
});

export const StoredE2eSchema = z.strictObject({
  v: z.literal(1),
  sign: keyPair,
  kx: keyPair,
  /** Kunci data yang sedang dipakai mengenkripsi event baru. */
  kid: z.int().min(1),
  /** Semua kunci data yang pernah dibuat (kid -> kunci). Yang lama tetap disimpan agar riwayat sendiri bisa dibaca. */
  dataKeys: z.record(z.string().regex(/^[1-9][0-9]*$/), b64),
  devices: z.record(z.string().min(1).max(200), trustedDevice),
});
export type StoredE2e = z.infer<typeof StoredE2eSchema>;
export type TrustedDevice = z.infer<typeof trustedDevice>;

export const E2E_FILE = "e2e.json";
const fileOf = (home: string) => join(home, E2E_FILE);

export class E2eStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2eStoreError";
  }
}

/** Membaca penyimpanan. `undefined` bila belum ada. Berkas yang rusak melempar `E2eStoreError` (tidak pernah diganti diam-diam). */
export function loadE2e(home: string): StoredE2e | undefined {
  const file = fileOf(home);
  if (!existsSync(file)) return undefined;
  let parsed: z.ZodSafeParseResult<StoredE2e>;
  try {
    parsed = StoredE2eSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new E2eStoreError(`Berkas kunci E2E rusak: ${file}. Jangan dihapus begitu saja (semua HP harus dipasangkan ulang); pulihkan dari cadangan bila ada.`);
  }
  if (!parsed.success) throw new E2eStoreError(`Berkas kunci E2E tidak dikenali: ${file}. Jangan dihapus begitu saja (semua HP harus dipasangkan ulang).`);
  if (parsed.data.dataKeys[String(parsed.data.kid)] === undefined) throw new E2eStoreError(`Berkas kunci E2E tidak lengkap (kunci data ${parsed.data.kid} hilang): ${file}.`);
  return parsed.data;
}

/** Menulis atomik dengan izin hanya pemilik: ke berkas sementara (nama acak) lalu diganti, jadi tidak pernah setengah tertulis. */
export function saveE2e(home: string, state: StoredE2e): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = fileOf(home);
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(StoredE2eSchema.parse(state), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      chmodSync(temp, 0o600); // izin dari mode awal diabaikan di sebagian sistem berkas; di Windows tidak berpengaruh
    } catch {
      /* tidak didukung */
    }
    // Di Windows rename bisa gagal sesaat (EPERM/EBUSY) bila antivirus atau pengindeks memegang berkas tujuan: dicoba ulang beberapa kali.
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
        sleepSync(40 * (attempt + 1));
      }
    }
    throw lastError;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Menghapus berkas sementara kunci yang tertinggal (proses mati di antara tulis dan ganti). Dipanggil saat memuat. */
function removeStaleTemps(home: string): void {
  try {
    for (const name of readdirSync(home)) {
      if (name.startsWith(`${E2E_FILE}.`) && name.endsWith(".tmp")) {
        const file = join(home, name);
        if (Date.now() - statSync(file).mtimeMs > 60_000) unlinkSync(file);
      }
    }
  } catch {
    /* folder belum ada atau tidak bisa dibaca: tidak penting */
  }
}

// ---- Kunci antarproses ----
const LOCK_FILE = `${E2E_FILE}.lock`;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Menjalankan `fn` dengan kunci berkas: dua proses (`pair` bersamaan, daemon) tidak boleh saling menimpa pembaruan `e2e.json`. Kunci basi
 * (proses mati) dilepas setelah 30 detik. Gagal mendapat kunci dalam 10 detik melempar galat yang jelas.
 */
export async function withE2eLock<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, LOCK_FILE);
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid} ${Date.now()}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        /* dilepas pemiliknya di antara dua pemeriksaan */
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new E2eStoreError("Berkas kunci E2E sedang dipakai proses lain. Coba lagi sebentar.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* sudah hilang */
    }
  }
}

/**
 * Baca-ubah-tulis DI DALAM kunci: memuat ulang dari disk (bukan dari ingatan proses), menerapkan `mutate`, lalu menyimpan. Identitas dibuat
 * di dalam kunci yang sama, jadi dua proses pertama tidak membuat dua identitas.
 */
export async function updateE2e(s: Sodium, home: string, mutate: (state: StoredE2e) => StoredE2e): Promise<StoredE2e> {
  return withE2eLock(home, () => {
    removeStaleTemps(home);
    const next = mutate(loadOrCreateE2e(s, home));
    saveE2e(home, next);
    return next;
  });
}

/** Menandai HP sebagai dicabut di berkas kunci (tidak lagi dipercaya). Tidak melakukan apa-apa bila tidak ada berkas atau HP-nya. */
export async function markDeviceRevoked(home: string, deviceId: string, now: Date = new Date()): Promise<boolean> {
  if (!existsSync(fileOf(home))) return false; // tidak ada berkas kunci: tidak membuat folder atau kunci apa pun
  return withE2eLock(home, () => {
    const state = loadE2e(home);
    const device = state?.devices[deviceId];
    if (!state || !device || device.revokedAt !== undefined) return false;
    saveE2e(home, { ...state, devices: { ...state.devices, [deviceId]: { ...device, revokedAt: now.toISOString() } } });
    return true;
  });
}

/** Membuat identitas dan kunci data pertama bila belum ada, atau memuat yang ada. */
export function loadOrCreateE2e(s: Sodium, home: string): StoredE2e {
  const existing = loadE2e(home);
  if (existing) return existing;
  const sign = generateSignKeyPair(s);
  const kx = generateKxKeyPair(s);
  const state: StoredE2e = {
    v: 1,
    sign: { publicKey: toB64(s, sign.publicKey), privateKey: toB64(s, sign.privateKey) },
    kx: { publicKey: toB64(s, kx.publicKey), privateKey: toB64(s, kx.privateKey) },
    kid: 1,
    dataKeys: { "1": toB64(s, generateDataKey(s)) },
    devices: {},
  };
  saveE2e(home, state);
  return state;
}

/** HP yang dipercaya dan belum dicabut. */
export function trustedDevices(state: StoredE2e): Array<[string, TrustedDevice]> {
  return Object.entries(state.devices).filter(([, device]) => device.revokedAt === undefined);
}

/** E2E menyala bila ada satu saja HP yang dipercaya. */
export function e2eActive(home: string): boolean {
  const state = loadE2e(home);
  return state !== undefined && trustedDevices(state).length > 0;
}

/** Mencatat HP yang baru dikonfirmasi pengguna. Memasangkan ulang HP yang sama menimpa kuncinya dan menghapus tanda cabut. */
export function trustDevice(state: StoredE2e, deviceId: string, device: { name: string; kx: string; sign: string }, now: Date): StoredE2e {
  return { ...state, devices: { ...state.devices, [deviceId]: { name: device.name, kx: device.kx, sign: device.sign, confirmedAt: now.toISOString() } } };
}

export function currentDataKey(s: Sodium, state: StoredE2e): Uint8Array {
  return fromB64(s, state.dataKeys[String(state.kid)]!);
}
