# Deploy staging dan pengembangan lokal dengan tunnel

Service worker dan Web Push hanya bekerja lewat HTTPS, jadi relay dan PWA perlu alamat HTTPS publik. Dokumen ini memuat dua jalur: **staging** (Render + Neon + Cloudflare Pages, sesuai PRD §15) dan **tunnel** untuk pengembangan di laptop.

> **Status jujur:** isi repo (cetak biru, perintah, pemeriksa rahasia, pengukur waktu bangun) sudah ada dan diuji di sini. Pembuatan akun, layanan, dan deploy pertama dilakukan pemilik proyek, karena butuh akun dan rahasia yang tidak ada di repo. Waktu bangun relay sudah diukur di staging sungguhan (tabel di bagian 4); tambahan: relay bangun lewat HP sungguhan belum dicoba.

## 1. Staging

### Database (Neon)
1. Buat proyek Postgres di Neon (free tier), salin *connection string* (`postgres://...`). Itu rahasia: jangan ditulis di repo, chat, atau log.
2. Migrasi tidak perlu dijalankan manual: relay menjalankannya sendiri saat menyala bila `DATABASE_URL` diisi (aman diulang, hanya migrasi yang belum diterapkan yang dijalankan). Manual bila perlu: `DATABASE_URL=... pnpm --filter @agentmon/server db:migrate`.

### Relay (Render)
1. Di Render pilih **New > Blueprint**, hubungkan repo ini. Berkas [`render.yaml`](../render.yaml) membuat layanan `agentmon-relay` (free, deploy otomatis dari `main`, pemeriksaan `/health`).
2. Isi dua variabel yang sengaja kosong di cetak biru, langsung di dashboard Render (bukan di repo):
   - `DATABASE_URL`: alamat Postgres dari Neon.
   - `PAIRING_ALLOWED_ORIGINS`: alamat PWA, misalnya `https://agentmon.pages.dev` (beberapa alamat dipisah koma).
3. `TRUST_PROXY=1` sudah diatur di cetak biru, karena Render berada di depan relay (alamat IP penelepon dibaca dari `X-Forwarded-For`).
   - **Web Push (opsional, dibutuhkan sebelum notifikasi bisa dicoba):** **tambahkan** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, dan `VAPID_SUBJECT` lewat dashboard Render (Environment > Add). Variabel ini sengaja tidak ditulis di `render.yaml`: menambah variabel `sync: false` baru ke Blueprint yang sudah berjalan belum diuji di Render, dan jangan sampai menahan deploy relay. Buat kuncinya sendiri di laptop dengan `pnpm --filter @agentmon/server push:keys` (kunci pribadi ikut tercetak: tempel langsung ke dashboard, jangan ke chat atau repo). `VAPID_SUBJECT` berisi alamat PWA (mis. `https://agentmon.pages.dev`) atau `mailto:` kontak Anda. Tanpa ketiganya relay tetap jalan dan hanya push yang mati; log menyebut alasannya bila salah isi. Detail di [`relay.md`](relay.md#web-push).
4. Setiap push ke `main` men-deploy ulang (migrasi ikut berjalan saat relay menyala).
5. **Bila migrasi gagal** (mis. Neon tidak terjangkau atau melewati batas waktu), relay berhenti dengan kode keluar 1 dan tidak melayani apa pun: deploy ditandai gagal, dan bila terjadi saat bangun dari tidur relay tetap mati sampai dijalankan ulang. Gejalanya: `/health` tidak menjawab dan log Render memuat "Migrasi gagal". Pemulihan: periksa `DATABASE_URL` dan status Neon, lalu *Manual Deploy / Restart* di Render. Pesan galat tidak mencetak alamat database.
6. Belum diverifikasi di sini (dikerjakan pemilik saat deploy pertama): nama field `autoDeploy` di Blueprint Render (versi baru mungkin memakai `autoDeployTrigger`; `checksPass` lebih baik agar deploy menunggu CI hijau), dan apakah `corepack enable` berjalan di Render dan Cloudflare Pages (bila gagal EACCES, pasang pnpm dengan `npm i -g pnpm@12.16.1`).

### PWA (Cloudflare Pages)
1. Buat proyek Pages dari repo ini dengan: *build command* `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @agentmon/web build`, *output directory* `packages/web/dist`, variabel `NODE_VERSION=22`.
2. PWA tidak butuh alamat relay saat build: alamat relay dibawa oleh tautan pairing (QR) dan disimpan di perangkat.
3. Pakai alamat Pages itu sebagai `AGENTMON_APP_URL` di laptop dan sebagai `PAIRING_ALLOWED_ORIGINS` di relay.

### Laptop
```
AGENTMON_RELAY_URL=https://agentmon-relay.onrender.com
AGENTMON_RELAY_TOKEN=<token laptop di relay>
AGENTMON_APP_URL=https://agentmon.pages.dev
```
Catatan: pendaftaran laptop ke relay produksi (membuat baris dan token laptop) belum punya alur otomatis; lihat "Keterbatasan" di [`relay.md`](relay.md).

## 2. Rahasia tidak masuk repo
- Semua nilai rahasia hanya ada di dashboard layanan (Render, Neon, Cloudflare) atau di lingkungan laptop. Berkas `.env*` di-ignore git (kecuali `.env.example`).
- Cakupan terbatas: yang diperiksa hanya berkas yang dilacak git saat ini (riwayat commit TIDAK dipindai; rahasia yang pernah ter-commit harus dianggap bocor dan diganti), dan aturannya sempit (kunci pribadi, token GitHub, kunci AWS, alamat database berkata sandi, serta berkas `.env` yang terlanjur dilacak). Token relay dan kunci VAPID tidak punya pola yang bisa dikenali otomatis.
- `pnpm check:secrets` memindai berkas yang dilacak git untuk kunci pribadi, token GitHub/AWS, dan alamat database berkata sandi, dan dijalankan di CI. Ini jaring pengaman untuk kesalahan umum, bukan pengganti pemindai rahasia penuh.

## 3. Pengembangan lokal dengan tunnel
Berguna untuk mencoba PWA di HP sungguhan tanpa deploy, atau menguji service worker (butuh HTTPS).

1. Jalankan relay lokal. Mode pengembangan (tanpa database):
   ```
   RELAY_DEV_MACHINE_TOKEN=<acak 32+ karakter> RELAY_DEV_DEVICE_TOKEN=<acak 32+ karakter> pnpm --filter @agentmon/server start
   ```
   Atau dengan database lokal/Neon: isi `DATABASE_URL` (dan `PAIRING_ALLOWED_ORIGINS` dengan alamat tunnel PWA).
2. Jalankan PWA: `pnpm --filter @agentmon/web dev`.
3. Buka tunnel HTTPS untuk masing-masing port, misalnya dengan Cloudflare Tunnel:
   ```
   cloudflared tunnel --url http://localhost:8787   # relay
   cloudflared tunnel --url http://localhost:5173   # PWA
   ```
   (ngrok atau layanan serupa juga bisa.) Alamat `https://...trycloudflare.com` yang muncul dipakai sebagai `AGENTMON_RELAY_URL` dan `AGENTMON_APP_URL`.
4. Alamat tunnel gratis berubah tiap dijalankan; perbarui `PAIRING_ALLOWED_ORIGINS` dan pasangkan ulang bila alamatnya berganti.
5. Jangan menyalakan `AGENTMON_RELAY_INSECURE=1` kecuali untuk uji di jaringan tepercaya: relay tanpa enkripsi ditolak daemon untuk host selain komputer ini.

## 4. Mengukur waktu bangun relay
Free tier Render menidurkan layanan setelah beberapa menit idle; permintaan pertama menunggu relay bangun. Ukur dengan:

```
node tools/measure-wake.mjs https://agentmon-relay.onrender.com 20
```
Argumen kedua (menit) membuat skrip mengukur, menunggu sejumlah menit supaya relay tidur, lalu mengukur lagi, **berulang sampai dihentikan dengan Ctrl+C**. Tanpa argumen kedua, ia mengukur sekali. Skrip menunggu sampai `/health` menjawab 200 dan mencetak lamanya. Ukuran pertama belum tentu cold start (relay mungkin sedang bangun); yang bermakna adalah ukuran sesudah jeda panjang. Batas idle free tier Render (dikabarkan sekitar 15 menit) belum diverifikasi, jadi pilih jeda yang cukup panjang (mis. 20 menit atau lebih) dan catat hasil yang benar-benar tampak lambat.

| Tanggal | Layanan | Idle sebelum ukur | Waktu bangun |
|---|---|---|---|
| 2026-11-14 | Render free, Singapore | 20 menit | 52,3 detik |
| 2026-11-14 | Render free, Singapore | 20 menit | 41,8 detik |

Diukur dari satu laptop di Indonesia dengan `node tools/measure-wake.mjs <alamat> 20`: ukuran pertama (0,5 detik) bukan cold start karena relay baru dipakai, lalu dua ukuran dingin sesudah 20 menit tanpa permintaan. **Hanya dua sampel dari satu lokasi.** Batas idle sebelum Render menidurkan layanan tidak diverifikasi (jeda 20 menit sudah cukup untuk tidur; jeda yang lebih pendek belum dicoba), dan angka di jam sibuk atau dari lokasi lain bisa berbeda.

**Keputusan untuk staging:** waktu bangun sekitar 40 sampai 50 detik diterima. Event dari laptop tidak hilang (daemon menyimpan antrean dan mengirim ulang), dan pairing atau percobaan manual hanya menunggu sekali setelah relay lama tidak dipakai. Untuk dipakai sehari-hari angka ini terlalu lambat untuk notifikasi yang diharapkan cepat: HP baru diberi tahu setelah relay bangun, jadi izin pertama sesudah relay tidur bisa terlambat hampir satu menit. Opsi sebelum rilis (belum dipilih, butuh keputusan pemilik): paket berbayar yang tidak tidur, atau pemeriksa berkala dari luar yang menjaga relay tetap bangun (tidak diuji di sini, dan mungkin melanggar ketentuan free tier), atau memindahkan relay (PRD §15).

Dasar keputusan: PRD §15 mencatat free tier Render tidur saat idle dan menyebut paket kecil atau Cloudflare Workers + Durable Objects sebagai alternatif. Event dari laptop tidak hilang selama relay tidur (daemon menyimpan antrean dan mengirim ulang), tetapi HP baru menerima notifikasi setelah relay bangun; ukuran di atas menentukan apakah itu bisa diterima.
