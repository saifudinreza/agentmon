// =====================================================================================
// FILE INI: bentuk data dan alamat (URL) untuk PAIRING laptop dan HP.
// =====================================================================================
//
// Pairing = proses "berkenalan" pertama kali antara sebuah laptop dan sebuah HP, supaya
// relay tahu HP ini boleh melihat dan mengendalikan laptop itu.
//
// ANALOGI: kunci cadangan rumah. Laptop (pemilik rumah) mencetak SATU kunci sementara dalam
// bentuk QR. HP menunjukkannya ke relay (penjaga gedung), dan penjaga menukarnya dengan kunci
// tetap atas nama HP itu. Kunci sementara langsung hangus setelah dipakai sekali, dan hangus
// sendiri bila tidak dipakai dalam beberapa menit.
//
// Isi QR adalah sebuah alamat web yang membuka aplikasi HP (PWA):
//
//     https://<alamat-pwa>/pair#c=<kode>&r=<alamat-relay>
//                              ^ tanda # = FRAGMEN
//
// Semua data ditaruh di FRAGMEN (setelah tanda #). Browser tidak pernah mengirim fragmen ke
// server mana pun, dan fragmen tidak masuk log server tempat PWA dihosting. Alasan kedua untuk
// memakai fragmen: rahasia enkripsi ujung-ke-ujung (E2E, tahap 4) nanti ditambahkan sebagai
// parameter `k` di tempat yang sama, dan karena tidak pernah terkirim, server (termasuk relay)
// tetap tidak bisa membaca isi event. Parameter yang belum dikenal diabaikan, jadi alamat versi
// baru tetap terbaca oleh PWA versi lama dan sebaliknya.
import { z } from "zod";
import { E2ePairingMaterialSchema } from "./e2e-wire";

// Kode sekali pakai: acak, panjang, dan hanya berisi karakter aman untuk alamat web.
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

// \p{Cc} = karakter kontrol C0, DEL, dan C1; \p{Zl}\p{Zp} = pemisah baris dan paragraf Unicode.
export const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** Mengganti karakter kontrol dengan "?" supaya aman dicetak ke terminal (untuk data lama atau dari sumber lain). */
export function sanitizeForTerminal(text: string): string {
  return text.replace(new RegExp(CONTROL_CHARACTERS.source, "gu"), "?");
}

export const PairCodeSchema =z.string().regex(PAIRING_CODE_PATTERN);

// ---- Laptop meminta kode ---------------------------------------------------------------
export const PairCodeResponseSchema = z.object({
  code: PairCodeSchema,
  expiresAt: z.string().datetime(),
});
export type PairCodeResponse = z.infer<typeof PairCodeResponseSchema>;

// ---- HP menukar kode menjadi kredensial ------------------------------------------------
export const PairRedeemRequestSchema = z.object({
  code: PairCodeSchema,
  // Nama yang tampil di laptop ("iPhone Budi"). Dipangkas spasinya, tidak boleh kosong.
  // Tanpa karakter kontrol (termasuk ESC yang membuka urutan ANSI), pemisah baris, dan karakter
  // kontrol C1: nama ini dikirim dari HP, tidak tepercaya, dan dicetak di terminal laptop. Nama
  // yang memuatnya bisa menghapus layar atau menyamarkan tulisan lain.
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((name) => !CONTROL_CHARACTERS.test(name), "Nama tidak boleh memuat karakter kontrol"),
  // Bahan pairing E2E (kunci publik HP dan bukti rahasia QR). Tanpa ini: pairing lama tanpa enkripsi ujung-ke-ujung.
  e2e: E2ePairingMaterialSchema.optional(),
});
export type PairRedeemRequest = z.infer<typeof PairRedeemRequestSchema>;

export const PairRedeemResponseSchema = z.object({
  deviceId: z.string().min(1),
  machineId: z.string().min(1),
  machineName: z.string(),
  // Ada HANYA bila HP ini perangkat baru. HP yang sudah punya kredensial (memasangkan laptop
  // kedua) memakai kredensial lamanya, jadi tidak diberi yang baru.
  deviceToken: z.string().min(16).optional(),
});
export type PairRedeemResponse = z.infer<typeof PairRedeemResponseSchema>;

// ---- Laptop melihat perangkat yang terpasang -------------------------------------------
export const PairedDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  pairedAt: z.string().datetime(),
  /** Hanya untuk laptop: bahan pairing E2E yang dikirim HP (tidak tepercaya; laptop memverifikasinya sendiri). */
  e2e: E2ePairingMaterialSchema.optional(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

export const PairedDevicesResponseSchema = z.object({ devices: z.array(PairedDeviceSchema) });
export type PairedDevicesResponse = z.infer<typeof PairedDevicesResponseSchema>;

// ---- HP melihat perangkat sesamanya (yang berbagi laptop) -------------------------------
export const ListedDeviceSchema = PairedDeviceSchema.extend({ current: z.boolean() });
export type ListedDevice = z.infer<typeof ListedDeviceSchema>;
export const DevicesResponseSchema = z.object({ devices: z.array(ListedDeviceSchema) });
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;

// ---- Alamat di dalam QR ----------------------------------------------------------------
export type PairingLink = {
  code: string;
  /** Alamat dasar relay, misalnya https://relay.contoh.com (tanpa /ws). */
  relayUrl: string;
  /** Rahasia E2E 32 byte (base64 aman-URL), parameter `s`. Hanya ada di fragmen, tidak pernah dikirim ke server. */
  secret?: string;
  /** Kunci publik Ed25519 laptop (base64 aman-URL), parameter `k`. HP memverifikasi tanda tangan laptop dengan ini, bukan dengan yang dari relay. */
  laptopKey?: string;
};

// Rahasia dan kunci publik 32 byte dalam base64 aman-URL tanpa padding = 43 karakter.
const KEY_PARAM = /^[A-Za-z0-9_-]{43}$/;

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Membuat alamat untuk QR. `appUrl` adalah alamat PWA (https://app.contoh.com atau .../app). */
export function buildPairingUrl(appUrl: string, link: PairingLink): string {
  if (!isHttpUrl(appUrl)) throw new TypeError("Alamat aplikasi harus http(s)");
  if (!isHttpUrl(link.relayUrl)) throw new TypeError("Alamat relay harus http(s)");
  if (!PAIRING_CODE_PATTERN.test(link.code)) throw new TypeError("Kode pairing tidak valid");

  const url = new URL(appUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/pair`;
  url.search = "";
  const fragment = new URLSearchParams({ c: link.code, r: link.relayUrl });
  if (link.laptopKey !== undefined) fragment.set("k", link.laptopKey);
  if (link.secret !== undefined) fragment.set("s", link.secret);
  url.hash = fragment.toString();
  return url.toString();
}

/**
 * Membaca alamat dari QR. Mengembalikan `undefined` (bukan melempar) bila bukan alamat pairing
 * yang sah, supaya PWA cukup menampilkan "QR tidak dikenali".
 */
export function parsePairingUrl(text: string): PairingLink | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!url.pathname.replace(/\/+$/, "").endsWith("/pair")) return undefined;

  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = fragment.get("c");
  const relayUrl = fragment.get("r");
  const laptopKey = fragment.get("k");
  const secret = fragment.get("s");
  if (code === null || relayUrl === null) return undefined;
  if (!PAIRING_CODE_PATTERN.test(code) || !isHttpUrl(relayUrl)) return undefined;
  // Rahasia dan kunci yang bentuknya salah dibuang (dianggap pairing lama), bukan membuat seluruh QR ditolak.
  return {
    code,
    relayUrl,
    ...(laptopKey !== null && KEY_PARAM.test(laptopKey) ? { laptopKey } : {}),
    ...(secret !== null && KEY_PARAM.test(secret) ? { secret } : {}),
  };
}
