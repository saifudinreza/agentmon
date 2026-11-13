---
title: "Uji perangkat nyata tahap 3"
stage: "3"
size: S
labels: [test, milestone-demo]
depends_on: [024, 028]
---

# #029 Uji perangkat nyata tahap 3

**Tahap 3: Diff & push** · Ukuran S · Bergantung pada: [#024](024-diff-viewer-mobile.md), [#028](028-pemicu-notifikasi.md)

## Tujuan
Memastikan PWA dan push bekerja di perangkat nyata, karena hal ini sulit dites otomatis.

## Tahapan
1. Susun matriks uji: Android, iOS, layar terkunci, app tertutup, jaringan seluler, dan relay yang baru bangun.
2. Jalankan matriks dan catat hasilnya di `docs/device-test-matrix.md`.
3. Buat issue baru untuk setiap masalah.
4. Pakai untuk pekerjaan nyata selama minimal 3 hari.

## Selesai bila
- [ ] Semua sel teruji atau ditandai jelas "belum diuji".
- [ ] Semua masalah yang ditemukan sudah tercatat sebagai issue.
