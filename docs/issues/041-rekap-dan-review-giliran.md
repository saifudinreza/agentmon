---
title: "Rekap sesi dan review per giliran"
stage: "5"
size: M
labels: [feature, bridge, web, pilar-2, pilar-3, milestone-demo]
depends_on: [023, 037, 040]
---

# #041 Rekap sesi dan review per giliran

**Tahap 5: Review per hunk (Pilar 2)** · Ukuran M · Bergantung pada: [#023](023-rollback-dari-hp.md), [#037](037-integrasi-policy-hook.md), [#040](040-swipe-review.md)

## Tujuan
Memberi gambaran utuh saat agent selesai, karena hook hanya melihat satu aksi dalam satu waktu. Ini demo tahap 5.

## Tahapan
1. Pelajari konsep dua tingkat review di PRD §6.
2. Saat agent selesai, susun rekap: file berubah, durasi, yang ditolak, dan yang di-auto-approve.
3. Sediakan diff gabungan satu giliran dari checkpoint.
4. Dari rekap, sediakan aksi kirim umpan balik atau rollback.
5. Buat umpan balik melanjutkan pekerjaan agent, dengan pencegahan loop.

## Selesai bila
- [ ] Umpan balik dari rekap membuat Claude melanjutkan pekerjaan.
- [ ] Tidak ada loop tanpa akhir.
- [ ] Giliran tanpa perubahan file tidak mengirim notifikasi rekap.
- [ ] Menunggu tanggapan rekap tidak terasa macet di terminal.

**Rujukan:** FR-44, FR-93.
