---
title: "Deploy staging relay dan PWA"
stage: "2"
size: S
labels: [chore, infra]
depends_on: [012, 015]
---

# #021 Deploy staging relay dan PWA

**Tahap 2: Relay & PWA** · Ukuran S · Bergantung pada: [#012](012-skema-database.md), [#015](015-pwa-shell.md)

## Tujuan
Menjalankan relay dan PWA di lingkungan HTTPS, karena service worker dan push memerlukannya.

## Tahapan
1. Deploy relay, database, dan PWA ke layanan yang dipilih di PRD.
2. Atur konfigurasi dan rahasia di luar repo.
3. Otomatiskan deploy dan migrasi.
4. Tulis panduan pengembangan lokal memakai tunnel.
5. Ukur waktu bangun relay di free tier.

## Selesai bila
- [ ] Deploy berjalan otomatis dari branch utama.
- [ ] Tidak ada rahasia di repo.
- [ ] Waktu bangun relay tercatat sebagai dasar keputusan hosting.

**Rujukan:** PRD §15.
