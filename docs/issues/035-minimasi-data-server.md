---
title: "Minimasi data di relay"
stage: "4"
size: S
labels: [chore, security, server]
depends_on: [033]
---

# #035 Minimasi data di relay

**Tahap 4: E2E** · Ukuran S · Bergantung pada: [#033](033-enkripsi-payload.md)

## Tujuan
Memastikan relay hanya menyimpan data yang benar-benar diperlukan.

## Tahapan
1. Migrasikan penyimpanan sehingga isi pesan hanya berupa ciphertext.
2. Pastikan isi notifikasi generik atau terenkripsi.
3. Audit log dan tabel server.
4. Dokumentasikan data plaintext yang tersisa.

## Selesai bila
- [ ] Data plaintext yang tersisa sesuai dengan desain [#032](032-desain-e2e-threat-model.md).
- [ ] Audit tidak menemukan data pengguna di log.

**Rujukan:** FR-34.
