// Konfigurasi test paket server.
//
// Belasan berkas test membuat database PGlite sendiri (Postgres dalam WebAssembly) di beforeAll, dan membuatnya berat di
// CPU. Bila semuanya dimulai bersamaan, tiap pembuatan melambat sampai lewat batas 60 detik di mesin yang tidak terlalu
// kencang (berkas yang gagal berbeda di tiap putaran: itu tanda kontensi, bukan bug di satu berkas). Membatasi jumlah proses
// paralel membuat pembuatan database cepat dan stabil.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 3,
  },
});
