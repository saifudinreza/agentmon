---
title: "Tanda tangan keputusan dan perlindungan replay"
stage: "4"
size: M
labels: [feature, security, bridge, web]
depends_on: [033]
---

# #034 Tanda tangan keputusan dan perlindungan replay

**Tahap 4: E2E** · Ukuran M · Bergantung pada: [#033](033-enkripsi-payload.md)

## Tujuan
Mencegah relay yang disusupi memalsukan persetujuan.

## Tahapan
1. Buat HP menandatangani keputusan, perintah rollback ([#023](023-rollback-dari-hp.md)), dan perubahan aturan ([#038](038-policy-di-hp.md)).
2. Buat daemon memverifikasinya.
3. Ikat setiap keputusan ke permintaan, isi aksi, dan masa berlaku tertentu.

## Selesai bila
- [ ] Test membuktikan keputusan palsu, diputar ulang, atau untuk isi aksi berbeda ditolak.
- [ ] Tanda tangan yang gagal berujung ke alur izin normal, bukan persetujuan.

## Test wajib
- Tanda tangan yang sah diterima.
- Ditolak: tanda tangan palsu, kunci perangkat yang sudah dicabut, keputusan yang diputar ulang, keputusan untuk permintaan lain, keputusan untuk isi aksi yang berbeda (input berubah setelah diminta), keputusan kedaluwarsa, dan jam perangkat yang melenceng di luar batas.
- Semua penolakan berujung ke alur izin normal, tidak pernah persetujuan.
- Hal yang sama berlaku untuk perintah rollback dan perubahan aturan.
- Uji mutasi: matikan verifikasi tanda tangan. Test harus gagal.

**Rujukan:** PRD §13.
