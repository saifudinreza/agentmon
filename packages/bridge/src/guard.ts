// Penjaga pintu daemon: menentukan apakah sebuah request boleh diproses.
//
// Daemon hanya mendengarkan di 127.0.0.1, tetapi itu belum cukup. Situs web yang kamu
// buka di browser bisa mengirim request ke 127.0.0.1 juga. Tiga lapis pemeriksaan:
//   1. Host: menolak serangan "DNS rebinding", yaitu situs jahat yang mengarahkan
//      namanya ke 127.0.0.1 supaya browser mengira request ke daemon itu sah.
//   2. Browser: request dari browser selalu membawa Origin atau Sec-Fetch-*, sedangkan
//      Claude Code dan CLI kita tidak. Ditolak apa pun isi tokennya.
//   3. Token: pembeda utama antara Claude Code/CLI milikmu dan program lain di laptop.
import type { IncomingMessage } from "node:http";
import { tokensEqual } from "./home";

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

const deny = (status: 401 | 403, message: string): GuardResult => ({ ok: false, status, message });

export function guardRequest(req: IncomingMessage, options: { port: number; token: string }): GuardResult {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${options.port}` && host !== `localhost:${options.port}`) {
    return deny(403, "host tidak diizinkan");
  }

  const h = req.headers;
  if (h.origin !== undefined || h["sec-fetch-site"] !== undefined || h["sec-fetch-mode"] !== undefined) {
    return deny(403, "request dari browser ditolak");
  }

  const match = /^Bearer (\S+)$/.exec(h.authorization ?? "");
  if (!match?.[1] || !tokensEqual(match[1], options.token)) {
    return deny(401, "kredensial tidak valid");
  }
  return { ok: true };
}

// ---- Penjaga untuk halaman web lokal (alat pengembangan) -------------------------------
//
// Penjaga di atas MENOLAK semua request dari browser, karena itu cara paling sederhana menahan
// situs web yang menembak 127.0.0.1. Halaman web lokal justru berjalan DI browser dan berbicara
// dengan daemon, jadi ia butuh aturan yang lebih halus. Yang dilonggarkan hanya satu hal:
// request dari browser diterima bila berasal dari halaman milik daemon sendiri (same-origin).
//
//   - Host tetap harus 127.0.0.1:<port> atau localhost:<port> (menolak DNS rebinding).
//   - Request dari situs lain dalam bentuk apa pun ditolak: browser menandainya dengan
//     `Sec-Fetch-Site: cross-site` atau `same-site`, dan/atau `Origin` yang bukan alamat daemon.
//     Penanda ini dipasang browser, tidak bisa dipalsukan oleh halaman web.
//   - Untuk API, token Bearer tetap WAJIB. Situs lain tidak tahu token, dan tidak bisa
//     memasang header Authorization pada request lintas situs tanpa izin CORS yang tidak kita berikan.
export function guardDevRequest(
  req: IncomingMessage,
  options: { port: number; token: string },
  kind: "page" | "api",
): GuardResult {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${options.port}` && host !== `localhost:${options.port}`) {
    return deny(403, "host tidak diizinkan");
  }

  const h = req.headers;
  const own = [`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`];
  if (h.origin !== undefined && !own.includes(h.origin)) return deny(403, "asal request tidak diizinkan");

  // Halaman boleh dibuka dengan mengetik alamatnya ("none") atau dari halaman sendiri; yang lain
  // pun tidak berbahaya karena halaman tanpa token tidak bisa melakukan apa-apa. API hanya boleh
  // dipanggil dari halaman sendiri, atau dari program non-browser (tanpa penanda sama sekali).
  const site = h["sec-fetch-site"];
  if (kind === "api" && site !== undefined && site !== "same-origin") return deny(403, "request lintas situs ditolak");

  if (kind === "api") {
    const match = /^Bearer (\S+)$/.exec(h.authorization ?? "");
    if (!match?.[1] || !tokensEqual(match[1], options.token)) return deny(401, "kredensial tidak valid");
  }
  return { ok: true };
}
