// =====================================================================================
// FILE INI: kunci, AEAD, dan amplop event terenkripsi + bertanda tangan (docs/security-e2e.md bagian 4.1 dan 4.3).
// =====================================================================================
//
// Payload event dienkripsi dengan kunci data bersama (XChaCha20-Poly1305), lalu LAPTOP menandatangani seluruhnya (Ed25519):
// kunci data dipegang banyak pihak sehingga tidak membuktikan pengirim, tanda tanganlah yang membuktikan event ini dari laptop
// dan terikat ke amplopnya (id, sesi, seq, waktu, jenis, ...). Penerima MEMVERIFIKASI DULU, baru mendekripsi.
import { z } from "zod";
import { bytesEqual, canon, CryptoError, concat, fromB64, toB64, type Field } from "./encoding";
import type { Sodium } from "./sodium";

export const EVENT_LABEL = "agentmon/event/v1";
/** Payload di-padding ke kelipatan ini sebelum dienkripsi (menyembunyikan panjang perintah pendek dari relay). */
export const PAD_BLOCK = 256;
export const PAYLOAD_VERSION = 1;

// ---- Kunci ----
export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

/** Identitas tanda tangan (Ed25519): laptop dan HP masing-masing punya satu. */
export function generateSignKeyPair(s: Sodium): KeyPair {
  const { publicKey, privateKey } = s.crypto_sign_keypair();
  return { publicKey, privateKey };
}

/** Pertukaran kunci (X25519) untuk kunci pasangan laptop dan HP. */
export function generateKxKeyPair(s: Sodium): KeyPair {
  const { publicKey, privateKey } = s.crypto_kx_keypair();
  return { publicKey, privateKey };
}

/** Kunci data (32 byte) untuk mengenkripsi payload event, satu per laptop per `kid`. */
export function generateDataKey(s: Sodium): Uint8Array {
  return s.crypto_aead_xchacha20poly1305_ietf_keygen();
}

// ---- AEAD ----
/** Enkripsi dengan nonce acak 24 byte BARU tiap pemanggilan (XChaCha: acak aman dipakai). Plaintext di-padding bila `padTo` diisi. */
export function aeadSeal(s: Sodium, key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, padTo?: number): { n: Uint8Array; c: Uint8Array } {
  if (key.length !== s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) throw new CryptoError();
  const n = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const message = padTo ? s.pad(plaintext, padTo) : plaintext;
  const c = s.crypto_aead_xchacha20poly1305_ietf_encrypt(message, aad, null, n, key);
  return { n, c };
}

/** Membuka AEAD. Semua kegagalan (kunci, nonce, AAD, data diubah, padding rusak) menjadi `CryptoError` yang sama. */
export function aeadOpen(s: Sodium, key: Uint8Array, aad: Uint8Array, n: Uint8Array, c: Uint8Array, padTo?: number): Uint8Array {
  try {
    if (key.length !== s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES || n.length !== s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) throw new CryptoError();
    const message = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, c, aad, n, key);
    return padTo ? s.unpad(message, padTo) : message;
  } catch {
    throw new CryptoError();
  }
}

// ---- Amplop dan payload ----
/** Kolom amplop yang ikut diautentikasi. `approvalId` dan `expiresAt` hanya ada pada event izin (pemicu notifikasi tanpa membuka isi). */
export type EventEnvelope = {
  v: number;
  id: string;
  machineId: string;
  sessionId: string;
  seq: number;
  ts: string;
  agent: string;
  type: string;
  approvalId?: string;
  expiresAt?: string;
};

const EnvelopeFieldsSchema = z.object({
  v: z.int().min(0),
  id: z.string().min(1),
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.int().min(0),
  ts: z.string().min(1),
  agent: z.string().min(1),
  type: z.string().min(1),
  // Bila ada, tidak boleh kosong ("kosong" dan "tidak ada" adalah dua hal berbeda).
  approvalId: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
});

/** Bentuk payload yang disimpan dan diteruskan relay. Semua byte dalam base64 aman-URL. */
export const SealedPayloadSchema = z.strictObject({
  e: z.literal(PAYLOAD_VERSION),
  kid: z.int().min(1),
  n: z.string().min(1).max(64),
  c: z.string().min(1).max(4_000_000),
  s: z.string().min(1).max(128),
});
export type SealedPayload = z.infer<typeof SealedPayloadSchema>;

/**
 * AAD biner kanonis: label, lalu kolom dalam urutan TETAP (v, id, machineId, sessionId, seq, ts, agent, type, e, kid,
 * approvalId, expiresAt). Kolom asing yang ditambahkan relay tidak ikut, jadi tidak pernah dipakai untuk keputusan keamanan.
 */
export function eventAad(input: EventEnvelope, kid: number): Uint8Array {
  // Jenis tiap kolom diperiksa saat dijalankan (bukan hanya oleh TypeScript): angka berbentuk teks ("5"), kolom kosong, atau
  // kolom asing dari relay tidak boleh lolos. Hanya kolom yang dikenal yang dibaca; sisanya dibuang.
  const parsed = EnvelopeFieldsSchema.safeParse(input);
  if (!parsed.success) throw new CryptoError();
  const envelope = parsed.data;
  const fields: Field[] = [envelope.v, envelope.id, envelope.machineId, envelope.sessionId, envelope.seq, envelope.ts, envelope.agent, envelope.type, PAYLOAD_VERSION, kid, envelope.approvalId, envelope.expiresAt];
  return canon(EVENT_LABEL, fields);
}

function signingInput(aad: Uint8Array, n: Uint8Array, c: Uint8Array): Uint8Array {
  return canon(EVENT_LABEL, [aad, n, c]);
}

export type SealEventInput = {
  /** Kunci data untuk `kid` ini. */
  dataKey: Uint8Array;
  kid: number;
  envelope: EventEnvelope;
  /** Isi event (JSON dalam byte). */
  plaintext: Uint8Array;
  /** Kunci rahasia tanda tangan LAPTOP. */
  signPrivateKey: Uint8Array;
};

/** Mengenkripsi lalu menandatangani. Hanya laptop yang memanggil ini. */
export function sealEvent(s: Sodium, input: SealEventInput): SealedPayload {
  if (!Number.isSafeInteger(input.kid) || input.kid < 1) throw new CryptoError();
  const aad = eventAad(input.envelope, input.kid);
  const { n, c } = aeadSeal(s, input.dataKey, aad, input.plaintext, PAD_BLOCK);
  const signature = s.crypto_sign_detached(signingInput(aad, n, c), input.signPrivateKey);
  return { e: PAYLOAD_VERSION, kid: input.kid, n: toB64(s, n), c: toB64(s, c), s: toB64(s, signature) };
}

export type OpenEventInput = {
  payload: unknown;
  envelope: EventEnvelope;
  /** Laptop yang HP ini percayai untuk pesan ini. Event bertanda tangan laptop lain (atau mengaku mesin lain) ditolak. */
  expectedMachineId: string;
  /** Kunci data yang dikenal HP, per `kid`. `kid` yang tidak ada = ditolak. */
  dataKeys: (kid: number) => Uint8Array | undefined;
  /** Kunci publik tanda tangan laptop yang DIKENAL HP (dari pairing, bukan dari relay). */
  signPublicKey: Uint8Array;
};

/**
 * Memverifikasi tanda tangan LEBIH DULU, baru mendekripsi. Mengembalikan plaintext dan `kid` yang dipakai (pemanggil menolak `kid`
 * yang lebih rendah dari yang terbaru ia terima untuk event baru), atau melempar `CryptoError` (sama untuk semua penyebab,
 * termasuk galat dari `dataKeys`). Pemanggil tidak boleh menampilkan atau menjalankan apa pun dari event yang gagal.
 */
export function openEvent(s: Sodium, input: OpenEventInput): { plaintext: Uint8Array; kid: number } {
  if (input.envelope.machineId !== input.expectedMachineId) throw new CryptoError();
  const parsed = SealedPayloadSchema.safeParse(input.payload);
  if (!parsed.success) throw new CryptoError();
  const { kid } = parsed.data;
  const n = fromB64(s, parsed.data.n);
  const c = fromB64(s, parsed.data.c);
  const signature = fromB64(s, parsed.data.s);
  const aad = eventAad(input.envelope, kid);
  let valid: boolean;
  try {
    valid = s.crypto_sign_verify_detached(signature, signingInput(aad, n, c), input.signPublicKey);
  } catch {
    valid = false;
  }
  if (!valid) throw new CryptoError();
  let key: Uint8Array | undefined;
  try {
    key = input.dataKeys(kid);
  } catch {
    throw new CryptoError(); // galat dari penyimpanan kunci tidak boleh bocor keluar (bukan oracle)
  }
  if (!key) throw new CryptoError();
  return { plaintext: aeadOpen(s, key, aad, n, c, PAD_BLOCK), kid };
}

export { bytesEqual, concat };
