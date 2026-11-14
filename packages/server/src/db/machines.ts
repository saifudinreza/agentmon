// =====================================================================================
// FILE INI: pendaftaran laptop = "BUKU ANGGOTA" yang mencatat laptop baru beserta HASH kuncinya.
// =====================================================================================
//
// Dipakai pendaftaran lewat HTTP (admin-http.ts). Token laptop tidak pernah masuk database: yang disimpan hash
// SHA-256-nya, dan batasan CHECK di skema menolak apa pun yang bukan hash.
import { eq } from "drizzle-orm";
import { hashToken } from "../directory";
import type { Database } from "./connect";
import { machines } from "./schema";

export type MachineRegistry = {
  /** Mendaftarkan laptop baru. "exists" bila nomornya sudah terdaftar (tidak ada yang diubah). */
  register(input: { id: string; name: string; token: string }): Promise<"created" | "exists">;
  /** Mengganti token (dan nama) laptop yang sudah terdaftar. Token lama langsung tidak berlaku. "missing" bila belum terdaftar. */
  rotate(input: { id: string; name: string; token: string }): Promise<"rotated" | "missing">;
};

export function createMachineRegistry(db: Database): MachineRegistry {
  return {
    async register({ id, name, token }) {
      // Target = nomor laptop: bentrok pada nomor berarti "sudah ada". Bentrok pada hash token (tidak mungkin terjadi
      // untuk token acak 256 bit) sengaja tidak ditelan: biarkan melempar galat.
      const rows = await db
        .insert(machines)
        .values({ id, name, tokenHash: hashToken(token) })
        .onConflictDoNothing({ target: machines.id })
        .returning({ id: machines.id });
      return rows.length > 0 ? "created" : "exists";
    },

    async rotate({ id, name, token }) {
      const rows = await db.update(machines).set({ tokenHash: hashToken(token), name }).where(eq(machines.id, id)).returning({ id: machines.id });
      return rows.length > 0 ? "rotated" : "missing";
    },
  };
}
