---
title: "Rollback dari HP"
stage: "2.5"
size: M
labels: [feature, web, bridge, pilar-3, milestone-demo]
depends_on: [018, 022]
---

# #023 Rollback dari HP

**Tahap 2.5: Checkpoint (Pilar 3)** · Ukuran M · Bergantung pada: [#018](018-approve-deny-remote.md), [#022](022-checkpoint-git.md)

## Tujuan
Memungkinkan kembali ke titik sebelumnya dari HP dengan satu ketukan.

## Tahapan
1. Tampilkan aksi rollback di timeline.
2. Buat konfirmasi dengan pratinjau file yang berubah dan hal yang tidak bisa dibatalkan.
3. Tolak rollback saat agent masih berjalan di sesi itu.
4. Simpan keadaan saat ini sebelum rollback, supaya rollback bisa dibatalkan.

## Selesai bila
- [ ] File yang diubah, ditambah, dan dihapus kembali seperti semula.
- [ ] Rollback bisa dibatalkan.
- [ ] Pekerjaan setelah checkpoint tidak hilang tanpa peringatan.

## Test wajib
- Putaran penuh: ubah, tambah, dan hapus berkas, lalu rollback. Isinya harus sama persis dengan saat checkpoint.
- Rollback lalu batalkan rollback: kembali ke keadaan sebelum rollback.
- Rollback ditolak saat agent masih berjalan di sesi itu.
- Pratinjau menyebut semua berkas yang akan berubah, termasuk pekerjaan setelah checkpoint.
- Checkpoint hilang atau rusak: rollback ditolak dengan pesan jelas, tidak berhenti setengah jalan.
- Perintah rollback dari perangkat yang tidak dikenal atau sudah dicabut ditolak.

**Perhatian:** rollback bersifat destruktif. Tanda tangan perintahnya ditambahkan di [#034](034-keputusan-ditandatangani.md). **Rujukan:** FR-41.
