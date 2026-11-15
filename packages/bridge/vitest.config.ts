// Konfigurasi test paket bridge. Satu hal penting: setiap proses test memakai folder data sementara sendiri
// (lihat src/setup-tests.ts), supaya tidak ada test yang membaca atau menulis folder data pengguna sungguhan.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/setup-tests.ts"],
  },
});
