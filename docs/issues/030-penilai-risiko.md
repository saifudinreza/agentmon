---
title: "Penilai risiko berbasis aturan"
stage: "3.5"
size: M
labels: [feature, bridge, security, pilar-1]
depends_on: [009, 018]
---

# #030 Penilai risiko berbasis aturan

**Tahap 3.5: Risiko (Pilar 1)** · Ukuran M · Bergantung pada: [#009](009-kalkulator-diff.md), [#018](018-approve-deny-remote.md)

## Tujuan
Memberi setiap permintaan level risiko dan alasan yang mudah dipahami, tanpa AI.

## Tahapan
1. Pelajari daftar level dan pola berbahaya di PRD §9.
2. Susun korpus test berisi perintah berbahaya, termasuk yang disamarkan, dan perintah aman yang umum.
3. Buat penilai risiko sebagai logika murni yang mudah dites.
4. Tangani perintah berantai dan penyamaran path dengan konservatif.
5. Tulis alasan dalam Bahasa Indonesia dan dokumentasikan level di `docs/risk-levels.md`.

## Selesai bila
- [ ] Tidak ada perintah berbahaya di korpus yang bernilai rendah.
- [ ] Tingkat alarm palsu pada perintah aman sudah diukur.
- [ ] Waktu penilaian memenuhi target di PRD §14.

## Test wajib
- Korpus perintah berbahaya, termasuk yang disamarkan (tanda kutip, variabel, encoding, perintah berantai dengan `;`, `&&`, `|`, dan subshell): tidak ada yang bernilai rendah.
- Varian untuk alat `Bash` dan `PowerShell`.
- Path yang disamarkan: `../`, symlink, beda huruf besar dan kecil di Windows, path absolut ke luar proyek, dan nama mirip `.env`.
- Input rusak, kosong, sangat panjang, atau alat yang tidak dikenal: tidak bernilai rendah dan tidak melempar error.
- Penjelasan agent menyebut "aman" tetapi perintahnya berbahaya: tetap dinilai dari perintahnya.
- Alarm palsu diukur pada daftar perintah aman yang umum.
- Uji mutasi: hapus satu pola berbahaya atau ubah nilai bawaan menjadi rendah. Test harus gagal.

**Perhatian:** ragu berarti tanya. Input yang tidak bisa dinilai atau menyebabkan error tidak boleh bernilai rendah. Nilai dari input tool yang sebenarnya, jangan dari penjelasan agent. **Rujukan:** FR-70 sampai FR-74.
