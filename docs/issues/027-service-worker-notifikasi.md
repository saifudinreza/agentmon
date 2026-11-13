---
title: "Service worker dan izin notifikasi"
stage: "3"
size: M
labels: [feature, web]
depends_on: [015, 016, 026]
---

# #027 Service worker dan izin notifikasi

**Tahap 3: Diff & push** · Ukuran M · Bergantung pada: [#015](015-pwa-shell.md), [#016](016-layar-pairing-pwa.md), [#026](026-web-push-backend.md)

## Tujuan
Menerima dan menampilkan notifikasi di HP, serta menangani aturan khusus iOS.

## Tahapan
1. Buat alur meminta izin yang dipicu ketukan pengguna.
2. Deteksi apakah app di iOS dibuka dari home screen.
3. Tampilkan notifikasi yang masuk.
4. Arahkan ketukan notifikasi ke layar yang tepat.
5. Tangani kondisi izin ditolak.

## Selesai bila
- [ ] Mengetuk notifikasi membuka permintaan yang tepat, baik app tertutup maupun terbuka.
- [ ] Setiap push selalu menampilkan notifikasi yang terlihat.
- [ ] Di iOS, app menampilkan panduan dan tidak meminta izin sebelum dibuka dari home screen.

**Rujukan:** FR-32, FR-55.
