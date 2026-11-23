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

## Perubahan dari tinjauan PR #96
- **Sidik jari** kini memuat tantangan acak 16 byte dari laptop (`generatePairChallenge`, `signPairChallenge`/`verifyPairChallenge`), dan nama perangkat harus baku (`normalizeDeviceName`). Ini menutup penggilingan sidik jari.
- `deviceId` ikut ditandatangani di jawaban pairing.
- `openEvent` wajib diberi `expectedMachineId` dan mengembalikan `{ plaintext, kid }` supaya pemanggil bisa menolak `kid` yang lebih rendah.
- Pengodean kanonis memberi tiap kolom JENIS (tidak ada, teks, angka, byte): kolom tidak ada berbeda dari teks kosong, dan angka berbeda dari teks. Jenis lain (objek, null, boolean) ditolak. Nilai `decision` diperiksa saat dijalankan.
- Galat dari callback `dataKeys` menjadi `CryptoError`; `loadSodium` boleh dicoba lagi setelah gagal.
- **Konvensi API:** fungsi `verify*` MENGEMBALIKAN boolean dan tidak melempar (pemanggil WAJIB memeriksanya); fungsi `open*` dan `unwrap*` MELEMPAR `CryptoError`.

## Keputusan dan batas
- **Versi libsodium-wrappers 0.8.4**, dipin persis (desain menyebut seri 0.7.x; 0.8.x memuat ESM yang benar dan lolos uji impor di Node/tsx dan Vite). Dimuat lazy: di PWA menjadi dua chunk terpisah (sekitar 120 kB dan 458 kB tidak terkompresi, WASM tertanam), tidak ikut bundel awal.
- **CSP PWA** harus memberi `'wasm-unsafe-eval'` (bagian 7 desain); itu dikerjakan di bagian C.
- **jsdom** memakai kelas `Uint8Array` yang berbeda dari Node sehingga libsodium menolak masukannya ("buffer must be a Uint8Array"); tes yang memanggil kripto memakai `// @vitest-environment node`. Browser sungguhan tidak terpengaruh.
- Tidak ada keadaan di sini: pemeriksaan `kid` yang lebih rendah, celah `seq`, `id` ganda, dan penyimpanan anti-replay adalah tanggung jawab pemanggil (bagian D dan issue #034).
