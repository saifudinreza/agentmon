---
title: "Backend Web Push (VAPID)"
stage: "3"
size: S
labels: [feature, server]
depends_on: [012]
---

# #026 Backend Web Push (VAPID)

**Tahap 3: Diff & push** · Ukuran S · Bergantung pada: [#012](012-skema-database.md)

## Tujuan
Menyiapkan server untuk mengirim notifikasi push tanpa layanan pihak ketiga.

## Tahapan
1. Siapkan pengelolaan kunci Web Push.
2. Simpan dan hapus langganan per perangkat.
3. Buat pengiriman notifikasi.
4. Hapus otomatis langganan yang sudah mati.

## Selesai bila
- [ ] Notifikasi berhasil terkirim ke Android dan iOS.
- [ ] Langganan mati terhapus otomatis.

**Rujukan:** FR-30, FR-31.
