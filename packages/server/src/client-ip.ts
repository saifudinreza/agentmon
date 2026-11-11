// Alamat klien untuk pembatasan laju = "MEMBACA PLAT NOMOR" penelepon, dipakai bersama oleh semua endpoint HTTP.
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * Alamat IP penelepon. Secara bawaan dari soket (tidak bisa dipalsukan klien). Di belakang proxy hosting
 * (`trustProxy`), dibaca dari entri TERKANAN header X-Forwarded-For: entri itu ditambahkan oleh proxy kita
 * sendiri, sedangkan entri di kirinya bisa dipalsukan klien. Jangan nyalakan bila relay terbuka langsung ke
 * internet.
 */
export function clientAddress(c: Context, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return getConnInfo(c).remote.address ?? "tidak-diketahui";
}
