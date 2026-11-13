---
title: "Autostart daemon lintas OS"
stage: "6"
size: M
labels: [feature, bridge, install]
depends_on: [043]
---

# #044 Autostart daemon lintas OS

**Tahap 6: Instalasi & rilis** · Ukuran M · Bergantung pada: [#043](043-perintah-setup.md)

## Tujuan
Membuat daemon otomatis berjalan saat laptop menyala.

## Tahapan
1. Terapkan mekanisme autostart per pengguna di Windows, macOS, dan Linux, tanpa hak admin.
2. Tambahkan restart otomatis setelah crash.
3. Buat perintah `status`.

## Selesai bila
- [ ] Daemon jalan kembali setelah restart di ketiga OS.
- [ ] Tidak ada jendela terminal yang muncul di Windows.
- [ ] `status` melaporkan daemon, relay, dan jumlah perangkat.

**Rujukan:** FR-52.
