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

**Relay ke klien:** `welcome` (jawaban `hello` yang berhasil, berisi nomor), `event`, `command` (membawa `deviceId` pengirim), `ack` (tanda terima untuk laptop, berisi `eventId`), dan `error` (berisi `code` dan `message`).

**Tanda terima (`ack`).** Setiap event dari laptop yang diterima dan diproses relay dijawab `ack`. Di mode database, `ack` berarti event **sudah tersimpan** di database: relay menyimpan dulu, baru meneruskan ke HP dan me-`ack`. Bila menyimpan gagal, event tidak diteruskan dan tidak di-`ack`, sehingga laptop mengirimnya ulang. Event yang ditolak (salah bentuk, `machineId` palsu, terlalu cepat) tidak di-`ack`. Relay mengingat 2.000 nomor event terakhir per laptop: event yang dikirim ulang dengan nomor yang sama di-`ack` lagi tetapi **tidak diteruskan dua kali** ke HP. Ingatan ini hanya di memori dan dicatat SETELAH event berhasil disimpan; setelah relay dimulai ulang, penyimpan event (unik per laptop dan nomor event) yang menjaga agar tidak ganda.

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

## Database
Relay menyimpan data permanen di PostgreSQL (Neon) lewat Drizzle. Kodenya di `packages/server/src/db/`.

| Tabel | Isi |
|---|---|
| `machines` | Laptop: nomor, nama, **hash** token, terakhir terlihat |
| `devices` | HP: nomor, nama, **hash** token, kunci publik (tahap 4), waktu dicabut |
| `pairings` | Relasi laptop dan HP |
| `pairing_codes` | Kode pairing sekali pakai (**hash** kodenya) dan kedaluwarsanya |
| `sessions` | Sesi agent: laptop, agent, status (`active` atau `ended`), waktu mulai dan terakhir |
| `events` | Riwayat event. Kunci utamanya **(laptop, nomor event)** |
| `push_subscriptions` | Langganan Web Push per HP |

**Menjalankan migrasi** (aman diulang, hanya yang belum dijalankan yang diterapkan):
```bash
DATABASE_URL=postgres://pengguna:kata-sandi@host/namadb pnpm --filter @agentmon/server db:migrate
```
Setelah mengubah `src/db/schema.ts`, hasilkan migrasinya dengan `pnpm --filter @agentmon/server db:generate` dan **commit hasilnya bersama perubahan skema**. Ada test yang gagal bila skema dan migrasi terakhir tidak sama.

**Jaminan yang dijaga database sendiri** (tetap berlaku walau ada bug di kode penulisnya):
- **Token hanya tersimpan sebagai hash.** Kolom token menerima hanya SHA-256 heksadesimal (64 karakter); batasan `CHECK` menolak yang lain, termasuk token mentah yang tak sengaja masuk. Hal yang sama berlaku untuk kode pairing.
- **Event tidak tersimpan dua kali.** Event yang dikirim ulang diabaikan (event pertama yang berlaku, tidak menimpa). Keunikannya **per laptop**, sehingga satu laptop tidak bisa menghalangi event laptop lain dengan memakai nomor yang sama.
- **Menghapus laptop menghapus turunannya** (pasangan, kode, sesi, event). Menghapus HP menghapus pasangan dan langganan pushnya.

**Riwayat.** `store.saveEvent` menyimpan event (dan membuat sesinya), `listEvents` mengambil riwayat satu sesi berurutan menurut nomor urut dan bisa dilanjutkan dengan `afterSeq` (untuk HP yang menyambung ulang), dan `listSessions` mendaftar sesi sebuah laptop. Satu pengambilan paling banyak 500 event.

**Penghapusan otomatis.** `startRetention` menghapus riwayat yang **diterima relay** lebih dari 30 hari lalu (dicek tiap 6 jam), beserta sesi yang sudah kosong dan kode pairing yang sudah dipakai atau kedaluwarsa. Dasarnya jam relay, bukan jam pengirim yang bisa keliru atau dipalsukan. Laptop dan HP yang terdaftar tidak ikut terhapus. Penghapusan berjalan **bertahap** (5.000 baris per pernyataan) supaya tidak menahan kunci lama saat relay masih menulis event baru, dan sesi yang sedang dipakai `saveEvent` dilewati. Bila putaran sebelumnya belum selesai, putaran baru tidak ditumpuk.

**Direktori berbasis database** (`createDbDirectory`) menggantikan versi memori tanpa mengubah hub, dan lolos kontrak test yang sama. HP yang dicabut (`revokedAt`) tidak bisa tersambung dan tidak dianggap dipasangkan. Pencatatan "terakhir terlihat" laptop hanya pembukuan: bila itu gagal, laptop bertoken sah tetap diterima (pencarian tokennya yang gagal tetap menolak).

**Koneksi produksi.** `openPostgres` memasang penangan galat pada kolam koneksi. Tanpanya, koneksi idle yang diputus server (rutin di Neon) memicu pengecualian tak tertangkap yang mematikan relay. Galat hanya dicatat, dengan kata sandi alamat database disamarkan. Parameter `limit` dan `afterSeq` yang bukan angka berhingga (NaN, Infinity) memakai nilai bawaan.

**Isi event disimpan sebagai teks JSON**, bukan `jsonb`. Relay tidak pernah mengkueri isinya (dan mulai tahap 4 terenkripsi), sedangkan `jsonb` menolak karakter NUL (`\u0000`) yang bisa saja ada di isi berkas atau perintah dari agent. Teks JSON menyimpannya persis sama.

**Test memakai PGlite**, yaitu mesin Postgres asli yang berjalan di dalam proses Node. CI di Windows, macOS, dan Linux menguji perilaku Postgres yang sebenarnya (batasan, kunci asing, `ON CONFLICT`) tanpa perlu memasang server database.

## Pairing lewat QR
Menghubungkan sebuah HP dengan sebuah laptop. Aktif bila relay dijalankan dengan `DATABASE_URL` (mode pengembangan tanpa database tidak punya pairing).

**Alur.** Laptop menjalankan `pnpm --filter @agentmon/bridge cli pair`, yang meminta kode sekali pakai ke relay dan menampilkannya sebagai QR di terminal (beserta alamat tertulis untuk jaga-jaga). HP memindai QR, membuka PWA, dan PWA menukar kode itu menjadi kredensial HP. Terminal laptop lalu menulis `Perangkat baru terpasang: <nama>`.

Perintah `pair` butuh pengaturan relay (alamat dan token laptop) dan `AGENTMON_APP_URL` (alamat PWA). Pengaturan relay diambil dari berkas `relay.json` yang disimpan perintah `register` (lihat Pendaftaran laptop), atau dari `AGENTMON_RELAY_URL` dan `AGENTMON_RELAY_TOKEN` bila keduanya diisi (lingkungan menang).

| Endpoint | Siapa | Fungsi |
|---|---|---|
| `POST /pair/code` | laptop (Bearer token laptop) | minta kode; jawaban `201 {code, expiresAt}` |
| `GET /pair/devices` | laptop | daftar HP yang terpasang (dipakai untuk memberi tahu ada perangkat baru) |
| `POST /pair/redeem` | HP | tukar kode: isi `{code, name}`, jawaban `{deviceId, machineId, machineName, deviceToken?}` |

**Aturan keamanan:**
- Kode acak 192 bit, berlaku **5 menit**, hanya bisa dipakai **sekali**. Yang disimpan relay hanya hash-nya.
- Kode yang tidak dikenal, sudah terpakai, dan kedaluwarsa dijawab **sama persis** (`400 invalid-code`).
- Menandai kode terpakai adalah satu pernyataan atomik di database, jadi dua HP yang menukar kode yang sama bersamaan tidak mungkin keduanya berhasil.
- Penukaran dibatasi lajunya per alamat IP (10 percobaan beruntun, lalu 1 per 10 detik) dan secara keseluruhan; permintaan kode dibatasi per laptop, dan satu laptop paling banyak punya 5 kode aktif. Di belakang proxy hosting nyalakan `TRUST_PROXY=1` supaya IP dibaca dari `X-Forwarded-For` (entri paling kanan).
- `PAIRING_ALLOWED_ORIGINS` (dipisah koma) menentukan asal PWA yang boleh memanggil `/pair/redeem` dari browser.
- **Satu HP, beberapa laptop:** HP yang sudah punya kredensial mengirimnya di header `Authorization` saat menukar kode laptop kedua. Ia dipasangkan tanpa dibuatkan perangkat baru.

**Pairing terenkripsi ujung-ke-ujung (issue #033, bagian B; desain di `security-e2e.md`, pustaka di `crypto.md`).** Bila `pair` dijalankan dengan kunci E2E laptop (bawaan), QR memuat tiga parameter tambahan: `s` (rahasia 32 byte yang hanya ada di QR dan di memori proses `pair`), `k` (kunci publik Ed25519 laptop), dan `m` (nomor laptop, dibutuhkan HP untuk membuat bukti sebelum menukar kode). HP yang mendukungnya menukar kode dengan tambahan `e2e: {kx, sign, proof}` (dua kunci publik dan bukti `crypto_auth` atas permintaannya); relay hanya MENYIMPANNYA (tabel `device_e2e`) dan meneruskannya ke laptop lewat `GET /pair/devices`, tanpa memercayainya. Laptop hanya memproses HP dari KODE-nya sendiri (relay menyebut hash kode tiap HP di `/pair/devices`; HP dari kode lain tidak disentuh), memverifikasi bukti dengan rahasia dari catatannya sendiri, memilih tantangan acak, meminta pengguna membandingkan sidik jari 6 digit, lalu menitipkan pesan bertanda tangan untuk HP lewat kotak surat. HP tanpa bahan E2E yang memakai QR itu juga harus dikonfirmasi pengguna. Menolak atau gagal hanya melepas pasangan di laptop itu (`DELETE /pair/devices/:id?scope=pairing`, HP di laptop lain tidak terganggu); tanpa `scope`, HP dicabut di semua laptop:

| Endpoint | Siapa | Fungsi |
|---|---|---|
| `POST /pair/e2e/messages` | laptop | menitipkan `{deviceId, kind, body}` (kind: `challenge`, `response`, `keys`) untuk HP yang dipasangkan dengannya; `404` untuk HP yang bukan miliknya, tidak ada, atau dicabut; `413` bila lebih dari 16 KiB; pesan terlama dibuang bila lebih dari 200 per HP; tidak pernah menolak yang baru |
| `GET /api/approvals?events=1` | HP | seperti `/api/approvals`, ditambah `events`: event izin mentah (polos atau terenkripsi) dari riwayat terbaru. HP dengan E2E menghitung antrean sendiri dari event itu setelah memverifikasi dan mendekripsinya (relay tidak bisa membaca yang terenkripsi) |
| `GET /api/e2e/messages?machineId=&after=` | HP | membaca pesan untuk HP ini dari laptop itu yang lebih baru dari `after` (maksimum 100) |

Relay tidak membaca isi pesan; keasliannya dijaga tanda tangan laptop yang diperiksa HP dengan kunci dari QR. Semua terhapus bersama laptop atau HP-nya.

**Alamat di dalam QR:** `https://<pwa>/pair#c=<kode>&r=<alamat-relay>` (pairing E2E menambah `s`, `k`, dan `m`, lihat di atas). Semuanya di **fragmen** (setelah `#`) yang tidak pernah dikirim browser ke server mana pun, sehingga relay tetap tidak bisa membacanya. Kode `buildPairingUrl` dan `parsePairingUrl` ada di `packages/shared/src/pairing.ts` dan dipakai bersama oleh laptop dan PWA.

## Klien relay di daemon
Daemon di laptop menyambung ke relay lewat `packages/bridge/src/relay-client.ts`. Nyalakan dengan mendaftarkan laptop (perintah `register`, yang menyimpan `relay.json`) atau dengan mengisi `AGENTMON_RELAY_URL` dan `AGENTMON_RELAY_TOKEN` saat menjalankan daemon (nilai yang sama dengan perintah `pair`). Nomor laptop di relay **harus sama** dengan isi berkas `machine-id` di folder data daemon; bila berbeda, klien berhenti dengan pesan jelas karena relay pasti menolak event-nya.

- **Tidak memperlambat agent.** Menitipkan event ke klien selalu seketika dan tidak pernah gagal ke pemanggilnya; koneksi, pengiriman, dan percobaan ulang berjalan di belakang layar.
- **Tidak hilang, tidak ganda.** Event tetap di antrean sampai relay mengirim `ack`. Bila koneksi putus atau `ack` tidak datang dalam 10 detik, event dikirim ulang, dan relay mengabaikan nomor yang sama. Event dalam satu sesi disusun menurut `seq` sebelum dikirim.
- **Penyambungan ulang** dengan jeda yang berlipat dua (0,5 detik sampai 30 detik) dan sedikit acak, supaya banyak laptop tidak menyerbu relay bersamaan saat relay pulih.
- **Antrean ada batasnya**: 5.000 event atau 16 MiB. Bila terlampaui, event **terlama** dibuang dan dicatat di log (`relay: N event dibuang`, dirangkum maksimal tiap 5 detik). Event yang lebih besar dari batas pesan relay juga dibuang dan dicatat.
- **Laju terkendali**: klien membatasi lajunya sendiri (lonjakan 50, lalu 40 event per detik, sedikit di bawah batas relay) dan paling banyak 50 event yang belum di-`ack` sekaligus. Antrean yang menumpuk selama relay mati terkuras tanpa memicu penolakan atau pemutusan (1.000 event sekitar 25 detik). Bila relay tetap menjawab `rate_limited`, klien berjeda 1 detik lalu melanjutkan sendiri.
- **Sambungan harus terenkripsi.** Token laptop dikirim di pesan pertama, jadi `http://` dan `ws://` hanya diterima untuk komputer ini sendiri (`localhost`, `127.x.x.x`, `::1`). Ke host lain pakai `https://` atau `wss://`; untuk jaringan tepercaya, izinkan dengan sadar lewat `AGENTMON_RELAY_INSECURE=1`. Alamat yang ditolak hanya mematikan relay, daemon tetap berjalan.
- **Keputusan dari HP**: perintah `{type: "approval.decision", approvalId, decision, comment?, hunks?}` diserahkan ke approval engine. Log hanya mencatat hasilnya, tidak pernah komentar atau isi keputusan.

## API baca riwayat untuk HP
Aktif di mode database (`PAIRING_ALLOWED_ORIGINS` juga berlaku untuk CORS). Semua jalur butuh token HP (`Authorization: Bearer`); laju dibatasi per HP. Permintaan bertoken salah (atau tanpa token) juga dibatasi **per alamat IP** (lonjakan 30, lalu 1 per detik) dan ditolak `429` sebelum menyentuh database; di belakang proxy hosting nyalakan `TRUST_PROXY=1` supaya alamat dibaca dari `X-Forwarded-For`.

| Endpoint | Fungsi |
|---|---|
| `GET /api/machines` | laptop yang dipasangkan dengan HP ini, beserta `online` (sedang tersambung ke relay) |
| `GET /api/machines/:machineId/sessions` | sesi laptop itu, dari yang paling baru aktif |
| `GET /api/machines/:machineId/sessions/:sessionId/events?afterSeq=N&limit=M` | event sesi itu berurutan menurut `seq`, sesudah `afterSeq`; paling banyak 500 per halaman; `hasMore` memberi tahu masih ada lanjutan |

HP hanya boleh membaca laptop yang dipasangkan dengannya. Laptop yang tidak dipasangkan dan laptop yang tidak ada dijawab sama (404), supaya tidak bisa dipakai mengintai. HP memakainya saat pertama dibuka dan untuk **menambal yang terlewat** setelah koneksi pulih atau HP dibuka dari kunci: ambil lagi mulai dari nomor urut terakhir yang sudah diambil dari riwayat.

## Keterbatasan saat ini
- **Antrean klien hanya di memori.** Bila daemon dimatikan paksa selagi relay tidak terjangkau, event yang belum terkirim hilang. Penutupan normal memberi relay 2 detik untuk menerima sisa antrean.
- **`ack` berarti event sudah tersimpan di relay (mode database), bukan bahwa HP sudah menerimanya.** HP yang sedang offline tidak mendapat event secara langsung, tetapi mengambilnya dari riwayat lewat API baca saat tersambung lagi (lihat bagian API baca riwayat).
- Kode pairing yang terpakai atau kedaluwarsa dihapus oleh penghapusan otomatis (dijalankan `main.ts` di mode database: sekali saat mulai, lalu tiap 6 jam), sehingga bisa tertinggal sampai 6 jam. Itu aman, karena kode kedaluwarsa tetap ditolak walau barisnya belum terhapus.
- Nama perangkat dari HP ditolak bila memuat karakter kontrol, dan tetap disanitasi saat dicetak di terminal laptop.
- **Pendaftaran laptop** sudah ada (lihat bagian Pendaftaran laptop); tidak lagi perlu memanggil `registerMachine` lewat kode.
- **Layar pairing di PWA belum ada** (issue PWA). Sampai saat itu penukaran bisa dicoba dengan `POST /pair/redeem` langsung.
- **Pemberitahuan "perangkat baru" memakai pertanyaan berkala** (tiap 2 detik selama perintah `pair` berjalan), bukan dorongan lewat WebSocket. Notifikasi ke daemon yang sedang berjalan menunggu klien relay.
- QR dicetak dengan kode warna ANSI (hitam di atas putih). Terminal yang tidak mendukung ANSI menampilkan karakter aneh; alamat tertulis di bawah QR tetap bisa dipakai.
- Bila `DATABASE_URL` diisi, relay sudah memakai **direktori database, pairing QR, dan penghapusan otomatis**. Event yang lewat disimpan dan HP membacanya lewat API baca riwayat. Tanpa `DATABASE_URL`, relay berjalan di mode pengembangan dengan direktori memori dan tanpa pairing.
- Penyimpan event mengembalikan galat bila event berisi karakter NUL di kolom pengenal (nomor sesi, jenis event). Pemanggil harus memperlakukan kegagalan simpan sebagai tidak fatal, supaya meneruskan pesan tidak ikut terhenti.
- Pembatasan laju per koneksi, belum per alamat IP. Pembatasan jumlah koneksi per IP diserahkan ke hosting untuk saat ini.
- Pesan maksimum 1 MiB. Event berisi input alat yang besar (misalnya `Write` dengan isi berkas besar) bisa melebihi itu; daemon yang mengirim ke relay (issue klien relay) harus memotong atau meringkasnya.
- Tanpa database (mode pengembangan), relay tidak menyimpan pesan: bila HP sedang offline, event untuknya dibuang. Di mode database, riwayat tersimpan dan HP mengambilnya sendiri.
- Belum ada daftar asal (`Origin`) yang diizinkan. Itu aman untuk sekarang karena autentikasi memakai token di pesan pertama (bukan cookie), sehingga situs lain tidak bisa membajak koneksi tanpa tahu token.

## Keputusan izin dari HP

- **`GET /api/approvals`**: izin yang masih menunggu di semua laptop yang dipasangkan dengan HP ini (dihitung dari event `approval.requested` 30 menit terakhir, dikurangi yang sudah `resolved`/`auto_resolved` atau kedaluwarsa; berisiko tinggi di atas). Dipakai HP untuk mengisi antrean saat dibuka.
- **Frame `command`** (HP ke laptop) membawa `approval.decision` (`approve` atau `deny`, alasan opsional). Laptop menjawab lewat frame **`reply`** (laptop ke relay, diteruskan hanya ke HP yang memutuskan) berisi `approval.result` dengan hasil `applied`, `already_resolved` (kalah dari perangkat lain atau sudah kedaluwarsa), `unknown`, atau `invalid`. Keputusan pertama yang sah menang; relay tidak memutuskan apa pun.
- Event `approval.requested` membawa `diff` (perubahan berkas yang diusulkan). Input alat yang terlalu besar dipotong dengan penanda di sisi laptop supaya tetap muat dalam satu pesan.

## Kehadiran HP (presence)

Relay mengirim frame **`presence`** `{reachable: N}` ke laptop: berapa HP yang dipasangkan dengannya dan **bisa dihubungi**, yaitu sedang tersambung ke relay, atau punya langganan push (bisa dibangunkan walau terkunci; dihitung sekali walau keduanya benar). Dikirim setelah `welcome` dan setiap kali ada HP tersambung atau putus. HP yang dicabut atau tidak dipasangkan tidak dihitung. Bila relay gagal menghitung (mis. database bermasalah), tidak ada frame yang dikirim.

Daemon memakainya lewat `relayClient.canReachPhone()`: benar hanya bila tersambung ke relay DAN laporan terakhir > 0. Relay mati, belum ada laporan, atau 0 HP berarti daemon **tidak menahan aksi**, sehingga prompt terminal langsung muncul (tidak menunggu 9 menit). Perintah `status` menjelaskan keadaan ini. Tanpa relay yang dikonfigurasi, perilaku lama tetap: jawaban lewat CLI atau halaman lokal.

Keterbatasan: relay sudah bisa menerima langganan push (lihat bagian Web Push), dan PWA sudah mendaftarkannya lewat kartu Notifikasi (lihat `web.md`), jadi HP yang sudah mengaktifkan notifikasi dihitung bisa dihubungi walau sedang terkunci. Izin yang SUDAH menunggu tidak dilepas bila HP terakhir putus; hanya aksi berikutnya yang kembali ke terminal.

## Daftar dan cabut perangkat

| Endpoint | Siapa | Fungsi |
|---|---|---|
| `GET /api/devices` | HP (token HP) | perangkat yang berbagi laptop dengan HP ini, termasuk dirinya (`current: true`); HP laptop lain tidak tampak |
| `DELETE /api/devices/:id` | HP | mencabut perangkat itu (atau dirinya sendiri) |
| `POST /api/push/test` | HP (token HP) | mengirim satu notifikasi uji ke HP pemanggil saja (panduan pemasangan). `404` bila belum berlangganan, `502` bila layanan push menolak, `503` bila push belum menyala, `429` setelah 3 kali (lalu satu tiap 20 detik per HP) |
| `GET /pair/devices` | laptop (token laptop) | HP yang terpasang dengan laptop ini |
| `DELETE /pair/devices/:id` | laptop | mencabut HP yang terpasang dengan laptop ini (untuk HP hilang) |
| `DELETE /machine` | laptop | laptop mencabut DIRINYA SENDIRI (perintah `uninstall`): baris laptop, pemasangan, sesi, event, dan kode pairing-nya dihapus; token langsung tidak berlaku (permintaan kedua dijawab `401`); koneksi WebSocket laptop diputus. HP tetap ada, hanya hubungannya yang hilang. Tidak ada id di jalur, jadi tidak bisa dipakai menghapus laptop lain |

Pencabut harus punya hubungan dengan perangkat itu (laptop yang dipasangkan dengannya, atau HP yang berbagi laptop). Selain itu dijawab `404` yang sama dengan "tidak ada", supaya nomor perangkat tidak bisa dicari tahu. Mencabut dua kali aman (idempoten).

**Berlaku seketika.** Setelah tersimpan di database, hub menutup koneksi HP itu (kode "tidak berwenang", sama dengan token ditolak, sehingga PWA menampilkan "Perangkat dicabut"), token ditolak untuk koneksi baru dan API baca, perintah dari HP itu tidak lagi diteruskan ke laptop (pemasangannya dianggap tidak ada), dan laptop menerima hitungan kehadiran baru. HP yang dicabut juga tidak dihitung sebagai "bisa dihubungi lewat push" (lihat Kehadiran HP), jadi langganan push miliknya tidak membuat daemon menunggu. Baris perangkat tetap disimpan (jejak), hanya ditandai dicabut.

CLI di laptop: `devices` mencetak daftar HP, `revoke <nomor>` mencabutnya (butuh `AGENTMON_RELAY_URL` dan `AGENTMON_RELAY_TOKEN`). Perintah jujur bila relay tidak terjangkau: HP dinyatakan BELUM dicabut.

Keterbatasan: izin yang SUDAH diputuskan oleh HP itu sebelum dicabut tetap berlaku (keputusan lama tidak ditarik). Sambungan yang sedang dalam proses `hello` tepat pada saat pencabutan bisa lolos sebentar; ia tetap tidak bisa memutuskan apa pun karena setiap perintah memeriksa pemasangan, dan ditutup di sambungan berikutnya. Pencabutan diri sendiri dari PWA mengeluarkan HP itu dan memerlukan QR baru. Notifikasi push (lihat bagian Web Push) hanya mengambil langganan HP yang masih dipasangkan dan belum dicabut, dan pencabutan juga menghapus langganannya.

Catatan HP hilang: HP yang berbagi laptop yang sama boleh saling mencabut (termasuk pencuri yang memegang HP hilang mencabut HP pemilik). Itu tidak membuka akses baru, dan pemilik pulih dengan `revoke` lalu `pair` di laptop. Untuk HP hilang, jalur yang dianjurkan adalah CLI di laptop.

## Web Push

Relay membangunkan HP yang terkunci lewat layanan push milik browser (Google, Mozilla, Apple), dengan kunci VAPID milik operator relay sendiri: tanpa Firebase atau akun pihak ketiga.

### Menyalakan
Isi tiga variabel lingkungan (di Render: dashboard, bukan repo). Tanpa ketiganya push mati dan relay tetap berjalan normal.

| Variabel | Isi |
|---|---|
| `VAPID_PUBLIC_KEY` | kunci publik (87 karakter) |
| `VAPID_PRIVATE_KEY` | kunci pribadi (43 karakter), **rahasia** |
| `VAPID_SUBJECT` | kontak operator yang dilihat layanan push: alamat `https://` (mis. alamat PWA) atau `mailto:` |
| `PUSH_ALLOWED_HOSTS` | (opsional) akhiran host layanan push tambahan, dipisah koma |

Buat pasangan kunci dengan `pnpm --filter @agentmon/server push:keys` (kunci pribadi ikut tercetak: jangan disalin ke chat, repo, atau log). Relay memeriksa saat mulai bahwa ketiganya lengkap, bentuknya benar, dan kunci publiknya cocok dengan kunci pribadinya; bila tidak, push mati dan alasannya (tanpa nilai kunci) ada di log. **Mengganti kunci membuat semua langganan lama tidak berlaku** (browser mengikat langganan ke kunci publik), jadi HP harus berlangganan ulang.

### Endpoint untuk HP (token HP)
| Endpoint | Fungsi |
|---|---|
| `GET /api/push/key` | `{enabled, publicKey?}`: apakah push menyala dan kunci publik untuk `pushManager.subscribe` |
| `PUT /api/push/subscription` | mendaftarkan langganan (bentuk `PushSubscription.toJSON()`); **menggantikan** langganan lama HP ini (satu HP, satu langganan) |
| `DELETE /api/push/subscription` | berhenti menerima notifikasi di HP ini |
| `GET /api/push/preferences` | jenis notifikasi HP ini: `{approvals, done}`; `404` bila belum berlangganan |
| `PUT /api/push/preferences` | mengubah satu atau dua jenis (`{approvals?, done?}`; yang tidak disebut tetap) dan mengembalikan hasilnya; `400` bila isi kosong atau bukan boolean, `404` bila belum berlangganan |

Ditolak `400` bila alamat langganan bukan layanan push yang dikenal, atau kunci publik langganan bukan titik P-256 yang sah; `503` bila push belum dikonfigurasi di relay; `413` bila isi lebih dari 4 KiB.

### Yang dijaga
- **Alamat langganan dibatasi** ke HTTPS di host layanan push yang dikenal (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`, dan subdomainnya). Relay mengirim permintaan HTTP ke alamat itu; tanpa batas, HP yang sudah terpasang bisa menyuruh relay menghubungi alamat internal hosting (SSRF). Layanan sah yang belum ada di daftar bisa ditambah lewat `PUSH_ALLOWED_HOSTS`. Aturan yang sama diperiksa lagi sebelum mengirim, jadi baris lama yang tidak lolos tidak pernah dihubungi dan dihapus.
  - **Bagian host dibaca langsung dari teksnya** dan hanya huruf, angka, titik, dan strip yang lolos (port 443 boleh). Ini disengaja: pustaka `web-push` menentukan tujuan dengan parser URL lama (`url.parse`), sedangkan `new URL` adalah parser WHATWG, dan keduanya membaca host berbeda untuk alamat seperti `https://169.254.169.254;.fcm.googleapis.com/` atau `https:fcm.googleapis.com/`. Memeriksa lewat satu parser lalu mengirim lewat parser lain akan membuka SSRF. Temuan ini datang dari review PR #55 dan dijaga tes yang menyisipkan setiap karakter ASCII di posisi berbahaya.
- **Isi push hanya jenis dan nomor** (`{v, kind: approval|done|test, machineId, sessionId?, approvalId?}`): tanpa kode, perintah, nama berkas, atau teks dari agent (FR-34). Skemanya ketat; kolom lain ditolak. Teks notifikasi disusun di HP, dan detailnya dibaca dari relay setelah notifikasi diketuk.
- **Log tidak memuat alamat langganan** (alamat itu cukup untuk mengirim notifikasi ke HP), kunci, maupun isi push; hanya jumlah dan kode status.
- **Langganan mati dihapus otomatis**: layanan push menjawab 404 atau 410. Kegagalan sementara (jaringan, 429, 5xx) tidak menghapus apa pun. Jawaban 401 atau 403 (relay ditolak karena salah kunci) tidak menghapus apa pun juga, tetapi dicatat sebagai galat di log.
- **HP yang dicabut** kehilangan langganannya saat dicabut, dan tidak pernah dihubungi walau barisnya tertinggal. Notifikasi hanya ke HP yang masih dipasangkan dengan laptop terkait.
- Pengiriman memakai TTL: 10 menit untuk permintaan izin (lebih lama dari itu sudah tidak berguna), 1 jam untuk "agent selesai". Urgensi tinggi hanya untuk izin. Tiap pengiriman punya batas waktu TOTAL (20 detik), karena opsi `timeout` milik `web-push` hanya batas soket diam.
- **Push mati = langganan tidak dihitung sebagai HP yang bisa dihubungi** (`withPushPresence`): bila VAPID dihapus atau salah isi setelah HP berlangganan, daemon tidak boleh mengira ada HP yang akan diberi notifikasi.
- Log pengiriman memuat hitungan jawaban per kode (mis. `400x2 410x1`), tanpa alamat. 400 dari layanan push TIDAK menghapus langganan: bila kodenya salah di sisi relay semua jawaban akan 400, dan menghapus berarti kehilangan semua langganan.

### Kapan notifikasi dikirim (`notifier.ts`)
Semua keputusan "bangunkan HP atau tidak" ada di satu modul, `createNotifier`, yang dipanggil hanya untuk event yang **baru** tersimpan (event kiriman ulang dari daemon, `inserted: false`, tidak memicu). Hanya aktif bila push dikonfigurasi.

| Event | Notifikasi | Jendela penggabungan |
|---|---|---|
| `approval.requested` | "Izin dibutuhkan", memuat jumlah izin yang menunggu di sesi itu | 10 detik |
| `agent.stopped` | "Agent selesai" | 60 detik (Claude Code berhenti di akhir **setiap giliran**) |

**Sepuluh permintaan beruntun tidak menjadi sepuluh notifikasi.** Per sesi dan per jenis: kejadian pertama langsung dikirim; kejadian berikutnya selama jendela hanya menandai; saat jendela berakhir dan ada yang baru, **satu** pesan ringkasan (jumlah terkini) dikirim, lalu jendela baru dimulai; setelah satu jendela penuh tanpa kejadian, sesi dilupakan (memori tidak menimbun). Ringkasan yang himpunan izinnya sama dengan yang terakhir dikirim, dan ringkasan saat semua izin sudah diputuskan, tidak dikirim. Notifikasinya memakai **tag per sesi** (`approval:<laptop>:<sesi>`), sehingga pesan ringkasan **menggantikan** yang sebelumnya di layar HP, bukan menumpuk. Dengan jendela 10 detik, sepuluh permintaan sekaligus menjadi paling banyak dua notifikasi.

**Isi push hanya nomor dan jumlah** (FR-34). `notifier.ts` sengaja tidak membaca isi event (payload): ia hanya melihat jenis, nomor laptop, dan nomor sesi. Perintah, kode, nama berkas, atau pesan terakhir agent tidak mungkin ikut karena tidak pernah dibaca; skema push juga ketat. Dijaga tes dengan perintah dan rahasia di dalam event.

**Satu titik untuk kebijakan (#037).** Setiap keputusan lewat `filter` (`NotifyDecision = {kind, machineId, sessionId, count?, risk?}`, dengan `risk` = risiko TERTINGGI di antara izin yang menunggu, bila dinilai; bukan isi permintaan), yang bisa menolaknya (mis. "jangan bangunkan untuk risiko rendah", "jam tenang"). Penyaring yang melempar galat berarti **diam**, bukan membanjiri.

**Jenis notifikasi per HP (FR-33).** Dua pilihan, `approvals` dan `done`, tersimpan per langganan HP (kolom `notify_approvals` dan `notify_done`, bawaan menyala; migrasi `0001`). HP yang mematikan satu jenis tidak dikirimi jenis itu dan langganannya tidak dihapus. Berlangganan ulang (alamat atau kunci berganti) **mewarisi** pengaturannya, jadi notifikasi yang sengaja dimatikan tidak menyala lagi. Uji kirim dari operator (`push:test`) tidak ikut diatur.

**Kenapa notifikasi tidak dihapus dari jauh saat izin diputuskan di perangkat lain** (langkah 3 issue): iOS mewajibkan **setiap** push menampilkan notifikasi. Push "senyap" untuk menghapus akan membuat notifikasi baru di setiap keputusan (juga di HP yang memutuskan) dan bisa membuat Apple mencabut langganan. Penggantinya: (1) notifikasi diganti per sesi; (2) service worker menutup notifikasi izin yang sudah lebih tua dari 10 menit setiap kali push berikutnya tiba (`web/src/push/sw-logic.ts`); dan (3) **dibersihkan oleh aplikasi saat dibuka**: setelah antrean izin dimuat dari relay, notifikasi izin yang sesinya tidak lagi punya izin menunggu ditutup (`web/src/push/stale.tsx`). TTL Web Push (10 menit untuk izin) BUKAN pembersih: ia hanya mengatur berapa lama layanan push menyimpan pesan yang belum terkirim. Keterbatasan jujur: izin yang diputuskan di perangkat lain, sementara aplikasi tidak dibuka dan tidak ada push baru, tetap tampil di layar sampai pengguna menghapusnya atau membuka aplikasi. Bila notifikasi usang tetap diketuk, layar keputusan menyebut bahwa izinnya sudah diputuskan.

### Mencoba pengiriman
`DATABASE_URL=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=... pnpm --filter @agentmon/server push:test <nomor-hp>` mengirim satu notifikasi uji ke HP itu dan mencetak jumlahnya saja.

### Keterbatasan
- **Belum terbukti di HP sungguhan.** Yang teruji: enkripsi payload (RFC 8291, dibuka kembali di tes dengan kunci langganan buatan) dan tanda tangan VAPID (RFC 8292) dibuat oleh pustaka `web-push` dan diverifikasi di tes, pengelolaan langganan, serta penghapusan yang mati. Jalur kirim lewat jaringan (`webPushTransport`) hanya diuji dengan pustaka tiruan; aturan alamat dilindungi uji sifat yang memakai parser URL lama yang sama dengan `web-push`. PWA kini mendaftarkan langganan dan menampilkan notifikasi (lihat `web.md`), tetapi penerimaan nyata oleh Android dan iOS baru bisa dibuktikan setelah dicoba di perangkat (issue uji perangkat nyata).
- **Notifikasi tidak dihapus dari jauh** saat izin diputuskan di perangkat lain; lihat "Kapan notifikasi dikirim" untuk alasan dan penggantinya.
- Aturan daftar host mengikuti layanan push yang diketahui hari ini. Peramban lain dengan layanan push sendiri perlu `PUSH_ALLOWED_HOSTS`.
- **Mengganti kunci VAPID.** Langganan lama terikat ke kunci lama: layanan push menjawab 401 atau 403, baris tetap tersimpan (relay tidak bisa membedakan ini dari kunci relay yang salah, jadi tidak menghapus), dan log menjelaskan kemungkinannya. Kunci publik yang dipakai saat berlangganan belum disimpan per baris (butuh migrasi skema), jadi baris lama baru tergantikan saat HP berlangganan ulang. PWA sudah melakukannya: saat kartu Notifikasi dibuka, kunci dari `GET /api/push/key` dibandingkan dengan kunci langganannya dan langganan dibuat ulang bila berbeda (hanya untuk HP yang pernah mengaktifkan notifikasi).
- **Alamat langganan yang sama didaftarkan HP lain dipindahkan ke HP itu** (kasus sah: browser yang sama dipasangkan ulang sebagai HP baru). Menyalahgunakannya butuh mengetahui alamat langganan milik HP lain, yang tidak pernah dikirim ke HP mana pun selain pemiliknya; menolaknya akan memblokir pasang ulang yang sah, jadi dibiarkan.
- Pendaftaran yang kebetulan menyusul tepat setelah pencabutan bisa meninggalkan satu baris untuk HP yang sudah dicabut. Baris itu tidak pernah dikirimi apa pun (pengambilan menyaring HP yang dicabut).
- Dua pendaftaran serentak dari HP yang sama dengan alamat berbeda bisa meninggalkan satu baris lebih; baris itu dibersihkan saat layanan push menjawab 404/410 atau pada pendaftaran berikutnya.
- Satu HP memegang satu langganan: PWA terpasang dan tab browser di HP yang sama memakai langganan yang sama.

## Pendaftaran laptop

Relay yang baru di-deploy tidak punya laptop. `POST /admin/machines` membuat baris dan token laptop, dan hanya bisa dipakai pemegang **rahasia admin**. Dipakai oleh perintah `register` di laptop (langkah lengkapnya di [`deploy.md`](deploy.md)).

| | |
|---|---|
| Menyalakan | variabel `ADMIN_SECRET` di relay, minimal 32 karakter, hanya ASCII tercetak **tanpa spasi** (rahasia bersepasi atau non-ASCII tidak akan pernah cocok dengan header, jadi ditolak sejak awal). Tanpa itu `/admin/*` tidak ada (404). Yang tidak memenuhi syarat tidak dipakai, dan alasannya (tanpa nilai) ada di log. |
| Permintaan | `POST /admin/machines` dengan `Authorization: Bearer <rahasia>` dan isi `{id, name, rotate?}`. `id` = UUID dari berkas `machine-id` laptop; `name` 1 sampai 64 karakter tanpa karakter kontrol. |
| Jawaban | `201 {machineId, token}`; token 256 bit acak, dibuat **di relay**, diberikan **sekali**, dan jawabannya `Cache-Control: no-store`. `400` isi tidak sah, `401` rahasia salah, `404` rotate untuk nomor yang belum ada, `409` nomor sudah terdaftar, `413` isi terlalu besar, `429` dibatasi laju. |
| Nomor laptop | harus sama dengan yang dipakai daemon di setiap event: relay menolak event yang `machineId`-nya berbeda dari identitas koneksi. |

**Yang dijaga**
- Rahasia dibandingkan dengan **waktu tetap** (lewat hash SHA-256 kedua sisi), supaya tidak bisa ditebak dari selisih waktu jawaban.
- **Rahasia salah dibatasi laju per alamat IP** (5 percobaan, lalu 1 per menit). Alamat yang sudah kehabisan jatah ditolak (429) **sebelum** rahasianya diperiksa, jadi penebak dari alamat itu tidak tahu apakah tebakannya benar. **Sengaja tidak ada kuncian global** untuk semua alamat: kuncian seperti itu bisa dipakai orang luar untuk mengunci pemilik dari relaynya sendiri (hasil review PR #59); penebakan dari banyak alamat dilawan oleh panjang rahasia, bukan kuncian. Penolakan yang dicatat di log dibatasi (5, lalu 1 per 10 detik) supaya tebakan dari banyak alamat tidak membanjiri log.
- **Pendaftaran yang berhasil dibatasi** (10, lalu 1 per menit), supaya rahasia yang bocor tidak bisa membanjiri tabel. Jatah **diambil sebelum menunggu database**: bila baru diambil sesudahnya, permintaan serentak lolos bersamaan (terbukti: 100 permintaan serentak menghasilkan 100 pendaftaran), dan sekarang ada tes serentak yang menjaganya. Permintaan yang bentuknya tidak sah (400) tidak memakai jatah; yang ditolak 409 atau 404 memakainya.
- **Hanya hash token yang disimpan** (batasan CHECK di skema menolak yang lain). Token dan rahasia tidak pernah masuk log; yang tercatat hanya nomor laptop dan fakta bahwa percobaan ditolak.
- **Nomor yang sudah terdaftar ditolak (409)** kecuali `rotate: true`: mendaftar dua kali tidak diam-diam memutus laptop yang sedang berjalan. `rotate` mengganti token dan nama, dan **memutus sambungan lama seketika** (kode tutup 4003), jadi token yang bocor tidak tetap hidup sampai sambungannya putus sendiri.
- Tidak ada CORS: loket ini bukan untuk browser.

**Di laptop** (`register`): rahasia hanya dari `AGENTMON_ADMIN_SECRET` (bukan argumen perintah; argumen yang keliru diketik tidak digemakan ke layar). Rahasia tidak dikirim lewat `http://` ke host selain komputer ini kecuali `AGENTMON_RELAY_INSECURE=1`. Hasilnya disimpan di `relay.json` (ditulis ke berkas sementara lalu dipindah; mode 0600 di macOS dan Linux, di Windows mengikuti izin folder profil). Token **tidak dicetak** kecuali `--print-token`, atau bila berkas gagal ditulis (token hanya diberikan sekali, jadi dicetak ke stderr daripada hilang). Bila alamat relay di lingkungan berbeda dari yang tersimpan dan tokennya tidak diisi, token tersimpan **tidak** dikirim ke relay lain.

**Keterbatasan**
- **Tanpa kuncian global, keamanan terhadap penebakan dari banyak alamat bergantung pada rahasia yang acak.** Buat dengan `randomBytes(32)` seperti di `deploy.md`, bukan frasa sandi buatan sendiri. Per alamat, satu orang hanya dapat 5 tebakan lalu 1 per menit. Bila `TRUST_PROXY` lupa diisi di belakang proxy hosting, semua klien terlihat sebagai satu alamat: lima tebakan salah dari siapa pun mengunci pemilik sampai jatah pulih (di `render.yaml` sudah diisi).
- **Rahasia admin satu untuk semua**: siapa pun yang memegangnya bisa mendaftarkan laptop apa pun dan mengganti token laptop mana pun (`rotate`). Tidak ada akun admin atau daftar pendaftaran yang bisa dicabut satu per satu; mengganti `ADMIN_SECRET` menutup akses lama. Cocok untuk satu pemilik; belum untuk banyak pengguna (issue self-host dan seterusnya).
- Token laptop disimpan sebagai teks biasa di `relay.json`. Di Windows tidak ada pembatasan izin berkas selain izin folder profil pengguna.
- Belum ada perintah menghapus atau menonaktifkan laptop di relay; yang ada hanya mengganti token (`--rotate`).
- Pembatas laju disimpan di memori satu proses relay: restart mengosongkannya, dan beberapa instance berbagi jatah sendiri-sendiri.
- Setelah `register --rotate`, daemon yang sedang berjalan diputus relay dan mencoba tersambung ulang dengan token lamanya (ditolak, tercatat di log tiap beberapa detik) sampai dijalankan ulang untuk membaca `relay.json` yang baru.
- Sambungan yang sedang dalam proses `hello` tepat pada saat `rotate` bisa lolos sebentar dengan token lama (sama seperti pencabutan HP): `disconnectMachine` hanya menutup sambungan yang sudah terdaftar. Jendelanya sempit dan sambungan itu ditutup pada sambungan berikutnya.
- Pendaftaran yang terputus di tengah jalan (relay sempat mencatatnya tetapi jawabannya tidak sampai) meninggalkan laptop terdaftar tanpa token di laptop; pendaftaran ulang dijawab 409 dan perbaikannya `register --rotate`. `register` membangunkan relay lebih dulu lewat `GET /health` (sampai 90 detik, relay gratis butuh sekitar 40 sampai 50 detik) dan baru mengirim pendaftaran dengan batas waktu pendek, supaya itu jarang terjadi.
- AGENTMON_RELAY_URL dan AGENTMON_RELAY_TOKEN yang **keduanya** masih diisi di lingkungan (mis. profil shell dari petunjuk lama) mengalahkan `relay.json`: `register` memperingatkan. Token di lingkungan tanpa alamat diabaikan.
- Uji ujung-ke-ujung (relay, CLI, dan daemon asli sebagai proses terpisah) dijalankan manual dengan `pnpm e2e:register`; tidak ikut CI karena menjalankan beberapa proses.
- **Notifikasi "agent selesai" dikirim di akhir setiap giliran Claude Code** (digabung per 60 detik), bukan hanya saat sesi berakhir, karena notifikasi dikirim per giliran (`Stop`), sedangkan `SessionEnd` (yang kini menghasilkan `session.recap`) hanya terjadi di akhir sesi. Pengguna yang merasa terlalu sering bisa mematikan jenis itu di kartu Notifikasi.
- Jendela dan hitungan ada di memori satu proses relay: restart mengosongkannya (paling buruk, satu notifikasi tambahan), dan beberapa instance relay tidak berbagi.
- Notifikasi izin membawa jumlah yang dihitung dari riwayat 30 menit terakhir; izin yang lebih lama dari itu tidak mungkin masih menunggu (batas bawaan 9 menit).
