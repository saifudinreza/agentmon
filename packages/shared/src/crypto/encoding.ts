// =====================================================================================
// FILE INI: pengodean biner kanonis dan galat kripto (docs/security-e2e.md bagian 4.3).
// =====================================================================================
//
// Semua yang ditandatangani atau dijadikan AAD memakai pengodean ini, BUKAN JSON.stringify: urutan kolom tetap, tiap kolom
// berawalan panjang 4 byte, sehingga dua susunan kolom yang berbeda tidak pernah menghasilkan byte yang sama ("ab"+"c" tidak
// sama dengan "a"+"bc").
import type { Sodium } from "./sodium";

/**
 * Satu-satunya galat yang dilempar fungsi kripto di sini. Pesannya selalu sama ("invalid") apa pun penyebabnya (tanda tangan
 * salah, kunci salah, data diubah, kid tak dikenal, bentuk rusak), supaya jawabannya tidak menjadi oracle bagi penyerang
 * (aturan desain 5).
 */
export class CryptoError extends Error {
  constructor() {
    super("invalid");
    this.name = "CryptoError";
  }
}

export type Field = string | number | Uint8Array | undefined;

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

function lengthPrefix(length: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function fieldBytes(field: Field): Uint8Array {
  if (field === undefined) return new Uint8Array(0);
  if (typeof field === "number") {
    // Angka hanya bilangan bulat aman tak negatif: satu bentuk teks saja (desimal), tanpa "1.0" atau "1e3".
    if (!Number.isSafeInteger(field) || field < 0) throw new CryptoError();
    return utf8(String(field));
  }
  if (typeof field === "string") return utf8(field);
  return field;
}

/** `label` lalu tiap kolom, masing-masing berawalan panjang 4 byte (big-endian). `undefined` = kolom kosong. */
export function canon(label: string, fields: readonly Field[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const piece of [label, ...fields] as Field[]) {
    const bytes = fieldBytes(piece);
    parts.push(lengthPrefix(bytes.length), bytes);
  }
  return concat(parts);
}

/** Base64 aman-URL tanpa padding (untuk membawa byte di dalam JSON dan fragmen alamat). */
export function toB64(sodium: Sodium, bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64(sodium: Sodium, text: string): Uint8Array {
  try {
    return sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new CryptoError();
  }
}

/** Perbandingan waktu-tetap dua deretan byte. */
export function bytesEqual(sodium: Sodium, a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && sodium.memcmp(a, b);
}
