---
title: "Terima sebagian dan umpan balik ke agent"
stage: "5"
size: L
labels: [feature, bridge, claude-code, pilar-2]
depends_on: [009, 034]
---

# #039 Terima sebagian dan umpan balik ke agent

**Tahap 5: Review per hunk (Pilar 2)** · Ukuran L · Bergantung pada: [#009](009-kalkulator-diff.md), [#034](034-keputusan-ditandatangani.md)

## Tujuan
Memungkinkan pengguna menerima sebagian perubahan, dan mengirim penolakan sebagai umpan balik yang membuat agent memperbaiki.

## Tahapan
1. Tinjau hasil [#003](003-spike-hook-logger-claude-code.md) tentang mengubah input dan menyampaikan catatan ke agent.
2. Terima keputusan per hunk dari HP.
3. Terapkan tiga hasil: semua diterima, sebagian diterima dengan input yang disusun ulang, atau semua ditolak.
4. Sampaikan hunk yang ditolak beserta komentarnya kepada agent.
5. Periksa ulang isi file sebelum mengembalikan keputusan.
6. Siapkan fallback bila terima sebagian tidak bisa dilakukan: tolak utuh dengan komentar per hunk.

## Selesai bila
- [ ] Hasil file sama persis dengan pilihan pengguna, termasuk pada banyak hunk dan akhir baris Windows.
- [ ] Jika file berubah selama menunggu, keputusan tidak diterapkan dan kembali ke alur izin normal.
- [ ] Pada uji nyata, Claude tidak berasumsi seluruh usulannya diterapkan, dan memperbaiki sesuai komentar.

**Rujukan:** PRD §11, FR-26, FR-91.
