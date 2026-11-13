---
title: "Ringkasan dan pengelompokan per maksud berbasis AI"
stage: "5"
size: M
labels: [feature, bridge, pilar-2, opt-in]
depends_on: [041]
---

# #042 Ringkasan dan pengelompokan per maksud berbasis AI

**Tahap 5: Review per hunk (Pilar 2)** · Ukuran M · Bergantung pada: [#041](041-rekap-dan-review-giliran.md)

## Tujuan
Menyediakan ringkasan dan pengelompokan per maksud berbasis AI, sebagai opsi yang berjalan di laptop.

## Tahapan
1. Buat pengaturan opt-in yang menjelaskan pemakaian kuota agent pengguna.
2. Jalankan agent milik pengguna secara headless, tanpa memicu hook AgentMon.
3. Hasilkan ringkasan giliran dan kelompok hunk dalam Bahasa Indonesia, lalu validasi hasilnya.
4. Beri label "dibuat AI" di tampilan.
5. Kembali ke ringkasan deterministik bila gagal atau lambat.

## Selesai bila
- [ ] Tidak ada hook yang berjalan rekursif.
- [ ] Test membuktikan instruksi tersembunyi di dalam kode tidak mengubah level risiko.
- [ ] Mematikan fitur menghentikan seluruh pemanggilan.

**Perhatian:** isi diff tidak dipercaya, dan hasil AI tidak boleh memengaruhi risiko atau policy. Beta tidak bergantung pada issue ini. **Rujukan:** PRD §9, FR-94.
