---
title: "Diff viewer untuk layar HP"
stage: "3"
size: M
labels: [feature, web]
depends_on: [018]
---

# #024 Diff viewer untuk layar HP

**Tahap 3: Diff & push** · Ukuran M · Bergantung pada: [#018](018-approve-deny-remote.md)

## Tujuan
Membuat diff nyaman dibaca di layar HP.

## Tahapan
1. Bandingkan dua library diff di PRD, lalu pilih berdasarkan ukuran, keterbacaan, dan kemudahan dipakai untuk swipe per hunk.
2. Buat tampilan yang menangani baris panjang dan navigasi antar file serta hunk.
3. Muat diff viewer dan highlight belakangan, supaya app tetap ringan.
4. Tampilkan peringatan untuk path sensitif.

## Selesai bila
- [ ] Diff viewer tidak masuk bundle awal.
- [ ] Diff 1.000 baris tetap responsif di HP kelas menengah.
- [ ] Diff tetap terbaca sebelum highlight selesai dimuat.

**Rujukan:** FR-23. Komponen hunk dipakai ulang di [#040](040-swipe-review.md).
