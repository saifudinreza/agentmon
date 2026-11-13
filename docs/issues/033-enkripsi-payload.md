---
title: "Enkripsi payload daemon dan PWA"
stage: "4"
size: L
labels: [feature, security, bridge, web, shared]
depends_on: [032]
---

# #033 Enkripsi payload daemon dan PWA

**Tahap 4: E2E** · Ukuran L · Bergantung pada: [#032](032-desain-e2e-threat-model.md)

## Tujuan
Membuat relay hanya melihat data terenkripsi, sesuai desain di [#032](032-desain-e2e-threat-model.md).

## Tahapan
1. Buat fungsi enkripsi dan dekripsi bersama untuk daemon dan PWA.
2. Tambahkan pertukaran kunci saat pairing.
3. Enkripsi semua isi pesan.
4. Terapkan rotasi kunci saat perangkat dicabut.
5. Muat library kripto belakangan, supaya app tetap ringan.

## Selesai bila
- [ ] Test membuktikan data penanda tidak muncul sebagai plaintext di database atau log relay.
- [ ] Perangkat yang dicabut tidak bisa membaca pesan baru.
- [ ] Pesan yang dimodifikasi ditolak.

## Test wajib
- Enkripsi lalu dekripsi menghasilkan data semula, dengan kode yang sama di daemon dan PWA.
- Ditolak: pesan yang diubah satu byte, nonce yang dipakai ulang, dan kunci yang salah.
- Data penanda tidak muncul sebagai plaintext di database maupun log relay.
- Perangkat yang dicabut tidak bisa membaca pesan setelah rotasi kunci.
- Gagal dekripsi tidak membuat daemon crash dan tidak pernah dianggap persetujuan.

Pakai vektor uji resmi dari library bila tersedia. Jangan menulis algoritma kripto sendiri.
