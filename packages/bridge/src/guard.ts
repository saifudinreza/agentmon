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
