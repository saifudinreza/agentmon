---
title: "Perintah agentmon uninstall"
stage: "6"
size: S
labels: [feature, bridge, install]
depends_on: [043, 044]
---

# #045 Perintah agentmon uninstall

**Tahap 6: Instalasi & rilis** · Ukuran S · Bergantung pada: [#043](043-perintah-setup.md), [#044](044-autostart-daemon.md)

## Tujuan
Memungkinkan AgentMon dihapus dengan bersih.

## Tahapan
1. Hapus hanya entri hook milik AgentMon.
2. Hentikan daemon dan hapus autostart.
3. Cabut mesin dari relay.
4. Tawarkan penghapusan data lokal dan checkpoint.

## Selesai bila
- [ ] Setelah setup lalu uninstall, isi konfigurasi sama dengan semula.
- [ ] Hook milik pengguna yang ditambahkan setelah setup tetap utuh.
- [ ] Sesudah uninstall, agent berjalan normal tanpa error hook.

**Perhatian:** jangan sekadar memulihkan backup, karena pengguna bisa saja mengubah konfigurasi setelah setup. **Rujukan:** FR-57.
