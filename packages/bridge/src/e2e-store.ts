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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
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
