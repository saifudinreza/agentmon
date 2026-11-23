# Pustaka kripto bersama (issue #033, bagian A)

Implementasi primitif dari desain di [security-e2e.md](security-e2e.md), di `packages/shared/src/crypto/` (dipakai lewat `@agentmon/shared/crypto`). Ini bagian A dari lima bagian #033; belum ada yang memanggilnya (pairing, event, dan rotasi menyusul di bagian B sampai E).

**Status peninjauan:** BELUM ditinjau peninjau kriptografi manusia (garis besar desain disetujui pemilik produk; lihat status di security-e2e.md). Jangan menganggap ini sudah diaudit.

## Isi
| Berkas | Isi |
|---|---|
| `sodium.ts` | `loadSodium()`: memuat libsodium belakangan (import dinamis) dan menunggu `ready`. Semua fungsi lain menerima objek `Sodium` yang sudah siap, jadi sinkron dan mudah diuji. |
| `encoding.ts` | `canon()` = pengodean biner kanonis (label, lalu tiap kolom berawalan panjang 4 byte; angka hanya bilangan bulat tak negatif), base64 aman-URL, `CryptoError`. |
| `event.ts` | Kunci (Ed25519, X25519, kunci data), `aeadSeal`/`aeadOpen` (XChaCha20-Poly1305, padding 256 byte), `sealEvent`/`openEvent` (enkripsi + tanda tangan laptop; verifikasi dulu, baru dekripsi). |
| `pairing.ts` | Bukti rahasia QR (`crypto_auth` dengan kunci dari `crypto_kdf`), sidik jari 6 digit, kunci pasangan (`crypto_kx`, arah terpisah), pembungkus kunci data, jawaban laptop bertanda tangan. |
| `command.ts` | `H` (hash seluruh payload izin), keputusan bertanda tangan HP, amplop tertutup HP ke laptop. |

## Jaminan yang diuji (`crypto.test.ts`)
- Vektor uji resmi: Ed25519 RFC 8032 (uji 1) dan XChaCha20-Poly1305 draft-irtf-cfrg-xchacha (A.3.1).
- Bolak-balik data semula; padding menyamakan panjang ciphertext; nonce tidak pernah kembar (2000 enkripsi).
- Ditolak: satu bit diubah di ciphertext, nonce, atau tanda tangan; SATU kolom amplop diubah (id, sesi, mesin, seq, waktu, agen, jenis, izin, kedaluwarsa, versi); kunci data salah; `kid` tak dikenal atau diubah; bidang asing; bentuk rusak; kunci tanda tangan lain (pemegang kunci data tidak bisa membuat event).
- Semua kegagalan memakai `CryptoError("invalid")` yang sama (bukan oracle).
- Penanda rahasia tidak muncul sebagai plaintext (teks, base64, heks) di payload.
- Perangkat yang dicabut tidak membuka event `kid` baru.
- Pairing: bukti, sidik jari (berubah bila kunci ditukar), arah kunci pasangan, pembungkus (HP, mesin, kid, arah salah), jawaban laptop bertanda tangan (tiap kolom).
- Keputusan: tiap kolom, `H`, dan kunci lain; amplop tertutup (perangkat, mesin, arah, data diubah).

Catatan: uji "nonce dipakai ulang ditolak" di issue lama keliru konsep (AEAD tidak mendeteksi nonce ganda); yang diuji adalah nonce acak baru tiap enkripsi.

## Bagian B: laptop dan relay (pairing)
- `bridge/src/e2e-store.ts`: berkas `e2e.json` (0600, atomik) memuat identitas tanda tangan, pasangan kunci pertukaran, kunci data per `kid`, dan HP yang dipercaya. Berkas rusak melempar galat dan TIDAK diganti diam-diam. E2E menyala bila ada satu HP yang dipercaya dan belum dicabut.
- `bridge/src/pairing-e2e.ts`: verifikasi bukti rahasia QR, tantangan acak bertanda tangan, konfirmasi sidik jari oleh manusia (bukan terminal berarti TIDAK), membungkus kunci data, jawaban bertanda tangan. Gagal di tengah tidak menyisakan kepercayaan.
- Relay: tabel `device_e2e` dan `e2e_messages`, `POST /pair/e2e/messages`, `GET /api/e2e/messages` (lihat `relay.md`).
- Belum: PWA (bagian C), enkripsi event dan perintah di daemon (bagian D), rotasi saat pencabutan (bagian E). Sampai D, event tetap polos walau ada HP terenkripsi.

## Bagian C: PWA (HP)
- `web/src/e2e/keyring.ts`: brankas di IndexedDB, isinya dibungkus AES-GCM dengan kunci WebCrypto yang TIDAK DAPAT DIEKSPOR (mencegah kunci disalin dari dump penyimpanan; tidak mencegah skrip di halaman yang sama, karena itu CSP ketat tetap bagian dari desain). Blob rusak melempar `KeyringError` dan tidak ditimpa; gagal menyimpan membatalkan perubahan di memori.
- `web/src/e2e/pair.ts`: pairing dari sisi HP (bukti rahasia QR, tantangan diverifikasi dengan kunci laptop dari QR, sidik jari ditampilkan, jawaban diverifikasi: tanda tangan, nomor HP, kode, kunci HP). Jawaban hanya diterima SETELAH tantangan terverifikasi (pengguna selalu sempat melihat sidik jari). Gagal di mana pun: laptop itu dibuang dari pairing HP, tidak ada yang tersisa.
- `web/src/e2e/gate.ts`: SEMUA yang masuk (event langsung, riwayat, antrean izin, balasan) dan keluar (keputusan, permintaan) lewat gerbang. Laptop E2E: event polos DITOLAK, tanda tangan diverifikasi sebelum dekripsi, `kid` lama ditolak untuk event langsung, amplop izin (`approvalId`, `expiresAt`) harus sama dengan isinya. Keputusan membawa `sessionId`, `eventId`, dan `H` atas seluruh payload yang dilihat HP dan disegel + ditandatangani; izin yang tidak pernah dilihat tidak bisa diputuskan. Antrean izin laptop E2E dihitung DI HP dari event terbuka (`GET /api/approvals?events=1`).
- `web/src/e2e/runtime.ts`: libsodium dimuat belakangan; brankas dibuka saat aplikasi dibuka dan runtime dihidupkan HANYA bila ada isinya (sebelum layar digambar). Brankas rusak menampilkan layar penjelasan (`VaultBroken`), tidak dikosongkan.
- Ukuran: libsodium (lazy, ±430 kB / ±150 kB gzip) tidak ada di JS awal; tes build memeriksanya, dan tes ukuran build kini memakai NODE_ENV=production (sebelumnya React versi pengembangan ikut terukur).
- QR memuat `m` (nomor laptop) selain `s` dan `k`; tautan yang memuat salah satunya wajib lewat jalur E2E dan ditolak bila tidak lengkap (tidak pernah turun diam-diam ke pairing polos).
- **Catatan:** tombol "salin tautan pairing" di panduan iOS (tab Safari) menyalin tautan LENGKAP termasuk rahasia `s`; tautan itu berlaku 5 menit dan hanya berguna bersama kunci publik laptop di tautan yang sama. Hapus dari clipboard setelah ditempel.
- Belum: laptop belum mengenkripsi event dan membuka perintah (bagian D), rotasi saat pencabutan (bagian E). Sampai D, laptop yang dipasangkan E2E tidak mengirim event terenkripsi, jadi HP E2E belum menerima event; **jangan memasangkan HP produksi secara E2E sebelum D selesai.**

## Perubahan dari tinjauan PR #96
- **Sidik jari** kini memuat tantangan acak 16 byte dari laptop (`generatePairChallenge`, `signPairChallenge`/`verifyPairChallenge`), dan nama perangkat harus baku (`normalizeDeviceName`). Ini menutup penggilingan sidik jari.
- `deviceId` ikut ditandatangani di jawaban pairing.
- `openEvent` wajib diberi `expectedMachineId` dan mengembalikan `{ plaintext, kid }` supaya pemanggil bisa menolak `kid` yang lebih rendah.
- Pengodean kanonis memberi tiap kolom JENIS (tidak ada, teks, angka, byte): kolom tidak ada berbeda dari teks kosong, dan angka berbeda dari teks. Jenis lain (objek, null, boolean) ditolak. Nilai `decision` diperiksa saat dijalankan.
- Galat dari callback `dataKeys` menjadi `CryptoError`; `loadSodium` boleh dicoba lagi setelah gagal.
- **Konvensi API:** fungsi `verify*` MENGEMBALIKAN boolean dan tidak melempar (pemanggil WAJIB memeriksanya); fungsi `open*` dan `unwrap*` MELEMPAR `CryptoError`.

## Keputusan dan batas
- **Versi libsodium-wrappers 0.8.4**, dipin persis (desain menyebut seri 0.7.x; 0.8.x memuat ESM yang benar dan lolos uji impor di Node/tsx dan Vite). Dimuat lazy: di PWA menjadi dua chunk terpisah (sekitar 120 kB dan 458 kB tidak terkompresi, WASM tertanam), tidak ikut bundel awal.
- **CSP PWA** (`web/public/_headers`) memberi `'wasm-unsafe-eval'` dan tanpa `'unsafe-inline'` untuk skrip (bagian 7 desain). Karena itu skrip tema tidak lagi inline di `index.html` melainkan `public/theme-init.js` (dimuat sinkron); tes build menjaga agar tidak ada skrip inline. libsodium tidak di-precache; `sw-sodium.ts` menyimpannya saat dipakai pertama supaya pengguna E2E tetap bisa membuka aplikasi offline.
- **jsdom** memakai kelas `Uint8Array` yang berbeda dari Node sehingga libsodium menolak masukannya ("buffer must be a Uint8Array"); tes yang memanggil kripto memakai `// @vitest-environment node`. Browser sungguhan tidak terpengaruh.
- Tidak ada keadaan di sini: pemeriksaan `kid` yang lebih rendah, celah `seq`, `id` ganda, dan penyimpanan anti-replay adalah tanggung jawab pemanggil (bagian D dan issue #034).
