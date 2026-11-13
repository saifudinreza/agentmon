---
title: "Backlog: second opinion dari agent kedua"
stage: "Backlog"
size: M
labels: [feature, backlog]
depends_on: [042, 047]
---

# #056 Backlog: second opinion dari agent kedua

**Backlog: Pembeda tambahan** · Ukuran M · Bergantung pada: [#042](042-ringkasan-ai-lokal.md), [#047](047-rilis-beta-publik.md)

## Tujuan
Memberi pendapat kedua dari agent lain sebelum pengguna memutuskan.

## Tahapan
1. Pakai ulang mekanisme headless dari [#042](042-ringkasan-ai-lokal.md).
2. Kirim diff ke agent kedua secara opt-in.
3. Tampilkan hasilnya sebagai pendapat berlabel.
4. Beri batas waktu agar tidak menghabiskan masa tunggu keputusan.

## Selesai bila
- [ ] Kegagalan agent kedua tidak menghalangi keputusan.
- [ ] Biaya dan waktu tiap tinjauan terlihat oleh pengguna.
- [ ] Hasilnya tidak memengaruhi risiko atau policy.

**Rujukan:** FR-103.
