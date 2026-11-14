# Aplikasi HP (PWA)

Kodenya di `packages/web/`. Aplikasi ini berjalan sepenuhnya di HP (React, Vite, Tailwind CSS) dan bisa dipasang ke layar utama seperti aplikasi biasa. Sekarang isinya: kerangka (bilah atas, pita offline, tombol tema), beranda yang mendaftar laptop terpasang, dan layar pairing. Beranda mendaftar laptop beserta sesinya, dan tiap sesi membuka timeline real-time.

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
- **Service worker** (`src/sw.ts`, ditulis sendiri dan dibangun `vite-plugin-pwa` dengan strategi `injectManifest`): menyimpan semua berkas aplikasi saat pertama dibuka. Setelah itu kerangka terbuka tanpa jaringan, termasuk alamat seperti `/pair#...` (semua navigasi dijawab `index.html`). Versi baru mengganti yang lama otomatis.
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

## Daftar sesi dan timeline real-time

- **Beranda** mendaftar laptop terpasang (online atau offline) beserta sesinya (agent, aktif atau selesai, waktu). Sesi baru dari event langsung muncul di atas tanpa memuat ulang. Tiap sesi adalah tautan ke `/s/<laptop>/<sesi>`.
- **Timeline** menampilkan event sesi berurutan, dengan tampilan per jenis event (permintaan izin menonjol, kegagalan merah, rekap, dan seterusnya) dalam Bahasa Indonesia atau Inggris. Jenis event yang belum dikenal (dari daemon yang lebih baru) tampil secara umum, tidak membuat layar gagal. Isi event dari agent dibersihkan dari karakter kontrol dan pembalik arah tulisan, dijadikan satu baris, dan dipotong.
- **Real-time**: HP membuka WebSocket ke relay (`src/relay/connection.ts`) dan menerima event begitu laptop mengirimnya. Sambung ulang otomatis; saat halaman terlihat lagi (HP dibuka dari kunci) atau jaringan kembali, sambungan **dibuka ulang langsung**, karena soket bisa sudah mati diam-diam selama HP terkunci.
- **Menambal yang terlewat** (`src/relay/relay-store.ts`): setiap kali koneksi siap, daftar laptop dan sesi diambil ulang, dan event sesi yang terbuka diambil mulai dari titik "sudah sinkron dari riwayat". Titik itu sengaja TERPISAH dari event langsung: event langsung bernomor tinggi yang tiba lebih dulu tidak boleh membuat event yang terlewat di bawahnya dilompati. Event dari dua jalur digabung tanpa ganda dan berurutan menurut `seq`.
- **Status koneksi** di header: Tersambung, Menyambung, Terputus, atau Perangkat dicabut (token ditolak relay; tidak mencoba lagi). Perubahannya diumumkan ke pembaca layar.
- **Sesi besar**: hanya 150 event terbaru yang digambar; sisanya dimuat bertahap lewat tombol, dengan posisi baca dijaga. Bila pengguna di bagian bawah, layar mengikuti event baru; bila membaca ke atas, muncul tombol "N event baru". Event hanya disimpan di memori untuk sesi yang sedang dibuka.

## Yang sudah dan belum diuji

- Diuji otomatis: logika tema dan bahasa, tampilan (jsdom), manifest dan ikon, serta hasil build sungguhan (manifest, daftar berkas yang disimpan service worker, ukuran bundle).
- Diuji manual di Microsoft Edge (Chromium) dengan emulasi HP: service worker aktif dan mengendalikan halaman, semua berkas tersimpan, tidak ada galat manifest atau installability, kerangka terbuka saat offline termasuk di alamat `/pair`, dan pilihan tema bertahan setelah muat ulang.
- Daftar sesi dan timeline diuji ujung-ke-ujung di Edge dengan viewport HP, relay sungguhan (PGlite), dan **klien daemon sungguhan** dari paket bridge: latensi dari daemon ke layar median 10 ms dan p95 19 ms (target PRD: p95 di bawah 2 detik), 40 event yang terlewat saat HP offline muncul lengkap, berurutan, dan tanpa ganda setelah HP dibuka, dan sesi 1.500 event membuat hanya sekitar 790 elemen DOM dengan gulir stabil di 10 ms per bingkai.
- Diuji ujung-ke-ujung di Edge dengan relay sungguhan (PGlite) dan viewport HP: QR sampai terhubung, token hasil pairing diterima relay sebagai HP, kode terpakai ditolak, laptop kedua dengan perangkat yang sama, bekerjanya alur iOS (panduan, salin tautan, tempel di aplikasi dengan penyimpanan kosong), dan alamat selalu bersih dari kode.
- **Belum diuji di perangkat nyata** (Android dan iOS): proses "Tambahkan ke layar utama", tampilan ikon, perilaku offline di sana, dan terutama **pemisahan penyimpanan iOS**, yang di sini hanya disimulasikan lewat penyimpanan kosong dan `navigator.standalone`. Kriteria "pengguna iOS tidak kehilangan pairing setelah menambahkan ke layar utama" perlu dicoba di iPhone sungguhan. Di iOS, PWA hanya bisa dipasang dari Safari (iOS 16.4 ke atas). Panduan install sesuai perangkat (FR-54) dikerjakan di issue lain.

- **Antrean izin dan layar keputusan** (`src/approvals/`): izin menunggu tampil di atas beranda dengan sisa waktu, yang berisiko tinggi di atas. Layar keputusan (`/a/<laptop>/<izin>`) menampilkan perintah shell UTUH, bidang input, dan diff sebagai teks polos. Karakter kontrol atau pembalik arah tulisan di dalamnya TIDAK dibuang tetapi ditampilkan sebagai kode (`\u202e`), supaya yang disetujui sama dengan yang terlihat. Tombol Setujui/Tolak (Tolak dengan alasan) mati saat keputusan sedang jalan, sudah selesai, atau waktu habis. Statusnya dijelaskan: dikirim, berhasil, dikalahkan perangkat lain, kedaluwarsa, atau gagal (dengan tombol coba lagi). Bila tidak ada konfirmasi dari laptop dalam 20 detik, status "belum terkonfirmasi" dan keputusan tidak dianggap berhasil.
- Belum diuji di HP nyata maupun di browser sungguhan untuk fitur ini: diuji dengan tes unit dan jsdom.

- **Perangkat** (`/devices`, tautan "Perangkat dan akses" di beranda): daftar perangkat yang berbagi laptop dengan HP ini, perangkat sendiri ditandai, dan tombol Cabut dengan konfirmasi (ketukan kedua; mencabut diri sendiri diberi peringatan lebih tegas). Pencabutan berlaku seketika di relay. Mencabut diri sendiri membuat PWA menampilkan "Perangkat dicabut" dan perlu QR baru. Diuji dengan tes jsdom; belum dicoba di HP nyata.

- **Rollback** (`/r/<laptop>/<checkpoint>`, dari tautan "Kembalikan ke sini" di event checkpoint): layar meminta pratinjau dari laptop setelah koneksi siap (sekali, tidak diulang saat tersambung ulang), menampilkan berkas yang akan dibuat lagi, dikembalikan, atau dihapus (jalur ditampilkan dengan karakter berbahaya sebagai kodenya), hal yang tidak bisa dibatalkan, lalu konfirmasi dua ketukan. Tombol mati bila agent masih berjalan. Setelah berhasil ada tautan "Batalkan rollback". Perintah umum dikirim lewat `store.request`, yang menunggu balasan bernomor perintah yang sama dan melaporkan offline, laptop mati, ditolak, atau waktu habis (60 detik). Detail alur di `docs/daemon.md`. Diuji dengan jsdom; belum dicoba di HP nyata.

## Penampil diff (`src/diff/`)

Layar keputusan menampilkan diff dengan penampil yang dimuat belakangan (`React.lazy`, `LazyDiffViewer`). Selama kodenya belum siap, atau bila gagal dimuat (mis. offline dan belum tersimpan), teks diff biasa yang sama tampil, jadi isi yang akan disetujui selalu terbaca; penampil hanya mengganti tampilannya.

**Pilihan pustaka (perbandingan yang diminta issue 024).** Dua kandidat di PRD dibandingkan dari data paket npm (bukan diukur di HP): `diff2html` 3.4.56 (±2,0 MB tak terkompres, bergantung pada `diff` dan `@profoundlogic/hogan`, bekerja dari teks unified diff) dan `react-diff-view` 3.3.3 (±1,5 MB, bergantung pada `lodash`, `diff-match-patch`, `gitdiff-parser`, dan lainnya, juga bekerja dari teks unified diff). Keduanya mengurai TEKS diff, padahal daemon sudah mengirim hunk terstruktur (`FileDiff`: hunk, baris, nomor baris, id hunk), dan keduanya membawa banyak dependensi yang harus dipantau (aturan umur paket, pembaruan). Maka penampil ditulis sendiri tanpa dependensi baru: tiap hunk adalah komponen mandiri (`Hunk`) yang nanti dipakai ulang untuk swipe per hunk (issue 040). Perbandingan memakai ukuran paket npm tak terkompres, BUKAN ukuran bundle setelah tree-shaking, jadi hanya indikasi. Ukuran kode penampil: sekitar 6,5 KB (2,3 KB gzip) dan pewarna 2,1 KB (1,0 KB gzip), keduanya di luar bundle awal. Yang belum dilakukan: membandingkan keterbacaan kedua pustaka di HP nyata.

**Fitur:** judul hunk `@@ -a,b +c,d @@`, nomor baris lama dan baru, penanda +/- (pembaca layar mendapat kata "Ditambah"/"Dihapus"), navigasi antar hunk (sebelumnya/berikutnya dengan penunjuk posisi) dan antar berkas, opsi membungkus baris panjang (BAWAAN: dibungkus, supaya yang akan disetujui terlihat utuh seperti pada teks cadangan; mematikannya membuat hunk bisa digulir ke samping), peringatan path sensitif paling atas, dan jenis non-teks (biner, terlalu besar, tidak cocok) sebagai keterangan. Karakter kontrol atau pembalik arah tulisan di baris ditampilkan sebagai kodenya (`\u202e`), tidak dibuang. Diff yang melebihi 1.500 baris menampilkan 1.500 dulu: ada pemberitahuan "N baris belum ditampilkan" di atas, penanda di akhir hunk yang terpotong, tombol yang menyebut jumlah tersembunyi, dan navigasi ke hunk yang belum digambar menaikkan anggaran lebih dulu. Menyetujui diff yang belum terlihat seluruhnya tetap dimungkinkan, tetapi pengguna diberi tahu.

**Warna sintaks** (`highlight.ts`) memecah baris yang sudah di-escape menjadi kata kunci, string, angka, dan komentar (JS/TS dan keluarganya, Python, CSS, JSON, shell). Modul ini dimuat setelah penampil tampil, jadi teks sudah terbaca sebelum warna siap. Warna bantuan baca saja: tanpa ingatan antar baris (komentar atau string berbaris-baris tidak diwarnai utuh), baris lebih dari 2.000 karakter tidak diwarnai, dan warna tidak pernah dipakai untuk keputusan keamanan.

**Bukan bundle awal (diperiksa otomatis).** `pnpm check:size` kini juga gagal bila penanda penampil ada di JS awal, atau tidak ditemukan di berkas JS mana pun. JS awal saat ini sekitar 121 KB gzip dari batas 200 KB.

**Diukur di browser (Edge, viewport 390x844, build produksi, diff 1.000 baris)**, dengan perlambatan CPU sebagai pengganti HP kelas menengah (bukan perangkat nyata):

| CPU | Waktu gambar awal | Gulir: median / p95 antar bingkai |
|---|---|---|
| 1x | 303 ms | 16,7 / 25,9 ms |
| 4x lebih lambat | 612 ms | 16,8 / 51,6 ms |
| 6x lebih lambat | 1.590 ms | 16,5 / 76,7 ms |

Diff 1.500 baris pada 4x: 933 ms, gulir p95 76,5 ms. Jumlah elemen DOM besar (±9.500 untuk 1.000 baris), dan penghematannya (`content-visibility` per hunk sudah dipakai) belum dioptimalkan lebih jauh. **Belum diuji di HP nyata** (Android dan iOS); angka di atas adalah emulasi, dan sudah termasuk pewarnaan (modul warna dimuat setelah gambar awal). Kriteria "responsif di HP kelas menengah" karena itu baru terpenuhi lewat emulasi; pengujian di perangkat nyata dikerjakan di issue 029. Pewarna sempat kuadratik pada baris yang berakhir dengan satu backslash setelah banyak tanda kutip (ditemukan di review, diperbaiki, dijaga tes).

- **Ringkasan perubahan** (`src/approvals/DiffSummaryView.tsx`): di layar keputusan, bagian "Ringkasan perubahan" tampil DI ATAS diff. Komponennya ada di bundle awal (bukan lazy), jadi terbaca tanpa memuat penampil diff, dan tetap tampil walau diff-nya tidak dikirim karena terlalu besar. Kalimat disusun dari data daemon lewat i18n; hal yang ditulis hanya yang terbukti dari diff (lihat `docs/daemon.md`). Diuji dengan jsdom.

## Notifikasi push (`src/push/`, `src/sw.ts`)

Kartu "Notifikasi" di beranda mengaktifkan push untuk HP ini. Backend-nya ada di relay (lihat `relay.md`, bagian Web Push).

**Service worker kustom.** Service worker bawaan `vite-plugin-pwa` tidak bisa menangani `push` dan `notificationclick`, jadi `src/sw.ts` ditulis sendiri dengan perilaku cache yang sama (precache, navigasi dijawab `index.html`, versi baru langsung mengambil alih) ditambah dua penanganan. Isinya tipis; logika yang bisa diuji ada di `push/notification.ts` dan `push/sw-logic.ts`. Ukurannya bertambah (sekitar 43 KB gzip, sebagian besar zod dan kamus teks karena memakai skema dan teks yang sama dengan aplikasi); service worker tidak dihitung dalam batas JS awal 200 KB.

**Setiap push selalu menampilkan notifikasi** (FR-32). Isi kosong, rusak, atau dari versi lain tetap menampilkan notifikasi umum "AgentMon: Ada pembaruan". Di iOS dan Chrome, push yang tidak menampilkan apa pun membuat izin dicabut atau memunculkan notifikasi "situs diperbarui di latar belakang". Teks disusun di HP dari jenis push (izin, selesai, uji), karena kiriman relay hanya berisi jenis dan nomor (FR-34).

**Mengetuk notifikasi:**
- App **terbuka dan terlihat**: jendelanya difokuskan lalu diminta pindah layar lewat pesan (`agentmon:navigate`), tanpa memuat ulang.
- App ada tetapi **tidak terlihat** (tersembunyi di latar, dibekukan, atau dibuang OS, yang sering terjadi di Android): halamannya mungkin tidak mendengarkan pesan, jadi alamat tujuan dimuat langsung di jendela itu (`WindowClient.navigate`). Bila itu ditolak (jendela tidak dikendalikan service worker), pesan dikirim sebagai cadangan. Perilaku ini belum dibuktikan di perangkat nyata.
- App **tertutup**: jendela baru dibuka langsung di layar tujuan: izin ke `/a/<laptop>/<izin>`, selesai ke `/s/<laptop>/<sesi>`, selain itu beranda.
- Tujuan dibangun dari nomor yang di-encode dan diperiksa sebagai jalur internal (`isSafePath`): tidak pernah dari alamat yang dikirim relay, dan "//host", alamat penuh, serta karakter berbahaya jatuh ke beranda.

**Alur izin** (`push/subscribe.ts`):
- Izin diminta **hanya dari ketukan tombol "Aktifkan"**, dan sebelum menunggu apa pun (Safari iOS menolak meminta izin tanpa gestur). Tidak pernah otomatis saat halaman dibuka.
- **iOS di tab Safari**: izin tidak diminta sama sekali; yang tampil panduan "Tambahkan ke Layar Utama" (FR-55). Notifikasi hanya bisa diaktifkan dari aplikasi layar utama.
- **Izin ditolak**: aplikasi tidak bisa memintanya lagi, jadi hanya penjelasan cara membukanya di pengaturan browser atau HP yang tampil.
- **Niat pengguna adalah sumber kebenaran** (diingat di `localStorage`, kunci `agentmon.push`; hanya menyala setelah mengaktifkan berhasil). Pengguna yang sudah mengaktifkan lalu kehilangan langganannya (browser membuangnya, atau kunci VAPID relay berganti) dipulihkan diam-diam saat kartu dibuka, karena izin dan niatnya sudah ada. Pengguna yang sudah mematikan tidak pernah dinyalakan lagi: langganan yang tertinggal di browser (mis. `unsubscribe` gagal saat dimatikan) dibuang, bukan didaftarkan ulang. Bila `localStorage` dibersihkan sendirian, niat hilang dan kartu menampilkan belum aktif sampai pengguna mengetuk Aktifkan lagi (data situs yang dibersihkan seluruhnya juga menghapus langganan dan izinnya).
- **Berlangganan menunggu service worker AKTIF.** `getRegistration()` sudah mengembalikan registrasi selama service worker masih dipasang, tetapi `pushManager.subscribe()` menolak sebelum ia aktif. Itu terjadi pada pemakaian pertama (mis. iOS yang baru menambahkan app ke layar utama lalu langsung mengetuk Aktifkan), jadi ditunggu sampai 10 detik (setelah izin didapat, supaya gestur ketukan tetap utuh); bila tidak kunjung aktif, kartu menyarankan menutup dan membuka ulang aplikasi.
- **Sinkron ke relay sekali per sesi per alamat langganan**: tiap PUT menulis ke database relay dan memakai jatah laju HP, jadi membuka beranda berkali-kali tidak mengirim ulang (catatan hilang saat halaman dimuat ulang).

### Keterbatasan
- **Belum diuji di HP sungguhan** (issue uji perangkat nyata). Yang teruji: logika (isi notifikasi, tujuan ketukan, alur izin per keadaan, perangkaian `sw.ts` dengan lingkungan service worker tiruan, dan hasil build), bukan perilaku Android atau iOS asli, mis. apakah Safari benar-benar menampilkan dialog izin dari ketukan itu.
- **Belum ada pemicu dari relay** (issue pemicu notifikasi): notifikasi baru bisa dicoba dengan `push:test` di relay, dan baru bisa diaktifkan bila relay sudah diberi kunci VAPID.
- **Satu browser, satu relay.** Langganan push terikat ke satu kunci VAPID, jadi kartu hanya terhubung ke relay pertama bila ada beberapa. Bila relay itu dicabut, kartu menampilkan pesan galat umum, bukan alasan khusus.
- **Bahasa notifikasi mengikuti bahasa perangkat**, bukan pilihan bahasa di app: service worker tidak bisa membaca `localStorage`.
- Karena pairing di iOS terpisah antara Safari dan aplikasi layar utama (lihat bagian Pairing), notifikasi harus diaktifkan dari aplikasi layar utama yang sudah dipasangkan.
