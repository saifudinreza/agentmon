---
title: "Sambungkan policy ke alur hook"
stage: "4.5"
size: M
labels: [feature, bridge, pilar-1, milestone-demo]
depends_on: [022, 034, 036]
---

# #037 Sambungkan policy ke alur hook

**Tahap 4.5: Policy (Pilar 1)** · Ukuran M · Bergantung pada: [#022](022-checkpoint-git.md), [#034](034-keputusan-ditandatangani.md), [#036](036-policy-engine.md)

## Tujuan
Membuat aksi yang aman berjalan otomatis, dan hanya yang perlu keputusan yang naik ke HP. Ini demo tahap 4.5.

## Tahapan
1. Sambungkan penilai risiko dan policy ke alur hook.
2. Catat setiap keputusan otomatis beserta aturan penyebabnya, lalu tampilkan berbeda di timeline.
3. Pastikan auto-approve tetap membuat checkpoint.
4. Kirim alasan yang jelas ke agent saat ditolak otomatis.
5. Tangani mode izin agent sesuai keputusan di PRD §18.

## Selesai bila
- [ ] Aturan deny dan ask milik agent tetap berlaku.
- [ ] Auto-approve tidak memicu push.
- [ ] Jumlah permintaan ke HP pada skenario yang sama sudah diukur, sebelum dan sesudah policy.
- [ ] Mode pause dan aturan anti-macet tetap berlaku.

## Test wajib
- Test integrasi dengan fixture: aksi aman diizinkan otomatis dan tercatat bersama aturan penyebabnya, sedangkan aksi berbahaya naik ke HP.
- Aturan tolak dan tanya milik agent tetap berlaku.
- Auto-approve tetap membuat checkpoint. Perilaku saat checkpoint gagal ditetapkan di issue ini lalu diuji.
- Auto-approve tidak memicu push.
- Policy error atau daemon mati berujung ke alur izin normal, tidak pernah izinkan.
- Uji mutasi: buat policy error menghasilkan izinkan. Test harus gagal.

**Rujukan:** PRD §8, FR-13, FR-83.
