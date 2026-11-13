---
title: "Desain E2E dan threat model"
stage: "4"
size: M
labels: [spike, security]
depends_on: [018]
---

# #032 Desain E2E dan threat model

**Tahap 4: E2E** · Ukuran M · Bergantung pada: [#018](018-approve-deny-remote.md)

## Tujuan
Merancang enkripsi end-to-end secara tertulis sebelum diimplementasikan.

## Tahapan
1. Tulis threat model: apa yang dilihat relay dan apa yang bisa dilakukan relay jahat.
2. Rancang pertukaran kunci lewat QR, kunci per pasangan, rotasi, dan dukungan banyak perangkat.
3. Tentukan metadata yang masih terlihat oleh relay beserta alasannya.
4. Tentukan dampaknya ke riwayat dan perangkat baru.
5. Tulis rencana migrasi data lama, lalu minta tinjauan.

## Selesai bila
- [ ] `docs/security-e2e.md` selesai dan sudah ditinjau.
- [ ] Desain hanya memakai primitif standar dari libsodium.

**Perhatian:** jangan membuat kriptografi sendiri. Tugas ini sebaiknya dikerjakan atau ditinjau oleh orang berpengalaman. **Rujukan:** PRD §13, G5.
