// Menjalankan migrasi ke database Postgres sungguhan: `pnpm --filter @agentmon/server db:migrate`.
//
// Butuh variabel DATABASE_URL (misalnya dari Neon). Aman dijalankan berulang: hanya migrasi yang
// belum dijalankan yang diterapkan. Perilaku migrasinya sudah diuji pada database kosong dengan
// PGlite (mesin Postgres yang asli) di test; file ini hanya membukanya ke Postgres produksi.
import { openPostgres } from "./connect";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Butuh variabel DATABASE_URL, misalnya: postgres://pengguna:kata-sandi@host/namadb");
  process.exit(1);
}

const handle = openPostgres(url);
try {
  await handle.migrate();
  console.log("Migrasi selesai.");
} catch (error) {
  // Hanya pesan galat yang dicetak; alamat database (yang memuat kata sandi) tidak pernah dicetak.
  console.error(`Migrasi gagal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
