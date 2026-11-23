---
title: "Setup dan uninstall Codex"
stage: "7"
size: S
labels: [feature, bridge, install, codex]
depends_on: [045, 049]
---

# #050 Setup dan uninstall Codex

**Tahap 7: Codex** · Ukuran S · Bergantung pada: [#045](045-perintah-uninstall.md), [#049](049-adapter-codex.md)

## Tujuan
Membuat setup dan uninstall juga mencakup Codex.

## Tahapan
1. Gabungkan konfigurasi hook Codex dengan yang ada, dan buat backup.
2. Pandu pengguna melakukan trust lewat `/hooks`.
3. Periksa versi minimum.
4. Perluas uninstall untuk Codex.

## Selesai bila
- [ ] Konfigurasi notifikasi milik pengguna tidak hilang.
- [ ] Versi Codex lama mendapat pesan jelas, dan setup Claude Code tetap jalan.
- [ ] Uninstall memulihkan konfigurasi Codex.

**Rujukan:** FR-59.
