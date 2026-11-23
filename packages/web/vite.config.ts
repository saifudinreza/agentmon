// =====================================================================================
// FILE INI: konfigurasi build aplikasi HP (PWA) = "RESEP" membuat aplikasinya.
// =====================================================================================
//
// Tiga bahan utamanya:
//   - React            : membangun tampilan.
//   - Tailwind CSS     : gaya tampilan lewat kelas-kelas kecil.
//   - vite-plugin-pwa  : membuat manifest (kartu identitas aplikasi untuk "Tambahkan ke layar
//                        utama") dan service worker (penjaga yang menyimpan berkas aplikasi di HP
//                        supaya tetap bisa dibuka saat offline).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { manifest } from "./src/pwa/manifest";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Service worker ditulis sendiri (src/sw.ts) karena harus menangani push dan ketukan notifikasi, yang tidak
      // bisa dilakukan service worker bawaan. Daftar berkas yang disimpan disisipkan ke dalamnya saat build.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // Versi baru aplikasi mengganti yang lama secara otomatis di kunjungan berikutnya (sw.ts memanggil skipWaiting).
      registerType: "autoUpdate",
      manifest,
      injectManifest: {
        // Semua berkas hasil build disimpan di HP saat pertama dibuka (precache), sehingga
        // kerangka aplikasi terbuka walau tanpa jaringan.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        // libsodium (±430 kB) dimuat belakangan dan hanya dibutuhkan pengguna E2E: tidak ikut di-precache untuk semua orang. sw.ts menyimpannya saat
        // dipakai pertama kali, sehingga pengguna E2E tetap bisa membuka aplikasi tanpa jaringan sesudahnya.
        globIgnores: ["**/libsodium-*.js"],
      },
    }),
  ],
  build: {
    sourcemap: false,
  },
});
