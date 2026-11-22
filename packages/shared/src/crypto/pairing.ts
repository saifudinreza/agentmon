// =====================================================================================
// FILE INI: primitif pairing = bukti rahasia QR, sidik jari, kunci pasangan, dan pembungkus kunci data (docs/security-e2e.md 4.2).
// =====================================================================================
//
// Penangkal serangan perantara adalah rahasia `s` yang HANYA ada di QR (relay tidak pernah melihatnya). Penangkal QR yang bocor
// adalah konfirmasi sidik jari oleh orang di depan laptop. Fungsi di sini hanya primitif; urutan protokolnya ada di pemanggil
// (daemon dan PWA, issue #033 bagian B dan C).
import { aeadOpen, aeadSeal } from "./event";
import { canon, CryptoError, fromB64, toB64, type Field } from "./encoding";
import type { Sodium } from "./sodium";

export const PAIR_LABEL = "agentmon/pair/v1";
export const PAIR_KDF_CONTEXT = "AMpair01"; // tepat 8 byte
export const SECRET_BYTES = 32;

/** Rahasia 32 byte untuk QR. */
export function generatePairingSecret(s: Sodium): Uint8Array {
  return s.randombytes_buf(SECRET_BYTES);
}

/** Kunci bukti (kk) dari rahasia QR. Hanya berlaku untuk pairing ini. */
export function pairingProofKey(s: Sodium, secret: Uint8Array): Uint8Array {
  if (secret.length !== SECRET_BYTES) throw new CryptoError();
  return s.crypto_kdf_derive_from_key(32, 1, PAIR_KDF_CONTEXT, secret);
}

export type PairRequest = {
  code: string;
  machineId: string;
  deviceName: string;
  /** Kunci publik X25519 HP. */
  kxPublicKey: Uint8Array;
  /** Kunci publik Ed25519 HP. */
  signPublicKey: Uint8Array;
};

function proofInput(request: PairRequest): Uint8Array {
  return canon(PAIR_LABEL, [request.code, request.machineId, request.deviceName, request.kxPublicKey, request.signPublicKey]);
}

/** Bukti HP bahwa ia memegang rahasia QR dan mengikat bukti itu ke kunci publiknya (HMAC, crypto_auth). */
export function makePairProof(s: Sodium, request: PairRequest, secret: Uint8Array): Uint8Array {
  return s.crypto_auth(proofInput(request), pairingProofKey(s, secret));
}

/** Laptop memverifikasi bukti dengan rahasia dari CATATANNYA sendiri (bukan dari relay). Tidak pernah melempar. */
export function verifyPairProof(s: Sodium, proof: Uint8Array, request: PairRequest, secret: Uint8Array): boolean {
  try {
    return s.crypto_auth_verify(proof, proofInput(request), pairingProofKey(s, secret));
  } catch {
    return false;
  }
}

/**
 * Sidik jari 6 digit yang ditampilkan di laptop DAN di HP untuk dibandingkan manusia. Transkrip: kode, mesin, nama, kedua kunci
 * HP, dan kunci tanda tangan laptop (yang HP kenal dari QR). Penyerang yang menukar kunci mengubah transkrip, sehingga angkanya
 * berbeda. Dipotong dari hash 32-bit; 6 digit membatasi peluang tabrakan acak pada 1 dari sejuta per percobaan.
 */
export function pairingFingerprint(s: Sodium, request: PairRequest, laptopSignPublicKey: Uint8Array): string {
  const digest = s.crypto_generichash(32, canon("agentmon/pair/fp/v1", [request.code, request.machineId, request.deviceName, request.kxPublicKey, request.signPublicKey, laptopSignPublicKey]), null);
  const value = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false) % 1_000_000;
  return String(value).padStart(6, "0");
}

export type SessionKeys = { rx: Uint8Array; tx: Uint8Array };

/** Kunci pasangan di sisi LAPTOP (server): `tx` untuk laptop ke HP, `rx` untuk HP ke laptop. */
export function laptopSessionKeys(s: Sodium, laptopKx: { publicKey: Uint8Array; privateKey: Uint8Array }, phoneKxPublicKey: Uint8Array): SessionKeys {
  try {
    const { sharedRx, sharedTx } = s.crypto_kx_server_session_keys(laptopKx.publicKey, laptopKx.privateKey, phoneKxPublicKey);
    return { rx: sharedRx, tx: sharedTx };
  } catch {
    throw new CryptoError();
  }
}

/** Kunci pasangan di sisi HP (client): `tx` untuk HP ke laptop, `rx` untuk laptop ke HP. */
export function phoneSessionKeys(s: Sodium, phoneKx: { publicKey: Uint8Array; privateKey: Uint8Array }, laptopKxPublicKey: Uint8Array): SessionKeys {
  try {
    const { sharedRx, sharedTx } = s.crypto_kx_client_session_keys(phoneKx.publicKey, phoneKx.privateKey, laptopKxPublicKey);
    return { rx: sharedRx, tx: sharedTx };
  } catch {
    throw new CryptoError();
  }
}

// ---- Pembungkus kunci data ----
export type WrapContext = { machineId: string; deviceId: string; kid: number };
export type WrappedKey = { n: string; c: string };

const wrapAad = (context: WrapContext): Uint8Array => canon("agentmon/wrap/v1", [context.machineId, context.deviceId, context.kid]);

/** Laptop membungkus kunci data untuk SATU HP dengan kunci pasangan laptop ke HP. */
export function wrapDataKey(s: Sodium, laptopToPhoneKey: Uint8Array, dataKey: Uint8Array, context: WrapContext): WrappedKey {
  const { n, c } = aeadSeal(s, laptopToPhoneKey, wrapAad(context), dataKey);
  return { n: toB64(s, n), c: toB64(s, c) };
}

/** HP membuka kunci data. Konteks (mesin, perangkat, kid) ikut diautentikasi: bungkusan untuk HP atau kid lain ditolak. */
export function unwrapDataKey(s: Sodium, laptopToPhoneKey: Uint8Array, wrapped: WrappedKey, context: WrapContext): Uint8Array {
  return aeadOpen(s, laptopToPhoneKey, wrapAad(context), fromB64(s, wrapped.n), fromB64(s, wrapped.c));
}

// ---- Jawaban laptop pada pairing (ditandatangani) ----
export type PairResponse = {
  machineId: string;
  machineName: string;
  /** Kunci publik X25519 laptop. */
  laptopKxPublicKey: Uint8Array;
  code: string;
  kid: number;
  /** Kunci publik HP yang dijawab: mengikat jawaban ke HP itu. */
  phoneKxPublicKey: Uint8Array;
  phoneSignPublicKey: Uint8Array;
  wrapped: WrappedKey;
};

function responseInput(r: PairResponse): Uint8Array {
  const fields: Field[] = [r.machineId, r.machineName, r.laptopKxPublicKey, r.code, r.kid, r.phoneKxPublicKey, r.phoneSignPublicKey, r.wrapped.n, r.wrapped.c];
  return canon("agentmon/pair/resp/v1", fields);
}

export function signPairResponse(s: Sodium, response: PairResponse, laptopSignPrivateKey: Uint8Array): Uint8Array {
  return s.crypto_sign_detached(responseInput(response), laptopSignPrivateKey);
}

/** HP memverifikasi dengan kunci tanda tangan laptop yang ia terima dari QR (bukan dari relay). Tidak pernah melempar. */
export function verifyPairResponse(s: Sodium, signature: Uint8Array, response: PairResponse, laptopSignPublicKey: Uint8Array): boolean {
  try {
    return s.crypto_sign_verify_detached(signature, responseInput(response), laptopSignPublicKey);
  } catch {
    return false;
  }
}
