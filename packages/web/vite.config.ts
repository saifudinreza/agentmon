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
      // Versi baru aplikasi mengganti yang lama secara otomatis di kunjungan berikutnya.
      registerType: "autoUpdate",
      manifest,
      workbox: {
        // Semua berkas hasil build disimpan di HP saat pertama dibuka (precache), sehingga
        // kerangka aplikasi terbuka walau tanpa jaringan.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        // Navigasi ke alamat mana pun (misalnya /pair#...) dijawab dengan kerangka aplikasi.
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    sourcemap: false,
  },
});
