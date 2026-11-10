# Relay AgentMon

Server perantara antara laptop (daemon) dan HP (PWA). Ia hanya **meneruskan** pesan, dan tidak memutuskan apa pun soal risiko, aturan, atau approval (semua kecerdasan ada di laptop, lihat PRD §7).

## Menjalankan (mode pengembangan)
```bash
RELAY_DEV_MACHINE_TOKEN=<acak> RELAY_DEV_DEVICE_TOKEN=<acak> pnpm --filter @agentmon/server start
```
Masing-masing token minimal 16 karakter. Contoh membuat token acak: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Variabel `PORT` mengatur port (bawaan `8787`).

Mode ini hanya untuk mencoba relay: direktori pemasangan ada di memori dengan **satu laptop (`dev-machine`) dan satu HP (`dev-device`)**, tanpa database. Versi sungguhan memakai database dan pairing lewat QR (issue berikutnya) dan menggantikan `main.ts`.

| Alamat | Fungsi |
|---|---|
| `GET /health` | Hanya `{ "status": "ok" }` untuk pemeriksaan hosting. Jumlah koneksi sengaja tidak dibuka (bahan pengintaian); statistik tersedia di dalam proses lewat `hub.stats()` |
| `WebSocket /ws` | Jalur pesan untuk laptop dan HP |

## Protokol
Bentuk bingkai didefinisikan di paket `shared` (`relay.ts`), jadi daemon dan PWA memakai bentuk yang sama. Semua bingkai berupa **teks JSON** dengan kolom `kind`.

**Klien ke relay**

| `kind` | Dari | Isi | Fungsi |
|---|---|---|---|
| `hello` | keduanya | `role` (`machine` atau `device`), `token` | **Pesan pertama.** Menyebut peran dan kata sandi. Token tidak boleh di alamat sambungan karena akan masuk log |
| `event` | laptop | `event` (amplop) | Diteruskan ke semua HP yang dipasangkan dan sedang tersambung |
| `command` | HP | `machineId`, `body` | Diteruskan ke satu laptop yang dipasangkan |

**Relay ke klien:** `welcome` (jawaban `hello` yang berhasil, berisi nomor), `event`, `command` (membawa `deviceId` pengirim), dan `error` (berisi `code` dan `message`).

Relay hanya memeriksa **amplop** event (`v`, `id`, `machineId`, `sessionId`, `seq`, `ts`, `agent`, `type`). `payload` dibiarkan apa adanya, karena mulai tahap 4 isinya terenkripsi dan relay tidak boleh membukanya. Yang diteruskan adalah **objek aslinya** setelah lolos validasi, bukan hasil parse, sehingga kolom amplop baru dari daemon versi lebih baru tidak hilang diam-diam saat lewat relay lama.

**Kode galat:** `invalid_json`, `invalid_frame`, `too_large`, `rate_limited`, `unauthenticated`, `unauthorized`, `already_authenticated`, `forbidden`, `target_offline`, `hello_timeout`, `idle_timeout`, `replaced`.

## Aturan yang dijaga
1. **Pesan hanya antara pihak yang dipasangkan.** Event laptop hanya sampai ke HP yang dipasangkan dengannya, dan perintah HP hanya sampai ke laptop yang dipasangkan dengannya. Pemasangan diperiksa pada **setiap pesan**, jadi pencabutan perangkat langsung berlaku tanpa memutus koneksi.
2. **Tidak bisa menyamar.** Laptop hanya boleh mengirim event dengan `machineId` miliknya sendiri. HP tidak boleh mengirim event, dan laptop tidak boleh mengirim perintah.
3. **Tidak membocorkan keberadaan.** Perintah ke laptop yang tidak ada dan ke laptop yang tidak dipasangkan dijawab sama (`forbidden`).
4. **Gagal tertutup.** Bila direktori error (misalnya database mati), `hello` ditolak, bukan diloloskan.
5. **Satu nomor, satu koneksi.** Koneksi baru dari pihak yang sama (misalnya setelah jaringan putus) menggantikan yang lama (`replaced`).
6. **Log tidak memuat isi pesan maupun token.** Hanya kejadian umum, peran, dan kode alasan.

## Batas
| Batas | Bawaan | Perilaku bila dilanggar |
|---|---|---|
| Ukuran pesan | 1 MiB | Ditolak dan koneksi ditutup (kode 1009). Soket menutup **sebelum** seluruh pesan dibaca ke memori. Server dan koneksi lain tidak terganggu |
| Laju pesan | lonjakan 100, rata-rata 50 per detik per koneksi | `rate_limited`; bila 5 kali berturut-turut, koneksi diputus (1008) |
| Menyebut `hello` | 5 detik setelah tersambung | Ditutup (`hello_timeout`, 4002) |
| Tanda hidup | ping tiap 30 detik, batas diam 70 detik | Ditutup (`idle_timeout`, 4004) dan dibersihkan |
| Antrean kirim satu penerima | 8 MiB | Penerima yang membaca terlalu lambat diputus (4006, `slow_consumer`) alih-alih menumpuk pesan di memori relay. Ia bisa menyambung lagi |

Penyapuan koneksi berjalan **lebih rapat daripada ping** (setengah batas `hello`, jadi 2,5 detik secara bawaan). Kalau hanya tiap jarak ping, koneksi yang tidak pernah menyebut `hello` bisa bertahan sampai 35 detik walau batasnya 5 detik.

Pesan biner ditolak (hanya teks). Koneksi yang belum menyebut `hello` dan mengirim sampah langsung diputus.

## Arsitektur: logika dipisah dari transport
- `hub.ts`: **seluruh logika** (siapa terhubung, pemasangan, validasi, batas, penyapuan). Tidak tahu apa pun soal jaringan; sebuah koneksi hanya dilihat sebagai "bisa mengirim teks dan menutup diri".
- `node.ts`: **transport Node.js** (Hono untuk HTTP, `ws` untuk WebSocket). Hanya mencolokkan soket ke hub dan mengirim ping. Bila hosting dipindah (misalnya ke Cloudflare Workers), cukup ganti file ini.
- `directory.ts`: antarmuka **direktori pemasangan** (siapa pemilik token, HP mana dipasangkan dengan laptop mana). Sekarang ada versi memori; token disimpan **hanya dalam bentuk hash** (SHA-256). Versi database dibuat di issue skema database.

## Keterbatasan saat ini
- Direktori hanya di memori (satu laptop dan satu HP di mode pengembangan).
- Pembatasan laju per koneksi, belum per alamat IP. Pembatasan jumlah koneksi per IP diserahkan ke hosting untuk saat ini.
- Pesan maksimum 1 MiB. Event berisi input alat yang besar (misalnya `Write` dengan isi berkas besar) bisa melebihi itu; daemon yang mengirim ke relay (issue klien relay) harus memotong atau meringkasnya.
- Relay tidak menyimpan pesan: bila HP sedang offline, event untuknya dibuang. Riwayat disimpan di issue skema database, dan antrean offline di klien relay.
- Belum ada daftar asal (`Origin`) yang diizinkan. Itu aman untuk sekarang karena autentikasi memakai token di pesan pertama (bukan cookie), sehingga situs lain tidak bisa membajak koneksi tanpa tahu token.
