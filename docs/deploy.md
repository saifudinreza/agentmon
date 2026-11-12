# Deploy staging dan pengembangan lokal dengan tunnel

Service worker dan Web Push hanya bekerja lewat HTTPS, jadi relay dan PWA perlu alamat HTTPS publik. Dokumen ini memuat dua jalur: **staging** (Render + Neon + Cloudflare Pages, sesuai PRD §15) dan **tunnel** untuk pengembangan di laptop.

> **Status jujur:** isi repo (cetak biru, perintah, pemeriksa rahasia, pengukur waktu bangun) sudah ada dan diuji di sini. Pembuatan akun, layanan, dan deploy pertama dilakukan pemilik proyek, karena butuh akun dan rahasia yang tidak ada di repo. Angka waktu bangun di bawah kosong sampai diukur di staging sungguhan.

## 1. Staging

### Database (Neon)
1. Buat proyek Postgres di Neon (free tier), salin *connection string* (`postgres://...`). Itu rahasia: jangan ditulis di repo, chat, atau log.
2. Migrasi tidak perlu dijalankan manual: perintah start relay menjalankannya dulu (aman diulang, hanya migrasi yang belum diterapkan yang dijalankan). Manual bila perlu: `DATABASE_URL=... pnpm --filter @agentmon/server db:migrate`.

### Relay (Render)
1. Di Render pilih **New > Blueprint**, hubungkan repo ini. Berkas [`render.yaml`](../render.yaml) membuat layanan `agentmon-relay` (free, deploy otomatis dari `main`, pemeriksaan `/health`).
2. Isi dua variabel yang sengaja kosong di cetak biru, langsung di dashboard Render (bukan di repo):
   - `DATABASE_URL`: alamat Postgres dari Neon.
   - `PAIRING_ALLOWED_ORIGINS`: alamat PWA, misalnya `https://agentmon.pages.dev` (beberapa alamat dipisah koma).
3. `TRUST_PROXY=1` sudah diatur di cetak biru, karena Render berada di depan relay (alamat IP penelepon dibaca dari `X-Forwarded-For`).
4. Setiap push ke `main` men-deploy ulang dan menjalankan migrasi.

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
Argumen kedua (menit) membuat skrip mengukur, menunggu sejumlah menit supaya relay tidur lagi, lalu mengukur ulang. Tanpa argumen kedua, ia mengukur sekali. Skrip menunggu sampai `/health` menjawab 200 dan mencetak lamanya.

| Tanggal | Layanan | Idle sebelum ukur | Waktu bangun |
|---|---|---|---|
| (belum diukur) | | | |

Dasar keputusan: PRD §15 mencatat free tier Render tidur saat idle dan menyebut paket kecil atau Cloudflare Workers + Durable Objects sebagai alternatif. Event dari laptop tidak hilang selama relay tidur (daemon menyimpan antrean dan mengirim ulang), tetapi HP baru menerima notifikasi setelah relay bangun; ukuran di atas menentukan apakah itu bisa diterima.
