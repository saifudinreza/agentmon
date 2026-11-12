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

Perintah `pair` butuh tiga variabel lingkungan: `AGENTMON_RELAY_URL` (alamat relay), `AGENTMON_RELAY_TOKEN` (token laptop di relay), dan `AGENTMON_APP_URL` (alamat PWA).

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

**Alamat di dalam QR:** `https://<pwa>/pair#c=<kode>&r=<alamat-relay>`. Semuanya di **fragmen** (setelah `#`) yang tidak pernah dikirim browser ke server mana pun. Rahasia enkripsi ujung-ke-ujung (tahap 4) nanti ditambahkan sebagai parameter `k` di fragmen yang sama, sehingga relay tetap tidak bisa membacanya. Kode `buildPairingUrl` dan `parsePairingUrl` ada di `packages/shared/src/pairing.ts` dan dipakai bersama oleh laptop dan PWA.

## Klien relay di daemon
Daemon di laptop menyambung ke relay lewat `packages/bridge/src/relay-client.ts`. Nyalakan dengan mengisi `AGENTMON_RELAY_URL` dan `AGENTMON_RELAY_TOKEN` saat menjalankan daemon (nilai yang sama dengan perintah `pair`). Nomor laptop di relay **harus sama** dengan isi berkas `machine-id` di folder data daemon; bila berbeda, klien berhenti dengan pesan jelas karena relay pasti menolak event-nya.

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
- **Pendaftaran laptop ke relay belum ada.** Pairing mengandaikan laptop sudah punya baris dan token di relay. Alur pendaftaran otomatis dikerjakan bersama klien relay di daemon; sementara itu laptop didaftarkan lewat `createDbDirectory(...).registerMachine`.
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

Keterbatasan: backend push belum ada (issue lain), jadi langganan push belum bisa terdaftar; hitungannya sudah benar begitu tabelnya terisi. Izin yang SUDAH menunggu tidak dilepas bila HP terakhir putus; hanya aksi berikutnya yang kembali ke terminal.

## Daftar dan cabut perangkat

| Endpoint | Siapa | Fungsi |
|---|---|---|
| `GET /api/devices` | HP (token HP) | perangkat yang berbagi laptop dengan HP ini, termasuk dirinya (`current: true`); HP laptop lain tidak tampak |
| `DELETE /api/devices/:id` | HP | mencabut perangkat itu (atau dirinya sendiri) |
| `GET /pair/devices` | laptop (token laptop) | HP yang terpasang dengan laptop ini |
| `DELETE /pair/devices/:id` | laptop | mencabut HP yang terpasang dengan laptop ini (untuk HP hilang) |

Pencabut harus punya hubungan dengan perangkat itu (laptop yang dipasangkan dengannya, atau HP yang berbagi laptop). Selain itu dijawab `404` yang sama dengan "tidak ada", supaya nomor perangkat tidak bisa dicari tahu. Mencabut dua kali aman (idempoten).

**Berlaku seketika.** Setelah tersimpan di database, hub menutup koneksi HP itu (kode "tidak berwenang", sama dengan token ditolak, sehingga PWA menampilkan "Perangkat dicabut"), token ditolak untuk koneksi baru dan API baca, perintah dari HP itu tidak lagi diteruskan ke laptop (pemasangannya dianggap tidak ada), dan laptop menerima hitungan kehadiran baru. HP yang dicabut juga tidak dihitung sebagai "bisa dihubungi lewat push" (lihat Kehadiran HP), jadi langganan push miliknya tidak membuat daemon menunggu. Baris perangkat tetap disimpan (jejak), hanya ditandai dicabut.

CLI di laptop: `devices` mencetak daftar HP, `revoke <nomor>` mencabutnya (butuh `AGENTMON_RELAY_URL` dan `AGENTMON_RELAY_TOKEN`). Perintah jujur bila relay tidak terjangkau: HP dinyatakan BELUM dicabut.

Keterbatasan: izin yang SUDAH diputuskan oleh HP itu sebelum dicabut tetap berlaku (keputusan lama tidak ditarik). Sambungan yang sedang dalam proses `hello` tepat pada saat pencabutan bisa lolos sebentar; ia tetap tidak bisa memutuskan apa pun karena setiap perintah memeriksa pemasangan, dan ditutup di sambungan berikutnya. Pencabutan diri sendiri dari PWA mengeluarkan HP itu dan memerlukan QR baru. Pemberitahuan push belum ada backend-nya; begitu ada, ia harus memakai `devicesWithPush` yang sudah mengecualikan perangkat tercabut.
