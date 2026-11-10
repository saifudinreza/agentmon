// Konfigurasi drizzle-kit: alat yang menghasilkan migrasi SQL dari skema.
//   pnpm --filter @agentmon/server db:generate    (setelah mengubah src/db/schema.ts)
// Hasilnya masuk ke folder `drizzle/` dan HARUS ikut di-commit bersama perubahan skema.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
