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

  "conn.online": "Tersambung",
  "conn.connecting": "Menyambung…",
  "conn.offline": "Terputus",
  "conn.revoked": "Perangkat dicabut",
  "conn.revoked.body": "Perangkat ini sudah dicabut dari laptop. Pasangkan ulang dengan QR baru untuk melanjutkan.",
  "conn.label": "Status koneksi: {status}",

  "machine.online": "Online",
  "machine.offline": "Offline",
  "sessions.empty": "Belum ada sesi di laptop ini.",
  "sessions.loading": "Memuat sesi…",
  "sync.error": "Tidak bisa memperbarui daftar. Menampilkan data terakhir yang diketahui.",
  "session.agent.claude-code": "Claude Code",
  "session.agent.codex": "Codex",
  "session.status.active": "Aktif",
  "session.status.ended": "Selesai",
  "session.started": "Mulai {time}",
  "session.last": "terakhir {time}",

  "timeline.back": "Kembali",
  "timeline.title": "Sesi {agent}",
  "timeline.titleUnknown": "Sesi",
  "timeline.loading": "Memuat riwayat…",
  "timeline.empty": "Belum ada event di sesi ini.",
  "timeline.earlier": "Muat {count} event sebelumnya",
  "timeline.new": "{count} event baru",
  "timeline.count": "{count} event",
  "timeline.error": "Riwayat tidak bisa dimuat. Periksa jaringan Anda, lalu coba lagi.",
  "timeline.retry": "Coba lagi",
  "timeline.notFound": "Sesi atau laptop ini tidak ditemukan.",
  "timeline.list": "Riwayat event sesi",

  "event.unknown": "Event {type}",
  "event.session.started": "Sesi dimulai",
  "event.tool.requested": "Menjalankan {tool}",
  "event.tool.completed.ok": "{tool} selesai",
  "event.tool.completed.failed": "{tool} gagal",
  "event.approval.requested": "Menunggu keputusan: {tool}",
  "event.approval.resolved.approved": "Disetujui",
  "event.approval.resolved.partially_approved": "Disetujui sebagian",
  "event.approval.resolved.denied": "Ditolak",
  "event.approval.resolved.timed_out": "Waktu habis",
  "event.approval.resolved.cancelled": "Dibatalkan",
  "event.approval.auto_approved": "Disetujui otomatis: {tool}",
  "event.approval.auto_denied": "Ditolak otomatis: {tool}",
  "event.agent.notification": "Pemberitahuan agent",
  "event.agent.stopped": "Agent berhenti",
  "event.turn.review_requested": "{count} berkas siap direview",
  "event.checkpoint.created": "Checkpoint dibuat",
  "event.checkpoint.restored": "Checkpoint dipulihkan",
  "event.session.recap": "Rekap: {minutes} menit, {files} berkas berubah, {rejected} ditolak, {auto} otomatis",
} as const;

export type MessageKey = keyof typeof id;
