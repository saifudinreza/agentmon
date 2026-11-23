// =====================================================================================
// FILE INI: pengodean biner kanonis dan galat kripto (docs/security-e2e.md bagian 4.3).
// =====================================================================================
//
// Semua yang ditandatangani atau dijadikan AAD memakai pengodean ini, BUKAN JSON.stringify: urutan kolom tetap, dan tiap kolom
// berawalan JENIS (1 byte) dan PANJANG (4 byte). Akibatnya "ab"+"c" tidak sama dengan "a"+"bc", kolom yang tidak ada (undefined)
// tidak sama dengan teks kosong, dan angka 5 tidak sama dengan teks "5".
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

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
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

// Jenis kolom (byte pertama). Berbeda untuk tiap jenis, jadi tidak ada dua kolom berjenis berbeda yang menghasilkan byte sama.
const TAG_ABSENT = 0;
const TAG_TEXT = 1;
const TAG_UINT = 2;
const TAG_BYTES = 3;

function encodeField(field: Field): Uint8Array {
  if (field === undefined) return concat([Uint8Array.of(TAG_ABSENT), u32(0)]);
  if (typeof field === "string") {
    const bytes = utf8(field);
    return concat([Uint8Array.of(TAG_TEXT), u32(bytes.length), bytes]);
  }
  if (typeof field === "number") {
    // Hanya bilangan bulat aman tak negatif, dalam satu bentuk teks (desimal): tanpa "1.0" atau "1e3".
    if (!Number.isSafeInteger(field) || field < 0) throw new CryptoError();
    const bytes = utf8(String(field));
    return concat([Uint8Array.of(TAG_UINT), u32(bytes.length), bytes]);
  }
  // Selain tiga jenis di atas (objek, boolean, null, ...) bukan kolom yang sah: gagal tertutup, bukan diam-diam diubah.
  if (!(field instanceof Uint8Array)) throw new CryptoError();
  return concat([Uint8Array.of(TAG_BYTES), u32(field.length), field]);
}

/** `label` lalu tiap kolom berawalan jenis dan panjang. `undefined` (kolom tidak ada) berbeda dari teks kosong. */
export function canon(label: string, fields: readonly Field[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const piece of [label, ...fields] as Field[]) parts.push(encodeField(piece));
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

// Karakter yang tidak boleh ada di nama perangkat: kendali (termasuk ESC yang membuka urutan ANSI), format (lebar nol, arah teks
// bidi, penanda), pemisah baris dan paragraf, dan karakter privat. Nama datang dari HP dan dicetak di terminal laptop; nama yang
// tampak sama tetapi berbeda byte (akhiran lebar nol) dipakai untuk menyamarkan permintaan palsu.
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/u;

/** Nama perangkat yang sah (NFC, tanpa spasi di ujung, 1 sampai 64 karakter, tanpa karakter terlarang), atau undefined. */
export function normalizeDeviceName(name: string): string | undefined {
  const normalized = name.normalize("NFC").trim();
  if (normalized.length < 1 || [...normalized].length > 64) return undefined;
  if (FORBIDDEN_IN_NAME.test(normalized)) return undefined;
  return normalized;
}
