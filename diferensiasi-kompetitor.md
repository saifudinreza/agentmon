# Diferensiasi Agent Monitor vs Kompetitor

Status: hasil riset 31 Okt 2026. Belum ada kode.

## 1. Peta kompetitor

| Produk | Agent | Yang sudah dilakukan |
|---|---|---|
| Claude Code Remote Control (resmi Anthropic) | Claude Code saja | Lanjutkan sesi dari app Claude, approve/deny izin, kirim prompt. Mesin harus tetap menyala. |
| Omnara | Claude Code, Codex | Monitor, lihat diff, approve satu ketukan, push notification, opsi cloud handoff, Apple Watch. |
| Happy Coder (open source, MIT) | Claude Code, Codex | Pairing QR, enkripsi end-to-end, push notification, diff, input suara, app iOS/Android/web. |
| Happier, SeaWork, Grass | Beragam | Fitur serupa. Grass menonjol karena agent-agnostic dan VM cloud. |
| Cursor Mobile | Cursor saja | Akses mobile terikat ekosistem Cursor. |

Kesimpulan: fitur dasar (monitor, diff, approve, push, multi-agent, E2E) sudah jadi standar. Bersaing di situ kalah. Semua produk ini berposisi sebagai remote control: "sampaikan aksi agent ke HP".

## 2. Celah yang bisa diisi

- Approval cenderung berupa "ketuk Approve" tanpa bantuan memutuskan. Hasilnya approval fatigue: akhirnya approve semua tanpa dibaca.
- Review kode di HP disebut kurang ergonomis oleh pengguna Remote Control. Diff mentah di layar kecil melelahkan.
- Tidak ada rem darurat berbasis checkpoint yang jelas (kembali ke kondisi sebelum aksi).
- Hampir semua berbahasa Inggris dan butuh install app/akun.

## 3. Posisi yang diusulkan

**Review-first, bukan remote-control-first.** Aplikasi ini bukan sekadar meneruskan layar agent, tapi membantu kamu memutuskan dengan cepat dan aman.

Tagline kerja: "Putuskan dengan yakin, bukan sekadar ketuk Approve."

## 4. Tiga pilar pembeda

### Pilar 1: Approval berbasis risiko dan kebijakan
- Setiap permintaan izin diberi level risiko (rendah, sedang, tinggi) beserta alasan singkat dalam bahasa manusia.
- Pola berbahaya disorot: hapus massal, sentuh file rahasia (.env, kunci), akses jaringan, instal dependency, push ke git, ubah file di luar folder proyek.
- Policy engine: aturan yang kamu tulis sendiri, misal "test dan lint selalu boleh", "apa pun yang menyentuh .env selalu tanya".
- Hasil: yang aman jalan otomatis, yang berisiko baru naik ke HP. Notifikasi jadi sedikit tapi bermakna.

### Pilar 2: Review diff yang ramah HP
- Ringkasan perubahan dalam bahasa biasa di atas diff ("menambah validasi email di form login, mengubah 3 file").
- Mode swipe per bagian perubahan (hunk): geser untuk setuju, geser untuk tolak, ketuk untuk beri komentar.
- Komentar dan penolakan dikirim kembali ke agent sebagai umpan balik, jadi agent memperbaiki, bukan sekadar berhenti.
- Perubahan dikelompokkan berdasarkan maksud, bukan urutan file.

### Pilar 3: Checkpoint dan rollback
- Sebelum tiap aksi yang disetujui, bridge menyimpan snapshot (misal commit sementara atau stash).
- Satu ketukan untuk kembali ke titik sebelumnya dari HP.
- Rekap sesi di akhir: apa yang diubah, berapa lama, apa yang ditolak.

## 5. Pembeda tambahan (opsional, tahap lanjut)

- **Approval lewat chat yang sudah dipakai** (Telegram, Discord, WhatsApp): tanpa install app, cocok untuk persetujuan cepat. Detail dan diff panjang tetap di PWA.
- **Bahasa Indonesia sebagai default**: penjelasan risiko dan ringkasan diff dalam Bahasa Indonesia.
- **Hemat data**: diff dikompres, mode offline-tolerant (antrian keputusan), cocok untuk sinyal tidak stabil.
- **Self-host mudah**: satu perintah untuk menjalankan server sendiri, data tidak lewat pihak ketiga.
- **Second opinion**: kirim diff ke agent kedua untuk ditinjau sebelum kamu putuskan.

## 6. Dampak ke rencana tahapan

Tambahan di rencana utama:
- Setelah tahap 3 (diff viewer): tambah penilai risiko sederhana berbasis aturan (tanpa AI dulu).
- Setelah tahap 4: policy engine.
- Setelah tahap 5: swipe review per hunk dan umpan balik ke agent.
- Checkpoint/rollback bisa dikerjakan setelah tahap 2, karena hanya butuh git.

## 7. Hal yang perlu diverifikasi sebelum membangun

- Apakah hook PreToolUse Claude Code bisa mengembalikan alasan penolakan ke agent sebagai umpan balik (kemungkinan besar bisa, cek dokumentasi resmi).
- Apakah persetujuan sebagian (terima sebagian hunk) bisa dilakukan dengan memodifikasi input tool, atau hanya terima/tolak utuh. Jika hanya utuh, fallback: tolak utuh + komentar per hunk.
- Dukungan hook/approval di Codex dan Antigravity (cek dokumentasi terbaru).
- Seberapa akurat penilaian risiko berbasis aturan; mulai sederhana dan konservatif (curiga dulu).

## 8. Risiko pembeda ini

- Penilai risiko yang salah memberi rasa aman palsu. Aturan harus konservatif: ragu berarti tanya.
- Auto-approve lewat policy menambah permukaan serangan. Default harus ketat, dan aksi berbahaya tidak boleh bisa di-auto-approve.
- Kompetitor besar bisa menyalin fitur ini. Keunggulan jangka panjang: kualitas UX review dan kontrol keamanan.
