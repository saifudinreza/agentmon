# Desain enkripsi ujung-ke-ujung (E2E) dan threat model

**Status: DRAF 2. Garis besarnya disetujui pemilik produk pada 22 November 2026 dan implementasi #033 dimulai; peninjau kriptografi manusia menyusul dan BELUM ada (risikonya diterima: bila peninjau menemukan cacat, kode ikut diubah).** Rancangan tertulis untuk issue #032 (GitHub #75). Belum ada kode. Draf 1 sudah ditinjau satu putaran oleh peninjau kriptografi otomatis (Opus), yang menemukan tiga celah Kritis dan tujuh Penting; semuanya sudah dimasukkan di draf ini (lihat "Riwayat revisi" di bagian akhir). Rancangan kriptografi **tetap wajib ditinjau orang yang berpengalaman di bidang ini** sebelum issue #033 mulai. Rujukan: PRD §13 dan tujuan G5.

## 1. Tujuan dan batasnya

**Tujuan:** relay (server perantara) dan siapa pun yang membobol databasenya **tidak bisa membaca isi** pekerjaan agent (perintah, isi berkas, diff, ringkasan), dan **tidak bisa memalsukan** event, keputusan, atau rollback.

**Bukan tujuan:**
- Menyembunyikan *bahwa* ada aktivitas (siapa terhubung, kapan, seberapa sering). Lihat bagian 5.
- Melindungi dari laptop atau HP yang sudah dikuasai penyerang.
- Rahasia ke depan yang sempurna (forward secrecy per pesan). Lihat bagian 9.
- Menggantikan TLS. TLS tetap dipakai; E2E ada di atasnya.

## 2. Aturan desain
1. **Hanya primitif standar libsodium** (build biasa, bukan sumo). Tidak ada algoritma, mode, atau protokol buatan sendiri. Nama fungsinya tertulis di bagian 4.
2. **Laptop adalah akar kepercayaan.** Daftar HP yang dipercaya disimpan di laptop, bukan di relay. Relay hanya *membantu menyampaikan*, tidak pernah *menentukan* siapa dipercaya.
3. **Laptop menandatangani semua yang berasal darinya, HP menandatangani semua yang berasal darinya.** Enkripsi menjaga kerahasiaan; **tanda tangan** menjaga keaslian. Kunci data yang dipegang banyak pihak tidak membuktikan siapa pengirimnya.
4. **Kunci rahasia tidak pernah lewat relay**, juga tidak lewat alamat yang dikirim browser ke server (hanya fragmen `#`, lihat `docs/relay.md`, bagian Pairing).
5. **Gagal tertutup.** Pesan yang tidak bisa diverifikasi atau didekripsi dibuang dan dicatat, tidak pernah ditampilkan setengah jadi dan tidak pernah dianggap sah. Semua kegagalan dijawab sama (`invalid`) supaya tidak menjadi oracle.
6. **Tidak ada mode "baca keduanya" untuk perintah.** Lihat 4.5 dan bagian 8.

## 3. Threat model

### Aset yang dilindungi
| Aset | Kenapa penting |
|---|---|
| Isi event: perintah shell, isi berkas, diff, ringkasan | Bisa memuat rahasia dan kode privat |
| Keputusan Setujui/Tolak dan rollback | Menyetujui = menjalankan kode di laptop (PRD §13) |
| Keaslian event dari laptop | Event palsu (izin, checkpoint, rekap) menipu pengguna agar memutuskan salah |
| Kunci laptop dan kunci HP | Siapa yang memegangnya bisa membaca atau memalsukan |
| Aturan policy | Hanya di laptop; jangan sampai berubah dari luar |

### Penyerang dan kemampuannya
| Penyerang | Bisa | Tidak bisa (dengan desain ini) |
|---|---|---|
| **Pembobol database relay / admin relay yang ingin tahu** (pasif) | Membaca semua baris `events`: amplop, ukuran, waktu, jaringan pasangan | Membaca payload |
| **Relay jahat** (aktif) | Membuang, menunda, mengulang, mengurutkan ulang pesan; menolak melayani; memalsukan notifikasi push *kosong* (hanya gangguan) | Membaca payload; membuat event atau keputusan yang diterima; memindahkan payload ke amplop lain; memasang HP palsu tanpa QR; menyembunyikan pencabutan dari laptop |
| **Penyerang jaringan** | Seperti relay jahat, hanya bila TLS runtuh | Sama; E2E tetap berlaku |
| **Orang yang melihat QR** (bahu, foto, tangkapan layar) | Memasangkan HP-nya **bila QR masih berlaku** (5 menit, sekali pakai) | Memasang tanpa diketahui: pairing butuh konfirmasi sidik jari di laptop (4.2) |
| **HP dicuri** | Melihat isi yang sudah ada di HP, memberi keputusan sampai dicabut | Setelah dicabut oleh laptop: keputusan diterima, event baru dibaca, atau event palsu disuntikkan (event bertanda tangan laptop) |
| **HP yang dicabut + kebocoran database relay** | Membaca riwayat di bawah `kid` lama yang pernah dipegang HP itu | Event setelah rotasi |
| **Host PWA jahat atau terbobol** (Cloudflare Pages, repo, dependensi) | Mengirim JavaScript berbahaya yang mencuri kunci di HP | **Tidak ada perlindungan.** Lihat batas nyata di bawah |
| **Berkas kunci laptop dibaca** (malware lokal) | Semua | Di luar jangkauan |

### Batas yang harus dinyatakan jujur
1. **PWA adalah kode yang dikirim server.** E2E di aplikasi web hanya sebaik hosting yang mengirim kodenya. Mitigasi (bukan penyelesaian): PWA dan relay di host **berbeda** (sudah: Cloudflare dan Render), CSP ketat (bagian 7), tanpa skrip pihak ketiga, dan opsi self-host (#055). Harus tertulis di dokumentasi publik.
2. **Relay bisa menolak melayani.** E2E melindungi kerahasiaan dan keaslian, bukan ketersediaan.
3. **Relay bisa membuang event diam-diam**, tetapi `seq` ada di data yang diautentikasi (4.3), sehingga HP **melihat celah** dan menampilkannya ("ada event yang hilang"). Relay tidak bisa menutup celah itu.
4. **Riwayat di bawah `kid` lama** tetap terbaca oleh HP yang pernah memegangnya, dan oleh siapa pun yang memegang HP itu plus salinan database relay. Rotasi hanya melindungi **ke depan**.

## 4. Rancangan kriptografi

### 4.1 Kunci dan fungsinya (libsodium-wrappers biasa; harus `await sodium.ready`)
| Kunci | Dibuat di | Primitif | Fungsi |
|---|---|---|---|
| Identitas laptop (tanda tangan) | Laptop, sekali | `crypto_sign_keypair` (Ed25519) | Menandatangani **setiap event**, pesan pairing, rotasi, dan konfirmasi pencabutan |
| Pertukaran laptop | Laptop, sekali | `crypto_kx_keypair` (X25519) | Kunci pasangan dengan tiap HP |
| Identitas HP (tanda tangan) | HP, saat pairing | `crypto_sign_keypair` | Menandatangani **semua perintah** (keputusan, rollback, pencabutan, aturan) |
| Pertukaran HP | HP, saat pairing | `crypto_kx_keypair` | Kunci pasangan dengan laptop |
| **Kunci data** (per laptop, per `kid`) | Laptop | `crypto_aead_xchacha20poly1305_ietf_keygen` | Mengenkripsi payload event, **sekali** untuk semua HP |
| Kunci pasangan, dua arah | Keduanya | `crypto_kx_server_session_keys` (laptop) / `crypto_kx_client_session_keys` (HP) | Laptop = **server**, HP = **client**. Laptop→HP memakai `server.tx` (HP: `client.rx`); HP→laptop memakai `client.tx` (laptop: `server.rx`). Tiap kunci hanya untuk satu arah |

Mengapa **kunci data bersama** dan bukan salinan per HP: riwayat disimpan relay sekali per event. Dengan satu kunci data per `kid`, event dienkripsi sekali; yang berlipat hanya pembungkusan kunci kecil, sekali per HP per `kid`. Karena kunci bersama **tidak membuktikan pengirim**, setiap event juga ditandatangani laptop (4.3).

### 4.2 Pairing yang tahan relay jahat dan QR yang bocor
Penangkal serangan perantara adalah **rahasia `s` yang hanya ada di QR**. Penangkal QR yang bocor adalah **konfirmasi sidik jari oleh orang di depan laptop**.

QR: `https://<pwa>/pair#c=<kode>&r=<relay>&k=<kunci publik Ed25519 laptop>&s=<rahasia 32 byte>`. Hanya kunci **Ed25519** laptop ada di QR; kunci lain dikirim bertanda tangan. `s` hanya berlaku untuk kode `c` itu dan dihapus laptop setelah bukti sah pertama atau saat `c` kedaluwarsa.

```
HP (memindai QR)                           Relay                          Laptop
 1. buat kunci kx dan sign HP; kk = crypto_kdf_derive_from_key(32, 1, "AMpair01", s)
 2. bukti = crypto_auth( "agentmon/pair/v1" ‖ c ‖ machineId ‖ deviceName ‖ pubkey_kx_HP ‖ pubkey_sign_HP , kk )
 3. POST /pair/redeem {c, deviceName, pubkeys HP, bukti}  ──►  diteruskan ke laptop
                                                                 4. laptop mencari s dari CATATANNYA berdasarkan c (bukan c dari relay),
                                                                    menghitung kk, memverifikasi dengan crypto_auth_verify.
                                                                    Gagal: tolak, catat, tidak ada jawaban yang membedakan.
                                                                 5. **Konfirmasi manusia:** terminal laptop menampilkan
                                                                    "Pasangkan 'iPhone Dono'? Sidik jari: 483 291"
                                                                    (6 digit dari crypto_generichash atas transkrip; HP menampilkan angka yang sama).
                                                                    Pengguna membandingkan dan menjawab y/N. Tanpa 'y', tidak ada kunci yang dibagikan.
                                                                 6. laptop menurunkan kunci pasangan dan mengirim, DITANDATANGANI kunci Ed25519 laptop:
                                                                    { machineId, machineName, pubkey_kx_laptop, pubkey_HP (kedua), c, kid, nonce, kunci data terbungkus }
 7. HP memverifikasi tanda tangan memakai kunci Ed25519 dari QR (bukan dari relay), memastikan pesan mengikat kunci HP-nya dan c,
    lalu menurunkan kunci pasangan dan membuka kunci data. HP memanggil history.replaceState untuk menghapus fragmen dari riwayat peramban.
```
- Relay melihat kunci **publik** dan bukti, tidak pernah `s`. Tanpa `s`, ia tidak bisa membuat bukti yang cocok atau tanda tangan langkah 6; mengubah atau mengulang `c` hanya menjadi DoS.
- **Tantangan acak laptop (revisi dari tinjauan PR #96):** sidik jari yang dihitung hanya dari permintaan HP bisa DIGILING (penyerang mencari permintaan sendiri yang angkanya sama; 1,1 juta percobaan dalam 9 detik terbukti). Karena itu, setelah menerima dan memverifikasi permintaan, **laptop memilih nilai acak `r` (16 byte)**, menandatanganinya terikat ke permintaan itu, dan mengirimnya ke HP; `r` masuk transkrip sidik jari di KEDUA sisi. Penyerang tidak bisa menyiapkan permintaan yang cocok sebelum tahu `r`, dan `r` terikat ke permintaannya sendiri. Nama perangkat juga harus baku (NFC, tanpa karakter kendali, lebar-nol, atau bidi). Jawaban laptop (langkah 6) menandatangani `deviceId` yang laptop tentukan.
- **QR bocor** (foto, bahu): penyerang yang menukar lebih dulu hanya sampai langkah 5, di mana pengguna melihat nama dan sidik jari yang tidak ia kenali dan menjawab `N`. Bila HP asli sudah mendapat `invalid-code` karena kodenya terpakai, PWA menampilkan "kode sudah dipakai perangkat lain; periksa daftar perangkat di laptop".
- Laptop menyimpan kunci publik HP di **berkasnya sendiri** (`~/.agentmon/`). `devices.publicKey` di relay hanyalah salinan untuk kenyamanan; laptop **tidak pernah memercayainya**.
- Satu HP untuk beberapa laptop memakai kunci HP yang sama; `machineId` ada di setiap transkrip yang ditandatangani.
- Fungsi: `crypto_kx_*`, `crypto_sign_*`, `crypto_auth` dan `crypto_auth_verify`, `crypto_kdf_derive_from_key` (konteks tepat 8 byte), `crypto_generichash`, `crypto_aead_xchacha20poly1305_ietf_encrypt` untuk pembungkus kunci data (AAD = `"agentmon/wrap/v1" ‖ machineId ‖ deviceId ‖ kid`, kunci = pasangan laptop→HP).

### 4.3 Enkripsi dan tanda tangan event (laptop ke HP)
Payload dienkripsi dengan `crypto_aead_xchacha20poly1305_ietf_encrypt` memakai kunci data `kid`, nonce 24 byte acak baru **per event**, setelah di-padding (`sodium.pad`) ke kelipatan 256 byte. Lalu **laptop menandatangani** seluruhnya:
```
payload = { e: 1, kid, n: nonce, c: ciphertext, s: tanda tangan }
s = crypto_sign_detached( "agentmon/event/v1" ‖ AAD ‖ n ‖ c , sk_laptop )
```
**AAD biner kanonis** (jangan memakai `JSON.stringify`): label `"agentmon/event/v1"`, lalu tiap kolom dengan awalan panjang 4 byte, dalam urutan tetap: `v, id, machineId, sessionId, seq, ts, agent, type, e, kid`, ditambah kolom amplop tambahan bagian 5 (`approvalId`, `expiresAt`) bila ada. Kolom amplop asing yang diteruskan relay **tidak pernah dipakai** untuk apa pun yang menyangkut keamanan.

HP **memverifikasi tanda tangan lebih dulu, baru mendekripsi**, dan menolak event tanpa tanda tangan sah dari kunci Ed25519 laptop yang ia kenal. Akibatnya:
- Relay **dan** HP lain yang memegang kunci data **tidak bisa** membuat event palsu (`approval.requested` palsu, `approval.resolved` palsu untuk menyembunyikan izin asli, `checkpoint.created` palsu, rekap palsu), termasuk dengan `kid` lama.
- Relay tidak bisa memindahkan payload ke amplop lain, mengubah `type`, `seq`, atau kolom amplop tambahan.
- Biaya: 64 byte per event dan puluhan mikrodetik.

HP juga memeriksa bahwa `approvalId` di amplop sama dengan yang di plaintext, dan menolak `kid` yang lebih rendah dari `kid` terbaru yang sudah ia terima untuk event baru.

### 4.4 Urutan dan celah
`seq` ada di AAD yang ditandatangani. HP memeriksa urutan per sesi: nomor yang loncat ditampilkan sebagai "event hilang" (relay membuang, atau riwayat terpotong retensi 30 hari). HP membuang `id` yang sudah pernah dilihat (ulang).

### 4.5 Perintah HP ke laptop (keputusan, rollback, pencabutan, aturan)
**Aturan keras (menutup penurunan versi di jalur perintah):** begitu laptop punya **satu saja** HP berkunci, daemon **menolak semua perintah yang tidak terenkripsi dan tidak bertanda tangan**. Tidak ada mode "baca keduanya" untuk perintah. HP lama tanpa kunci dikeluarkan dari daftar tepercaya (pasang ulang, bagian 8). Perintah yang ditolak berujung ke alur izin normal (terminal laptop).

Isi minimum yang ditandatangani HP (`crypto_sign_detached`, label `"agentmon/decision/v1"`, tiap kolom berawalan panjang): `machineId`, `deviceId`, `sessionId`, `approvalId`, `eventId` dari `approval.requested`, **`H`**, `decision`, `hunks` (keputusan sebagian), `comment`, `commandId`.
- **`H = crypto_generichash(32, seluruh plaintext payload approval.requested persis seperti yang laptop kirim)`**, bukan hanya `toolInput`. Diff, risiko, dan ringkasan ikut ter-hash, jadi diff palsu dengan `toolInput` sama tidak lolos. Laptop menghitung `H` dari plaintext yang benar-benar ia kirim.
- Masa berlaku diikat ke `expiresAt` milik **laptop**, diperiksa dengan jam laptop. Jam HP tidak relevan.
- **Anti-replay:** `approvalId` acak (UUID) dan satu izin hanya bisa diselesaikan sekali. Laptop menyimpan izin yang selesai dan `commandId` yang sudah dipakai **di disk**, supaya keputusan yang diputar ulang setelah daemon restart tetap ditolak.
- **Urutan di laptop (gagal di mana pun = tidak ada keputusan):** (1) dekripsi AEAD dengan kunci HP→laptop, AAD = label ‖ `machineId` ‖ `deviceId`; (2) parse; (3) ambil kunci HP dari **berkas laptop** untuk `deviceId` itu dan pastikan belum dicabut; (4) `crypto_sign_verify_detached`; (5) cocokkan `approvalId`, `eventId`, `H` dengan izin yang menunggu; (6) periksa belum kedaluwarsa; (7) check-and-set atomik di engine (sama dengan prompt terminal), lalu jalankan.
- **`truncated`:** laptop sendiri menolak `approve` untuk izin yang terpotong; larangan itu tidak boleh hanya di HP.
- **Jawaban laptop** (`approval.result`) dienkripsi dengan kunci laptop→HP dan ditandatangani, terikat ke `commandId`, supaya relay tidak bisa memalsukan "berhasil ditolak".
- Rincian lengkap (format kanonis, uji) adalah issue #034; dokumen ini mengikat apa yang **wajib** ada.

### 4.6 Banyak HP
Tiap HP punya kunci pasangan sendiri; semuanya menerima **kunci data yang sama** (dibungkus per HP). Menambah HP = langkah 1 sampai 7 untuk HP itu saja. HP lain tidak terpengaruh.

### 4.7 Pencabutan dan rotasi
**Pencabutan harus berupa perintah bertanda tangan, bukan panggilan ke relay.**
- Dari **CLI laptop**: jalur otoritatif.
- Dari **HP**: HP mengirim perintah `device.revoke` bertanda tangan (lingkup #034). Laptop memverifikasi terhadap daftarnya sendiri, **meminta konfirmasi di terminal** bila yang dicabut adalah HP lain, lalu bertindak. HP menampilkan "dicabut" hanya setelah menerima **konfirmasi bertanda tangan dari laptop**, bukan sekadar jawaban 204 dari relay (yang bisa dipalsukan atau disembunyikan).
- Laptop lalu: (1) menghapus HP itu dari **daftar tepercayanya** (perintah dari HP itu ditolak walau relay tetap meneruskan); (2) membuat kunci data baru `kid + 1` dan membungkusnya hanya untuk HP yang tersisa; (3) menandatangani dan mengirim event `devices.changed` ke HP yang tersisa; (4) memberi tahu relay (token dicabut) sebagai pelengkap.
- HP yang tersisa menerima `kid` baru **hanya dari pesan bertanda tangan laptop**. Bila relay menahan pembungkusan itu, HP menampilkan "kunci baru belum diterima", bukan diam.
- Rotasi juga dilakukan tiap 30 hari atau setelah 100.000 event, mana lebih dulu.
- Yang tersisa (dinyatakan terbuka): HP yang dicabut tetap bisa membaca riwayat di bawah `kid` lama, bila ia juga mendapat salinan database relay (batas 4 di bagian 3).

## 5. Yang masih terlihat oleh relay (metadata)
| Data | Terlihat | Alasan |
|---|---|---|
| `machineId`, `deviceId`, siapa dipasangkan dengan siapa | Ya | Relay perlu tahu ke mana meneruskan |
| `sessionId`, `seq`, `ts`, `agent` | Ya | Pengurutan, pengambilan riwayat per sesi (`afterSeq`), retensi 30 hari |
| `type` event | Ya | Pemicu notifikasi dan status sesi tanpa membuka isi. Ikut bocor: `approval.auto_resolved` menunjukkan aktivitas policy, `checkpoint.created` menunjukkan ada suntingan berkas |
| Ukuran payload | Kasar | **Padding ke kelipatan 256 byte wajib** (`sodium.pad`), karena panjang perintah pendek sangat informatif |
| Waktu dan pola aktivitas, alamat IP, daftar langganan push | Ya | Bagian dari transportasi |
| **Isi**: perintah, berkas, diff, ringkasan, alasan risiko, komentar penolakan | **Tidak** | Tujuan E2E |

### Perubahan yang dipaksakan E2E pada relay
Relay sekarang **membaca payload** di dua tempat, dan keduanya tidak boleh lagi:
1. **Daftar izin yang menunggu** (`packages/server/src/approvals.ts`) dibangun dari `approval.requested/resolved`. Setelah E2E, daftar ini dibangun **di HP** dari riwayat yang sudah diverifikasi dan didekripsi. Endpoint relay untuk daftar izin dihapus atau hanya mengembalikan nomor.
2. **Notifikasi** (`notifier.ts`) memakai `pending()` untuk jumlah, `approvalId` tunggal, dan level risiko. Setelah E2E, notifikasi hanya bergantung pada **amplop tambahan yang tidak rahasia dan masuk AAD**: `approvalId` (nomor acak) dan `expiresAt`. Jumlah dihitung dari `type` + `approvalId`. Push "Izin dibutuhkan" yang dipalsukan relay hanya gangguan, karena layar keputusan selalu dari data terverifikasi.

**Keputusan pemilik produk (dipilih): level risiko TIDAK ikut di notifikasi push.** Notifikasi izin hanya berbunyi "Izin dibutuhkan" (dan jumlahnya). Level dan alasannya baru terlihat setelah aplikasi dibuka dan payload didekripsi di HP. Alasannya: level adalah informasi tentang isi pekerjaan, dan membocorkannya ke relay melemahkan janji E2E (relay jadi tahu "ada izin berbahaya jam sekian"). Konsekuensi: kolom `risk` di isi push (issue #031, PR #74) dan pengiriman level oleh `notifier.ts` **dihapus saat E2E diterapkan (#033/#035)**; sampai itu, relay milik sendiri masih boleh memakainya. Penyaring kebijakan di notifier (#037) juga tidak boleh lagi bergantung pada level.

## 6. Riwayat dan perangkat baru
- **HP baru hanya membaca event sejak ia dipasangkan** (ia hanya menerima kunci data `kid` saat ini). Alasan: HP yang baru dipasang adalah titik paling rawan (QR bocor), jadi ia tidak otomatis mewarisi seluruh sejarah.
- **Opsi `pair --share-history`** (dipilih pengguna di laptop): laptop ikut membungkus kunci data lama untuk HP baru.
- **HP kehilangan datanya** (browser dibersihkan, iOS membuang penyimpanan, pasang ulang): HP **tidak bisa lagi membaca apa pun** dan harus dipasangkan ulang. Tidak ada pemulihan lewat relay (itu justru bukti E2E bekerja). Harus dijelaskan di layar pairing.
- **Laptop kehilangan kunci** (reinstal): semua HP harus dipasangkan ulang; riwayat lama di relay tidak bisa dibaca lagi oleh siapa pun.

## 7. Penyimpanan kunci dan perlindungan di HP
| Tempat | Penyimpanan | Catatan |
|---|---|---|
| Laptop | Berkas di `~/.agentmon/` dengan izin hanya pemilik | Keychain OS adalah peningkatan berikutnya |
| HP | IndexedDB milik PWA (di iOS terpisah dari Safari). Byte kunci libsodium **dibungkus kunci WebCrypto AES-GCM yang tidak dapat diekspor** | Mencegah kunci disalin dari cadangan atau dump; tidak mencegah pemakaian langsung lewat XSS |

Plaintext yang didekripsi (diff, isi berkas, perintah, pesan agent) **dikendalikan penyerang** lewat isi repo atau prompt injection. Karena itu wajib: CSP `script-src 'self' 'wasm-unsafe-eval'` tanpa `unsafe-inline`, Trusted Types, tidak pernah merender HTML dari plaintext (hari ini markdown dijadikan teks polos, `timeline/plain.ts`), tanpa skrip pihak ketiga. libsodium dipin ke versi persis (seri 0.7.x; uji impor di Vite dan Node), dimuat lazy, dan WASM-nya diizinkan CSP.

## 8. Rencana migrasi data lama
Sekarang: semua event adalah JSON polos. Rencana:
1. **Event dan pairing lama tidak punya kunci.** Satu-satunya pengguna sekarang (relay milik sendiri, satu HP) **memasangkan ulang** setelah #033 selesai; tidak ada migrasi kunci otomatis.
2. **Jangkar penurunan versi adalah pairing, bukan pengalaman.** HP yang dipasangkan dengan protokol E2E **menolak tanpa syarat** event polos dari laptop itu (tidak ada "belum pernah melihat yang terenkripsi"). Riwayat polos lama tidak ditampilkan; yang bisa memicu aksi hanya event yang terverifikasi dan terdekripsi. Event polos lama terhapus sendiri oleh retensi 30 hari.
3. **Perintah:** begitu satu HP berkunci terpasang, daemon menolak perintah polos (4.5). Selama tidak ada HP berkunci, perilaku lama berlaku, dan itu hanya boleh pada relay milik sendiri (gerbang rilis PRD §13).
4. Urutan: (a) PWA dan daemon yang mampu E2E dirilis; (b) pairing ulang membuat kunci; (c) daemon mengenkripsi dan menandatangani, dan menolak perintah polos; (d) #035 menghentikan penyimpanan data yang tak lagi dibutuhkan relay.

## 9. Keterbatasan yang diterima dengan sadar
- **Tanpa forward secrecy per pesan.** Bila kunci data bocor, semua event di bawah `kid` itu terbaca. Dikurangi rotasi, bukan ratchet. Alasan: relay menyimpan riwayat bagi HP yang offline.
- **Verifikasi manual terbatas pada sidik jari saat pairing** (4.2), tidak ada pemeriksaan berkala sesudahnya.
- **Metadata terlihat** (bagian 5).
- **Kepercayaan pada host PWA** (bagian 3).

## 10. Pertanyaan untuk peninjau manusia
1. Apakah transkrip pairing 4.2 (bukti `crypto_auth`, sidik jari 6 digit, tanda tangan langkah 6) benar-benar menutup serangan perantara dan QR yang bocor? Apakah 6 digit cukup?
2. Apakah tanda tangan per event (4.3) plus kunci data bersama memadai, atau lebih baik kunci pasangan per HP?
3. Apakah urutan verifikasi di 4.5 dan isi `H` sudah lengkap?
4. Apakah pencabutan dari HP (4.7) bisa dibuat tanpa konfirmasi terminal tanpa menurunkan keamanan?
5. Apakah ada primitif libsodium yang lebih cocok? (Tinjauan otomatis: tidak; sealed box tanpa autentikasi pengirim dan secretstream butuh urutan pesan.)

## Pekerjaan lanjutan
#033 (implementasi enkripsi payload dan tanda tangan event), #034 (keputusan bertanda tangan; isi minimum ada di 4.5, termasuk `hunks`, `H` atas seluruh payload, penolakan `truncated` di laptop, dan `reply` terenkripsi), #035 (mengurangi data di relay), #055 (self-host). Catatan untuk #033: uji "nonce yang dipakai ulang ditolak" keliru konsep, karena AEAD tidak mendeteksi nonce ganda; ganti dengan "event yang diputar ulang (`id`/`seq` sama) ditolak".

## Riwayat revisi
- **Draf 1:** rancangan awal.
- **Draf 2 (peninjauan otomatis Opus):** tiga Kritis diperbaiki (penurunan versi di jalur perintah, pencabutan lewat relay, event tanpa tanda tangan laptop) dan tujuh Penting (isi minimum #034, QR bocor dan sidik jari, transkrip pairing, pembungkusan kunci dan `kid`, penurunan versi di HP, AAD biner, XSS dan penyimpanan kunci). Peninjau manusia belum.
