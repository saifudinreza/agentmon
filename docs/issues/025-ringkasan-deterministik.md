---
title: "Ringkasan deterministik di atas diff"
stage: "3"
size: S
labels: [feature, bridge, web, pilar-2]
depends_on: [009, 024]
---

# #025 Ringkasan deterministik di atas diff

**Tahap 3: Diff & push** · Ukuran S · Bergantung pada: [#009](009-kalkulator-diff.md), [#024](024-diff-viewer-mobile.md)

## Tujuan
Membantu pengguna memahami inti perubahan sebelum membaca diff, tanpa memakai AI.

## Tahapan
1. Buat daemon menyusun ringkasan satu aksi dari data diff: file, jumlah baris, dan nama fungsi bila terdeteksi.
2. Sajikan dalam Bahasa Indonesia lewat i18n.
3. Tampilkan di atas diff.

## Selesai bila
- [ ] Ringkasan terbaca tanpa memuat diff viewer.
- [ ] Bahasa pemrograman yang tidak dikenali tetap menghasilkan ringkasan dasar.
- [ ] Ringkasan tidak mengklaim hal yang tidak terbukti dari diff.

**Rujukan:** PRD §9, FR-92.
