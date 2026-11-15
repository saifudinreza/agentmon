# Matriks uji perangkat nyata (tahap 3)

Push, PWA, dan layar terkunci sulit diuji otomatis, jadi dicatat di sini apa yang **sudah terbukti di perangkat sungguhan** dan apa yang **belum diuji**. Berkas ini sengaja jujur: sel tanpa bukti ditulis "belum diuji", bukan ditebak lulus.

Perangkat yang sudah dipakai: satu iPhone (aplikasi dipasang di Layar Utama), relay produksi di Render, laptop Windows. Belum ada perangkat Android.

Legenda: **Lulus** (dicoba di perangkat nyata), **Belum diuji** (tidak ada bukti), **Gagal** (ada masalah, lihat catatan).

## Matriks

| # | Skenario | Perangkat | Hasil | Catatan |
|---|----------|-----------|-------|---------|
| 1 | Pasang ke Layar Utama dan buka sebagai aplikasi | iPhone | Lulus | Penyimpanan aplikasi Layar Utama terpisah dari Safari: pairing harus diulang di aplikasi itu. |
| 2 | Pairing lewat QR / tautan | iPhone | Lulus | Hanya di aplikasi Layar Utama; tautan yang dibuka di Safari tidak terbawa. |
| 3 | Minta izin notifikasi dan berlangganan | iPhone | Lulus | Hanya bisa dari aplikasi Layar Utama (aturan iOS). |
| 4 | Notifikasi uji dari relay tampil | iPhone | Lulus | |
| 5 | Notifikasi "izin dibutuhkan" dari Claude Code asli tampil dan ketukannya membuka aplikasi | iPhone | Lulus | Ketukan membuka aplikasi. Layar tujuan yang tepat (halaman izin) belum diperiksa satu per satu. |
| 6 | Notifikasi saat layar **terkunci / mati** | iPhone | **Belum diuji** | Penguji belum memeriksa. |
| 7 | Notifikasi saat aplikasi **tertutup** (dibuang dari pengalih aplikasi) | iPhone | **Belum diuji** | |
| 8 | Ketukan notifikasi saat aplikasi dibuang OS (cold start) | iPhone | **Belum diuji** | Jalur `openWindow` hanya diuji otomatis. |
| 9 | Penggabungan: banyak izin beruntun menjadi paling banyak dua notifikasi (tag per sesi) | iPhone | **Belum diuji** | Dibuktikan di tes otomatis; perilaku tag di iOS belum terbukti. |
| 10 | Notifikasi izin usang tertutup (diputuskan di perangkat lain) | iPhone | **Belum diuji** | `getNotifications()/close()` di iOS belum terbukti. |
| 11 | Pengaturan jenis notifikasi (izin, selesai) menyaring push | iPhone | **Belum diuji** | |
| 12 | Relay yang baru bangun (Render gratis tidur) | Relay | Lulus (terukur) | Bangun 52,3 dan 41,8 detik. Notifikasi pertama setelah relay tidur bisa terlambat selama itu. |
| 13 | Jaringan seluler (bukan Wi-Fi) | iPhone | **Belum diuji** | Tidak tercatat apakah uji sebelumnya lewat Wi-Fi atau seluler. |
| 14 | Pasang PWA, pairing, notifikasi | Android (Chrome) | **Belum diuji** | Tidak ada perangkat Android. |
| 15 | Notifikasi saat layar terkunci dan Doze/penghemat baterai | Android | **Belum diuji** | |
| 16 | Aplikasi dibuka tanpa Layar Utama (Safari biasa) | iPhone | **Belum diuji** | Perilaku (penjelasan perlu dipasang dulu) hanya terbukti di tes otomatis, bukan di perangkat. |

## Temuan dari pemakaian nyata (belum jadi issue)

Ditemukan saat uji hook asli. Belum dibuat menjadi issue GitHub; menunggu persetujuan.

1. Sesi tetap berstatus "Aktif" setelah agent selesai, karena `session.recap` belum dibuat (issue 041).
2. Teks "Agent berhenti" menampilkan markdown mentah.
3. Jalur berkas ditampilkan penuh (panjang di layar HP).
4. Banner "Claude Code login successful" muncul di keluaran hook.

## Yang tidak bisa diselesaikan tanpa pengguna

- **Pemakaian nyata minimal 3 hari** (tahap 4 di issue ini) hanya bisa dilakukan pengguna di perangkatnya sendiri.
- Sel bertanda "Belum diuji" butuh perangkat atau tindakan fisik (mengunci layar, menutup aplikasi, berpindah ke seluler, perangkat Android).

## Cara menjalankan sel yang belum diuji

Prasyarat: relay produksi aktif, laptop terdaftar dan daemon berjalan, aplikasi Layar Utama sudah dipairing dan notifikasi aktif.

1. **Layar terkunci (6):** kunci iPhone, jalankan perintah di Claude Code yang butuh izin. Catat: notifikasi tampil di layar kunci? Berapa detik setelah izin muncul?
2. **Aplikasi tertutup (7, 8):** geser aplikasi keluar dari pengalih aplikasi, picu izin, ketuk notifikasi. Catat: aplikasi terbuka di halaman izin yang benar?
3. **Penggabungan (9):** minta Claude Code menjalankan 5 perintah yang butuh izin berurutan di satu sesi. Catat: berapa notifikasi di layar?
4. **Usang (10):** picu izin, putuskan lewat laptop/perangkat lain, jangan buka aplikasi, picu izin lain 10+ menit kemudian. Catat: notifikasi lama hilang?
5. **Seluler (13):** matikan Wi-Fi HP, ulangi 6.
6. **Android (14, 15):** ulangi 1 sampai 8 di Chrome Android; catat dengan penghemat baterai menyala.

Setiap kegagalan dicatat sebagai issue baru, dan nomornya ditulis di kolom Catatan.
