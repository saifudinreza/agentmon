// =====================================================================================
// FILE INI: semua teks aplikasi dalam Bahasa Indonesia (bahasa bawaan).
// =====================================================================================
//
// Aturan: TIDAK ADA teks yang ditulis langsung di komponen. Semuanya lewat `t("kunci")`, supaya
// bahasa lain cukup menambah satu berkas dengan kunci yang sama (en.ts). Kunci diambil dari berkas
// ini; berkas bahasa lain WAJIB punya semua kunci yang sama, dan TypeScript menolak bila ada yang
// kurang atau berlebih.
//
// Isian dalam kurung kurawal, seperti {nama}, diganti nilai saat dipakai: t("sapa", { nama: "Budi" }).
export const id = {
  "app.name": "AgentMon",
  "app.tagline": "Pantau dan setujui aksi coding agent dari HP.",

  "empty.title": "Belum ada laptop terpasang",
  "empty.body": "Jalankan perintah pair di laptop, lalu pindai QR yang muncul dengan kamera HP ini.",

  "offline.banner": "Anda sedang offline. Data terbaru akan dimuat saat jaringan kembali.",

  "theme.label": "Tema: {mode}",
  "theme.toggle": "Ganti tema",
  "theme.system": "Otomatis",
  "theme.light": "Terang",
  "theme.dark": "Gelap",
} as const;

export type MessageKey = keyof typeof id;
