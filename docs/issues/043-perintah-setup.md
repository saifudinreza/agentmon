---
title: "Perintah agentmon setup"
stage: "6"
size: L
labels: [feature, bridge, install]
depends_on: [008, 013]
---

# #043 Perintah agentmon setup

**Tahap 6: Instalasi & rilis** · Ukuran L · Bergantung pada: [#008](008-hook-menahan-keputusan.md), [#013](013-pairing-qr.md)

## Tujuan
Membuat instalasi selesai dalam 2 menit dengan satu perintah.

## Tahapan
1. Deteksi agent yang terpasang.
2. Tulis konfigurasi hook `http` untuk Claude Code, berisi alamat `127.0.0.1`, port, dan token dari daemon (lihat `docs/daemon.md`). Hook `http` tidak menjalankan program, jadi tidak ada salinan AgentMon yang perlu dipasang untuk hook itu. Pasang salinan stabil hanya untuk daemon dan, bila diperlukan, jalur Codex. Konfigurasi ini memuat token: pertahankan izin berkas pengaturan yang sudah ada (jangan dilonggarkan), jangan pernah mencatat isinya ke log, dan jangan menaruhnya di dalam repo proyek.
3. Gabungkan hooks ke konfigurasi yang ada, dan buat backup.
4. Tampilkan QR pairing dan ringkasan akhir.
5. Berikan pesan yang jelas untuk prasyarat yang kurang.

## Selesai bila
- [ ] Hooks dan pengaturan milik pengguna tetap utuh.
- [ ] Setup bisa dijalankan dua kali tanpa hook ganda.
- [ ] Path dengan spasi dan path Windows berfungsi.
- [ ] Waktu dari awal sampai pairing ≤ 2 menit.

**Rujukan:** FR-50 sampai FR-53, FR-58.
