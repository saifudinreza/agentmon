# Aplikasi HP (PWA)

Kodenya di `packages/web/`. Aplikasi ini berjalan sepenuhnya di HP (React, Vite, Tailwind CSS) dan bisa dipasang ke layar utama seperti aplikasi biasa. Sekarang isinya: kerangka (bilah atas, pita offline, tombol tema), beranda yang mendaftar laptop terpasang, dan layar pairing. Daftar sesi dan timeline diisi di issue berikutnya.

## Menjalankan

```bash
pnpm --filter @agentmon/web dev        # mode pengembangan (tanpa service worker)
pnpm --filter @agentmon/web build      # build produksi ke packages/web/dist
pnpm --filter @agentmon/web preview    # melayani hasil build (di sini service worker aktif)
pnpm --filter @agentmon/web check:size # menimbang JS awal (harus < 200 KB gzip)
```

Service worker hanya aktif di build produksi. Untuk mencoba offline: `build`, `preview`, buka di browser, muat ulang sekali, lalu putuskan jaringan di DevTools.

## Bisa dipasang dan dibuka offline

- **Manifest** (`src/pwa/manifest.ts`): nama, ikon, mode layar penuh (`standalone`), warna. Dibangun menjadi `manifest.webmanifest`.
- **Service worker** (dibuat `vite-plugin-pwa`): menyimpan semua berkas aplikasi saat pertama dibuka. Setelah itu kerangka terbuka tanpa jaringan, termasuk alamat seperti `/pair#...` (semua navigasi dijawab `index.html`). Versi baru mengganti yang lama otomatis.
- **Ikon** (`public/icons/`): dibuat oleh `scripts/make-icons.ts` (`pnpm --filter @agentmon/web icons`) dan ikut di-commit. Ada versi biasa, *maskable* (untuk Android), dan `apple-touch-icon` (iOS). Test memastikan ikon yang di-commit sama dengan hasil skrip.
- **Pita offline**: muncul di bawah bilah atas saat HP kehilangan jaringan.

## Tata letak dan tema

Mobile-first: satu kolom, tombol minimal 44 piksel, jarak aman untuk notch iPhone (`env(safe-area-inset-*)`), lebar dibatasi di layar besar. Tema ada tiga pilihan: otomatis (mengikuti HP), terang, gelap. Pilihan disimpan di perangkat. Skrip kecil di `index.html` memasang tema sebelum halaman digambar supaya tidak berkedip; test memastikan hasilnya sama dengan `resolveTheme`.

Warna dipakai lewat nama peran (`bg`, `surface`, `fg`, `muted`, `line`, `accent`) yang didefinisikan di `src/styles.css`.

## Bahasa (i18n)

Semua teks lewat `t("kunci")`; tidak ada teks langsung di komponen. Bahasa bawaan Indonesia (`src/i18n/id.ts`). Inggris (`en.ts`) sudah siap sebagai kerangka. TypeScript menolak bila `en.ts` kehilangan atau kelebihan kunci dibanding `id.ts`. Menambah bahasa: salin `en.ts`, terjemahkan, lalu daftarkan di `LOCALES` dan `dictionaries` (`src/i18n/i18n.ts`). Pemilih bahasa di layar belum ada; itu masuk layar Pengaturan.

## Batas ukuran

`scripts/check-bundle-size.ts` menghitung ukuran gzip JS yang dimuat langsung oleh `index.html` dan **gagal** bila mencapai 200 KB (PRD §14). Dijalankan di CI setelah build. Bagian yang dimuat belakangan (lazy), seperti penampil diff nanti, tidak dihitung. Saat ini JS awal sekitar 103 KB.

## Pairing di HP

Laptop menjalankan `pair` dan menampilkan QR berisi `https://<pwa>/pair#c=<kode>&r=<relay>`. HP memindainya dan:

1. **Membaca tautan** dari fragmen alamat, lalu **langsung menghapus fragmen dari alamat browser**. Kode hanya hidup di memori, jadi tidak tertinggal di bilah alamat atau di riwayat tab. Memuat ulang layar itu memang membuang kodenya.
2. **Meminta konfirmasi.** Pairing tidak berjalan otomatis: layar menampilkan relay yang akan dipakai dan nama perangkat, supaya tautan buatan orang lain tidak memasangkan HP diam-diam. Relay tanpa enkripsi (selain `localhost`) ditolak sebelum menghubungi siapa pun.
3. **Menukar kode** ke relay (`POST /pair/redeem`) dan menyimpan token perangkat di `localStorage` (`src/pairing/storage.ts`). HP yang sudah punya token di relay yang sama mengirimkannya, sehingga laptop kedua dipasangkan ke perangkat yang sama. Token yang sudah dicabut dibuang dan penukaran diulang sekali sebagai perangkat baru.
4. **Menampilkan hasil**: berhasil, kode kedaluwarsa atau sudah dipakai (relay sengaja tidak membedakannya), terlalu banyak percobaan, relay tidak terjangkau, tidak bisa disimpan (mode privat atau penyimpanan penuh), dan gagal.

Memindai QR lain saat layar pairing sudah terbuka (misalnya QR laptop kedua) memulai alur baru dan tetap membersihkan alamat.

Agar HP bisa memanggil relay dari alamat PWA yang berbeda, isi `PAIRING_ALLOWED_ORIGINS` di relay dengan asal PWA (misalnya `https://app.contoh.com`). Untuk mencoba secara lokal: jalankan relay dengan `PAIRING_ALLOWED_ORIGINS=http://localhost:4173` dan buka hasil `pnpm preview`.

### iOS: penyimpanan Safari dan aplikasi layar utama terpisah

Aplikasi yang ditambahkan ke layar utama iOS menyimpan data **terpisah** dari Safari. QR selalu terbuka di Safari, jadi pairing yang dibuat di tab Safari tidak ikut terbawa ke aplikasi layar utama yang dipasang sesudahnya (penggunanya melihat aplikasi kosong). Penanganannya:

- Di iOS yang masih di tab Safari, **pairing ditunda** dan kodenya belum ditukar. Layar memandu: tambahkan ke layar utama, lalu salin tautan pairing dengan satu tombol.
- Di aplikasi layar utama, pengguna menempelkan tautan itu di kolom "Tempel tautan pairing" (beranda atau layar pairing) dan pairing berjalan di sana, sehingga tersimpan di penyimpanan aplikasi itu.
- Ada jalan pintas "Pasangkan di browser ini saja" dengan peringatan jelas, untuk pengguna yang memang tidak akan memasang aplikasi.
- Di Android, tab Chrome dan aplikasi yang dipasang berbagi penyimpanan, sehingga pairing langsung berjalan.

Kode berlaku sekitar 5 menit sejak QR dibuat, jadi langkah memasang lalu menempelkan harus selesai dalam waktu itu; bila lewat, jalankan `pair` lagi di laptop. Solusi tanpa menyalin tautan (misalnya memindai QR dari dalam aplikasi lewat kamera) bisa ditambahkan nanti.

## Yang sudah dan belum diuji

- Diuji otomatis: logika tema dan bahasa, tampilan (jsdom), manifest dan ikon, serta hasil build sungguhan (manifest, daftar berkas yang disimpan service worker, ukuran bundle).
- Diuji manual di Microsoft Edge (Chromium) dengan emulasi HP: service worker aktif dan mengendalikan halaman, semua berkas tersimpan, tidak ada galat manifest atau installability, kerangka terbuka saat offline termasuk di alamat `/pair`, dan pilihan tema bertahan setelah muat ulang.
- Diuji ujung-ke-ujung di Edge dengan relay sungguhan (PGlite) dan viewport HP: QR sampai terhubung, token hasil pairing diterima relay sebagai HP, kode terpakai ditolak, laptop kedua dengan perangkat yang sama, bekerjanya alur iOS (panduan, salin tautan, tempel di aplikasi dengan penyimpanan kosong), dan alamat selalu bersih dari kode.
- **Belum diuji di perangkat nyata** (Android dan iOS): proses "Tambahkan ke layar utama", tampilan ikon, perilaku offline di sana, dan terutama **pemisahan penyimpanan iOS**, yang di sini hanya disimulasikan lewat penyimpanan kosong dan `navigator.standalone`. Kriteria "pengguna iOS tidak kehilangan pairing setelah menambahkan ke layar utama" perlu dicoba di iPhone sungguhan. Di iOS, PWA hanya bisa dipasang dari Safari (iOS 16.4 ke atas). Panduan install sesuai perangkat (FR-54) dikerjakan di issue lain.
