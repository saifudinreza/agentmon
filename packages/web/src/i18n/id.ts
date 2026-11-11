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

  "home.machines.title": "Laptop terpasang",
  "home.machine.via": "melalui {host}",
  "home.pair.title": "Pasangkan laptop",
  "home.pair.body": "Jalankan perintah pair di laptop, lalu pindai QR yang muncul dengan kamera HP. Di aplikasi yang sudah dipasang ke layar utama, tempel tautan pairing di bawah.",

  "paste.label": "Tempel tautan pairing",
  "paste.placeholder": "https://…/pair#c=…",
  "paste.submit": "Lanjut",
  "paste.invalid": "Ini bukan tautan pairing AgentMon. Salin ulang tautannya dari laptop, atau pindai ulang QR-nya.",

  "pair.title": "Pasangkan dengan laptop",
  "pair.relay": "Laptop akan dihubungkan lewat {host}.",
  "pair.warning": "Lanjutkan hanya bila Anda sendiri yang menjalankan perintah pair di laptop Anda. Jangan pasangkan dari tautan yang dikirim orang lain.",
  "pair.name.label": "Nama perangkat ini",
  "pair.name.hint": "Nama ini tampil di laptop saat HP terpasang.",
  "pair.name.invalid": "Nama tidak boleh kosong, lebih dari 64 karakter, atau berisi karakter kontrol.",
  "pair.submit": "Pasangkan",
  "pair.working": "Memasangkan…",
  "pair.success.title": "Terhubung dengan {name}",
  "pair.success.body": "HP ini sudah terpasang. Aktivitas agent di laptop akan muncul di sini.",
  "pair.success.done": "Selesai",
  "pair.error.title": "Pairing belum berhasil",
  "pair.error.invalid": "Kode ini sudah kedaluwarsa atau sudah dipakai. Jalankan perintah pair di laptop untuk membuat QR baru.",
  "pair.error.rate": "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
  "pair.error.insecure": "Alamat relay tidak terenkripsi (bukan https), jadi pairing dibatalkan demi keamanan.",
  "pair.error.unreachable": "Tidak bisa menghubungi relay. Periksa jaringan Anda, lalu coba lagi.",
  "pair.error.failed": "Pairing gagal karena kesalahan tak terduga. Coba buat QR baru di laptop.",
  "pair.error.notSaved": "Pairing dengan {name} berhasil, tetapi tidak bisa disimpan di HP ini (penyimpanan penuh atau diblokir, misalnya di mode privat). Buka AgentMon di jendela biasa, lalu pasangkan ulang dengan QR baru.",
  "pair.retry": "Coba lagi",
  "pair.back": "Kembali",
  "pair.missing.title": "Tautan pairing tidak ditemukan",
  "pair.missing.body": "Pindai ulang QR dari laptop (jalankan perintah pair), atau tempel tautannya di bawah.",

  "pair.ios.title": "Pasang ke layar utama dulu",
  "pair.ios.body": "Di iPhone dan iPad, aplikasi di layar utama menyimpan data terpisah dari Safari. Supaya pairing tidak hilang, tambahkan AgentMon ke layar utama dulu, lalu pasangkan dari aplikasi itu.",
  "pair.ios.step1": "Ketuk tombol Bagikan di Safari.",
  "pair.ios.step2": "Pilih Tambahkan ke Layar Utama.",
  "pair.ios.step3": "Buka AgentMon dari ikon di layar utama, lalu tempel tautan pairing.",
  "pair.ios.copy": "Salin tautan pairing",
  "pair.ios.copied": "Tautan disalin. Berlaku sekitar 5 menit sejak QR dibuat.",
  "pair.ios.copyFailed": "Tidak bisa menyalin otomatis. Tekan dan tahan tautan di bawah untuk menyalinnya.",
  "pair.ios.browserOnly": "Pasangkan di browser ini saja",
  "pair.ios.browserOnlyWarning": "Pairing akan hilang bila AgentMon ditambahkan ke layar utama atau data Safari dibersihkan.",
} as const;

export type MessageKey = keyof typeof id;
