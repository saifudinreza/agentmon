---
title: "Pemicu notifikasi izin dan selesai"
stage: "3"
size: S
labels: [feature, server, bridge]
depends_on: [018, 027]
---

# #028 Pemicu notifikasi izin dan selesai

**Tahap 3: Diff & push** · Ukuran S · Bergantung pada: [#018](018-approve-deny-remote.md), [#027](027-service-worker-notifikasi.md)

## Tujuan
Mengirim notifikasi pada saat yang tepat, tanpa membanjiri pengguna.

## Tahapan
1. Picu notifikasi saat ada keputusan yang dibutuhkan dan saat agent selesai.
2. Gabungkan notifikasi per sesi.
3. Hapus notifikasi bila permintaan sudah diputuskan di perangkat lain.
4. Sediakan pengaturan jenis notifikasi.
5. Pusatkan logika pemicu di satu tempat, supaya policy di [#037](037-integrasi-policy-hook.md) mudah menyaringnya.

## Selesai bila
- [ ] Sepuluh permintaan beruntun tidak menghasilkan sepuluh notifikasi terpisah.
- [ ] Test membuktikan isi push tidak memuat kode atau isi perintah.

**Rujukan:** FR-30, FR-31, FR-33, FR-34.
