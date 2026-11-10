// =====================================================================================
// FILE INI: membuka koneksi ke database = "PINTU MASUK KE LEMARI ARSIP".
// =====================================================================================
//
// Ada dua pintu, dengan perilaku Postgres yang sama:
//   - openPostgres(url): Postgres sungguhan lewat `pg`. Untuk produksi (misalnya Neon).
//   - openPglite(dir?):  Postgres yang berjalan DI DALAM proses Node lewat PGlite. Untuk test dan
//     pengembangan, tanpa perlu memasang atau menjalankan server database. Tanpa `dir` datanya di
//     memori dan hilang saat proses berhenti.
// Test memakai PGlite, jadi CI di Windows, macOS, dan Linux menguji perilaku Postgres yang asli
// (batasan CHECK, kunci asing, ON CONFLICT) dan bukan tiruannya.
//
// Kode lain hanya melihat tipe `Database`, jadi tidak peduli pintu mana yang dipakai.
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { silentLogger, type Logger } from "../logger";
import * as schema from "./schema";

// Tipe database yang dipakai seluruh kode: sama untuk Postgres sungguhan maupun PGlite.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DatabaseHandle = {
  db: Database;
  /** Menjalankan semua migrasi yang belum dijalankan. Aman dipanggil berulang. */
  migrate(): Promise<void>;
  close(): Promise<void>;
};

// Folder migrasi SQL (dihasilkan drizzle-kit), relatif terhadap paket server.
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function openPglite(dataDir?: string): Promise<DatabaseHandle> {
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  return {
    db,
    migrate: () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
}

// Menyamarkan kata sandi bila sebuah pesan galat kebetulan memuat alamat database
// (postgres://pengguna:kata-sandi@host/db). Berjaga-jaga: log tidak boleh memuat rahasia.
export function redactConnectionSecrets(message: string): string {
  return message.replace(/(\w+:\/\/[^:/\s@]+:)[^@\s]+@/g, "$1***@");
}

/**
 * Memasang penangan galat pada kolam koneksi. WAJIB: koneksi idle yang diputus server (rutin
 * terjadi pada Neon, yang menutup koneksi idle) membuat Pool memancarkan event `error`. Di Node,
 * event `error` tanpa pendengar dilempar sebagai pengecualian yang tidak tertangkap dan mematikan
 * seluruh proses relay. Dengan penangan ini galatnya hanya dicatat, dan Pool membuat koneksi baru
 * saat dibutuhkan.
 */
export function attachPoolErrorHandler(
  pool: { on(event: "error", listener: (error: Error) => void): unknown },
  logger: Logger = silentLogger,
): void {
  pool.on("error", (error) => {
    logger.error(`kesalahan koneksi database: ${redactConnectionSecrets(error.message)}`);
  });
}

export function openPostgres(connectionString: string, options: { logger?: Logger } = {}): DatabaseHandle {
  const pool = new Pool({ connectionString });
  attachPoolErrorHandler(pool, options.logger);
  const db = drizzlePg(pool, { schema });
  return {
    db,
    migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => pool.end(),
  };
}
