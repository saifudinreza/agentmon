// Pembantu KHUSUS TEST untuk lapisan database. Tidak diekspor dari index.ts.
import { sql } from "drizzle-orm";
import { openPglite, type Database, type DatabaseHandle } from "./connect";

/** Database PGlite baru di memori, sudah dimigrasi. Kosong, siap dipakai. */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const handle = await openPglite();
  await handle.migrate();
  return handle;
}

/** Mengosongkan semua tabel (lebih cepat daripada membuat database baru untuk tiap test). */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE events, sessions, pairings, pairing_codes, push_subscriptions, devices, machines RESTART IDENTITY CASCADE`,
  );
}

/** Menjalankan SQL mentah dan mengembalikan barisnya. */
export async function query(db: Database, statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const result = (await db.execute(statement)) as unknown as { rows: Array<Record<string, unknown>> };
  return result.rows;
}
