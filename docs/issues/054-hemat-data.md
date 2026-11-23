---
title: "Backlog: hemat data dan antrean keputusan"
stage: "Backlog"
size: M
labels: [feature, backlog]
depends_on: [047]
---

# #054 Backlog: hemat data dan antrean keputusan

**Backlog: Pembeda tambahan** · Ukuran M · Bergantung pada: [#047](047-rilis-beta-publik.md)

## Tujuan
Membuat AgentMon nyaman dipakai pada sinyal yang tidak stabil.

## Tahapan
1. Ukur pemakaian data saat ini.
2. Kompres diff sebelum dienkripsi.
3. Buat antrean keputusan saat offline.
4. Buat riwayat bisa dibaca saat offline.

## Selesai bila
- [ ] Pemakaian data per sesi turun secara terukur.
- [ ] Keputusan dari antrean tidak pernah berlaku untuk aksi yang kedaluwarsa atau sudah berubah.

**Rujukan:** FR-14, FR-101.
