// =====================================================================================
// FILE INI: manifest = "KARTU IDENTITAS" aplikasi untuk HP.
// =====================================================================================
//
// Saat pengguna memilih "Tambahkan ke layar utama", Android dan iOS membaca kartu ini untuk tahu:
// nama di bawah ikon, ikon yang dipakai, apakah dibuka layar penuh tanpa bilah alamat browser
// (`standalone`), dan warna latar saat aplikasi sedang dimuat.
//
// Dipisah dari vite.config.ts supaya bisa diuji (lihat manifest.test.ts): kartu yang salah membuat
// aplikasi tidak bisa dipasang, dan kesalahan seperti itu sulit terlihat saat pengembangan.
import type { ManifestOptions } from "vite-plugin-pwa";

// Warna latar gelap yang sama dengan tema gelap aplikasi (styles.css).
export const BACKGROUND_COLOR = "#0b0f14";
export const THEME_COLOR = "#0b0f14";

export const manifest: Partial<ManifestOptions> = {
  // `id` menjadi identitas tetap aplikasi, walau alamat awalnya kelak berubah.
  id: "/",
  name: "AgentMon",
  short_name: "AgentMon",
  description: "Pantau dan setujui aksi coding agent dari HP Anda.",
  lang: "id",
  dir: "ltr",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: BACKGROUND_COLOR,
  theme_color: THEME_COLOR,
  categories: ["developer tools", "productivity"],
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    // Ikon "maskable": Android memotongnya menjadi lingkaran atau bentuk lain, jadi gambarnya
    // memenuhi seluruh kotak dan isi pentingnya berada di bagian tengah.
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
