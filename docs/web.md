# Aplikasi HP (PWA)

Kodenya di `packages/web/`. Aplikasi ini berjalan sepenuhnya di HP (React, Vite, Tailwind CSS) dan bisa dipasang ke layar utama seperti aplikasi biasa. Sekarang isinya baru **kerangka**: bilah atas, pita offline, tombol tema, dan satu layar kosong yang memandu pemasangan laptop. Layar pairing, daftar sesi, dan timeline diisi di issue berikutnya.

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

`scripts/check-bundle-size.ts` menghitung ukuran gzip JS yang dimuat langsung oleh `index.html` dan **gagal** bila mencapai 200 KB (PRD §14). Dijalankan di CI setelah build. Bagian yang dimuat belakangan (lazy), seperti penampil diff nanti, tidak dihitung. Saat ini JS awal sekitar 71 KB.

## Yang sudah dan belum diuji

- Diuji otomatis: logika tema dan bahasa, tampilan (jsdom), manifest dan ikon, serta hasil build sungguhan (manifest, daftar berkas yang disimpan service worker, ukuran bundle).
- Diuji manual di Microsoft Edge (Chromium) dengan emulasi HP: service worker aktif dan mengendalikan halaman, semua berkas tersimpan, tidak ada galat manifest atau installability, kerangka terbuka saat offline termasuk di alamat `/pair`, dan pilihan tema bertahan setelah muat ulang.
- **Belum diuji di perangkat nyata** (Android dan iOS): proses "Tambahkan ke layar utama", tampilan ikon, dan perilaku offline di sana. Di iOS, PWA hanya bisa dipasang dari Safari (iOS 16.4 ke atas) dan hanya dari layar utama yang bisa menerima notifikasi (tahap berikutnya). Panduan install sesuai perangkat (FR-54) dikerjakan di issue lain.
