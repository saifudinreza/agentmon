---
title: "Mode swipe per hunk"
stage: "5"
size: M
labels: [feature, web, pilar-2]
depends_on: [024, 031, 039]
---

# #040 Mode swipe per hunk

**Tahap 5: Review per hunk (Pilar 2)** · Ukuran M · Bergantung pada: [#024](024-diff-viewer-mobile.md), [#031](031-risiko-di-hp.md), [#039](039-terima-sebagian-umpan-balik.md)

## Tujuan
Membuat review per hunk yang cepat dan nyaman. Ini inti pembeda dari sisi pengalaman pengguna.

## Tahapan
1. Buat kartu per hunk dengan gestur setuju, tolak, dan komentar.
2. Sediakan tombol sebagai alternatif gestur.
3. Tampilkan progres, urungkan, dan ringkasan pilihan sebelum dikirim.
4. Minta konfirmasi tambahan untuk hunk berisiko tinggi.
5. Sediakan komentar cepat untuk penolakan umum.
6. Uji dengan pengguna nyata, lalu perbaiki.

## Selesai bila
- [ ] Bisa dipakai satu tangan di HP kecil.
- [ ] Menggulir kode panjang tidak memicu swipe, dan gestur tidak bentrok dengan gestur sistem.
- [ ] Tidak ada yang terkirim sebelum pengguna mengonfirmasi.
- [ ] Uji dengan minimal 3 orang sudah dicatat.

**Rujukan:** PRD §9, FR-90.
