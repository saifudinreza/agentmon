---
title: "Rilis beta publik"
stage: "6"
size: M
labels: [chore, release, milestone-demo]
depends_on: [023, 031, 035, 038, 040, 041, 045, 046]
---

# #047 Rilis beta publik

**Tahap 6: Instalasi & rilis** · Ukuran M · Bergantung pada: [#023](023-rollback-dari-hp.md), [#031](031-risiko-di-hp.md), [#035](035-minimasi-data-server.md), [#038](038-policy-di-hp.md), [#040](040-swipe-review.md), [#041](041-rekap-dan-review-giliran.md), [#045](045-perintah-uninstall.md), [#046](046-onboarding-per-perangkat.md)

## Tujuan
Merilis versi publik pertama setelah gerbang rilis terpenuhi.

## Tahapan
1. Selesaikan semua asumsi dan pertanyaan terbuka di PRD §18.
2. Tentukan hosting produksi berdasarkan data dari [#021](021-deploy-staging.md), lalu deploy.
3. Publish paket ke npm.
4. Tulis README, panduan pengguna, kebijakan keamanan, dan halaman produk yang menjelaskan posisi review-first serta keterbatasan rollback dan penilai risiko.
5. Jalankan smoke test dari mesin bersih di ketiga OS.
6. Pakai setiap hari selama 2 minggu dan ukur metrik di PRD §17.

## Selesai bila
- [ ] Tiga pilar selesai dan sudah diukur.
- [ ] Smoke test lolos di ketiga OS.
- [ ] Selama 2 minggu, tidak ada insiden agent macet dan tidak ada aksi berbahaya yang lolos otomatis.

**Rujukan:** PRD §13.
