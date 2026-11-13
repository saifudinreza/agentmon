---
title: "Policy engine"
stage: "4.5"
size: M
labels: [feature, bridge, security, pilar-1]
depends_on: [030]
---

# #036 Policy engine

**Tahap 4.5: Policy (Pilar 1)** · Ukuran M · Bergantung pada: [#030](030-penilai-risiko.md)

## Tujuan
Membuat mesin aturan yang menentukan aksi mana yang diizinkan, ditanyakan, atau ditolak.

## Tahapan
1. Pelajari delapan aturan keselamatan di PRD §9.
2. Tulis test untuk aturan keselamatan itu lebih dulu.
3. Rancang format aturan milik pengguna.
4. Implementasikan evaluasi, dengan default bertanya.
5. Buat perintah untuk menguji aturan tanpa menjalankan aksi.
6. Sediakan preset contoh yang tidak aktif secara default.

## Selesai bila
- [ ] Aksi risiko tinggi tidak pernah diizinkan otomatis, apa pun aturannya.
- [ ] Perintah aman yang dirantai dengan perintah lain tidak ikut lolos.
- [ ] Aturan izinkan dari dalam repo diabaikan.
- [ ] File aturan yang rusak berarti tidak ada auto-approve, dan pengguna diberi tahu.
- [ ] Tanpa file aturan, tidak ada aksi pengubah yang berjalan otomatis.

## Test wajib
- Delapan aturan keselamatan di PRD §9, ditulis sebelum kodenya.
- Risiko tinggi tidak pernah diizinkan, bahkan dengan aturan pengguna "izinkan semua".
- Perintah aman yang dirantai dengan perintah lain tidak ikut lolos.
- Aturan izinkan dari dalam repo diabaikan.
- File aturan rusak, kosong, berversi asing, atau tidak ada: tidak ada auto-approve.
- Urutan prioritas antaraturan diuji, misalnya tolak mengalahkan izinkan.
- Perintah uji aturan tidak pernah menjalankan aksinya.
- Uji mutasi: lewati pemeriksaan risiko tinggi atau aturan dari repo. Test harus gagal.

**Perhatian:** auto-approve menambah permukaan serangan. Issue ini belum tersambung ke hook. **Rujukan:** FR-80, FR-81, FR-82, FR-84.
