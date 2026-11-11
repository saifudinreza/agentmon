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

// Kode sekali pakai: acak, panjang, dan hanya berisi karakter aman untuk alamat web.
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const PairCodeSchema = z.string().regex(PAIRING_CODE_PATTERN);

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
  name: z.string().trim().min(1).max(64),
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
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

export const PairedDevicesResponseSchema = z.object({ devices: z.array(PairedDeviceSchema) });
export type PairedDevicesResponse = z.infer<typeof PairedDevicesResponseSchema>;

// ---- Alamat di dalam QR ----------------------------------------------------------------
export type PairingLink = {
  code: string;
  /** Alamat dasar relay, misalnya https://relay.contoh.com (tanpa /ws). */
  relayUrl: string;
  /** Rahasia E2E (tahap 4). Hanya ada di fragmen, tidak pernah dikirim ke server. */
  secret?: string;
};

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
  if (link.secret !== undefined) fragment.set("k", link.secret);
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
  const secret = fragment.get("k");
  if (code === null || relayUrl === null) return undefined;
  if (!PAIRING_CODE_PATTERN.test(code) || !isHttpUrl(relayUrl)) return undefined;
  return { code, relayUrl, ...(secret !== null && secret !== "" ? { secret } : {}) };
}
