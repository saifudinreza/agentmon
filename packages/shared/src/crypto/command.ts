// =====================================================================================
// FILE INI: perintah HP ke laptop dan balasan laptop = AMPLOP TERTUTUP + TANDA TANGAN (docs/security-e2e.md 4.5).
// =====================================================================================
//
// Dua lapis, untuk SETIAP perintah (keputusan, rollback, pencabutan, ...) dan balasannya:
//   1. AEAD dengan kunci pasangan arah itu (kerahasiaan, terikat ke mesin dan perangkat lewat AAD).
//   2. Tanda tangan Ed25519 pengirim atas SELURUH plaintext (terikat ke mesin dan perangkat), jadi tiap kolom di dalamnya, termasuk
//      `H` = hash SELURUH payload izin yang dilihat HP (bukan hanya toolInput), nomor event, dan nomor perintah, ikut ditandatangani
//      tanpa perlu pengodean kolom per jenis perintah. Relay tidak bisa menyodorkan diff atau risiko palsu dengan perintah yang sama.
//
// Urutan di penerima (docs 4.5): buka AEAD, parse, ambil kunci publik pengirim dari catatan SENDIRI (bukan dari relay), verifikasi tanda
// tangan, baru periksa isinya (nomor izin, `H`, kedaluwarsa, anti-replay). Pemeriksaan isi dan penyimpanan anti-replay ada di
// pemanggil (daemon dan PWA); di sini hanya primitifnya.
import { aeadOpen, aeadSeal } from "./event";
import { canon, CryptoError, fromB64, toB64 } from "./encoding";
import type { Sodium } from "./sodium";

export const COMMAND_LABEL = "agentmon/cmd/v1";
export const REPLY_LABEL = "agentmon/reply/v1";

/** H = hash 32 byte atas SELURUH plaintext payload `approval.requested` persis seperti yang laptop kirim. */
export function approvalHash(s: Sodium, plaintext: Uint8Array): Uint8Array {
  return s.crypto_generichash(32, plaintext, null);
}

/** Perintah dari HP, atau balasan dari laptop. Arah menentukan label (dan kunci yang dipakai pemanggil). */
export type Direction = "command" | "reply";
export type BoxContext = { direction: Direction; machineId: string; deviceId: string };
/** Bentuk yang dikirim lewat relay. Semua byte dalam base64 aman-URL. */
export type SignedBox = { n: string; c: string; s: string };

const labelOf = (direction: Direction): string => {
  if (direction === "command") return COMMAND_LABEL;
  if (direction === "reply") return REPLY_LABEL;
  throw new CryptoError();
};
const aadOf = (context: BoxContext): Uint8Array => canon(labelOf(context.direction), [context.machineId, context.deviceId]);
const signatureInput = (context: BoxContext, plaintext: Uint8Array): Uint8Array => canon(`${labelOf(context.direction)}/sig`, [context.machineId, context.deviceId, plaintext]);

/** Menutup lalu menandatangani. `key` = kunci pasangan arah itu; `signPrivateKey` = kunci tanda tangan PENGIRIM. */
export function sealSigned(s: Sodium, key: Uint8Array, signPrivateKey: Uint8Array, context: BoxContext, plaintext: Uint8Array): SignedBox {
  const { n, c } = aeadSeal(s, key, aadOf(context), plaintext);
  const signature = s.crypto_sign_detached(signatureInput(context, plaintext), signPrivateKey);
  return { n: toB64(s, n), c: toB64(s, c), s: toB64(s, signature) };
}

/**
 * Membuka dan memverifikasi. `signPublicKey` HARUS berasal dari catatan penerima sendiri (HP dari berkas laptop, laptop dari pairing),
 * bukan dari relay. Semua kegagalan (bentuk, kunci, AAD, data diubah, tanda tangan) menjadi `CryptoError` yang sama.
 */
export function openSigned(s: Sodium, key: Uint8Array, signPublicKey: Uint8Array, context: BoxContext, box: unknown): Uint8Array {
  if (typeof box !== "object" || box === null) throw new CryptoError();
  const { n, c, s: signature } = box as Record<string, unknown>;
  if (typeof n !== "string" || typeof c !== "string" || typeof signature !== "string") throw new CryptoError();
  const plaintext = aeadOpen(s, key, aadOf(context), fromB64(s, n), fromB64(s, c));
  let valid: boolean;
  try {
    valid = s.crypto_sign_verify_detached(fromB64(s, signature), signatureInput(context, plaintext), signPublicKey);
  } catch {
    valid = false;
  }
  if (!valid) throw new CryptoError();
  return plaintext;
}
