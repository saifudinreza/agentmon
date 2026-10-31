# PRD: AgentMon

| | |
|---|---|
| **Nama** | AgentMon (nama sementara) |
| **Status** | Draft v2, perencanaan, belum ada kode |
| **Tanggal** | 31 Oktober 2026 |
| **Sumber** | `alur-stack-dan-persiapan.md`, `diferensiasi-kompetitor.md` |
| **Rincian kerja** | [`docs/issues/`](docs/issues/README.md) |

> **Catatan sumber.** Bagian yang bukan berasal dari dokumen sumber ditandai **[Asumsi]**. Keputusan dan pertanyaan yang tersisa ada di [bagian 18](#18-asumsi-dan-pertanyaan-terbuka).

---

## 1. Ringkasan

AgentMon membantu developer **memutuskan dengan cepat dan aman** apa yang boleh dilakukan coding agent (Claude Code dan Codex CLI), dari HP. Agent tetap berjalan di laptop seperti biasa. Aksi yang aman berjalan sesuai aturan pengguna. Aksi yang berisiko naik ke HP beserta penjelasan risikonya, ringkasan, dan diff yang bisa direview per bagian. Kalau ada keputusan yang keliru, pengguna bisa kembali ke titik sebelumnya dengan satu ketukan.

AgentMon terpasang lewat **hooks**, jadi pengguna tetap mengetik `claude` atau `codex` tanpa perintah pengganti.

**Tagline kerja:** "Putuskan dengan yakin, bukan sekadar ketuk Approve."

## 2. Masalah

1. **Developer terikat ke laptop saat agent bekerja.** Prompt izin yang tidak terjawab membuat pekerjaan tertunda.
2. **Approval fatigue.** Remote control yang ada umumnya hanya menyediakan tombol Approve, tanpa bantuan memutuskan. Akhirnya semua disetujui tanpa dibaca.
3. **Diff mentah melelahkan di layar kecil.** Pengguna Remote Control menyebut review kode di HP kurang ergonomis.
4. **Tidak ada rem darurat yang jelas** untuk kembali ke kondisi sebelum sebuah aksi.
5. **Hambatan masuk.** Hampir semua produk berbahasa Inggris dan butuh install app atau akun.

## 3. Posisi di pasar

### Peta kompetitor (riset 31 Oktober 2026)

| Produk | Agent | Yang sudah dilakukan |
|---|---|---|
| Claude Code Remote Control (resmi) | Claude Code | Lanjutkan sesi dari app Claude, approve/deny, kirim prompt. |
| Omnara | Claude Code, Codex | Monitor, diff, approve satu ketukan, push, cloud handoff, Apple Watch. |
| Happy Coder (MIT) | Claude Code, Codex | Pairing QR, E2E, push, diff, input suara, app iOS/Android/web. |
| Happier, SeaWork, Grass | Beragam | Fitur serupa. Grass agent-agnostic dengan VM cloud. |
| Cursor Mobile | Cursor | Terikat ekosistem Cursor. |

### Yang tidak jadi pembeda, dan yang jadi pembeda

Monitor, diff, approve, push, multi-agent, dan E2E sudah menjadi standar. Fitur-fitur itu tetap dibangun karena wajib ada, tetapi tidak dijadikan alasan orang memilih AgentMon.

**Posisi: review-first, bukan remote-control-first.**

| | Remote control pada umumnya | AgentMon |
|---|---|---|
| Permintaan izin | Semua dikirim ke HP | Disaring aturan, hanya yang perlu keputusan yang naik |
| Bantuan memutuskan | Tombol Approve | Level risiko dan alasan dalam bahasa manusia |
| Review | Diff mentah | Ringkasan, swipe per hunk |
| Menolak | Agent berhenti | Komentar jadi umpan balik, agent memperbaiki |
| Keputusan keliru | Perbaiki manual | Rollback satu ketukan |
| Memulai | Install app, sering dengan akun | PWA lewat QR, tanpa akun, tanpa perintah pengganti |
| Bahasa | Inggris | Indonesia sebagai default |

**Keunggulan jangka panjang.** Kompetitor besar bisa menyalin fitur ini. Yang dijaga adalah kualitas UX review dan kontrol keamanan.

## 4. Tujuan dan non-tujuan

### Tujuan
- **G1. Keputusan yang yakin.** Setiap permintaan yang naik ke HP punya level risiko dan alasan.
- **G2. Gangguan sedikit tapi bermakna.** Aturan pengguna menyaring yang aman, dan aksi berbahaya tidak pernah lolos otomatis.
- **G3. Review nyaman di HP.** Ringkasan, swipe per hunk, dan umpan balik ke agent.
- **G4. Bisa kembali.** Checkpoint otomatis, rollback satu ketukan, rekap sesi.
- **G5. Dasar yang setara kompetitor.** Timeline real-time, keputusan dari HP, push, dan E2E.
- **G6. Instalasi 2 menit** tanpa mengubah cara memanggil agent.
- **G7. Tidak pernah macet**, apa pun kondisi daemon, relay, atau HP.

### Non-tujuan (versi ini)
- Agent bawaan Antigravity (Gemini): belum diketahui punya hooks.
- APK native atau rilis di app store: bisa dibungkus Capacitor nanti.
- Cloud handoff dan VM cloud: agent tetap di laptop pengguna **[Asumsi]**.
- Memulai sesi atau mengirim prompt bebas dari HP. Ini sengaja berbeda dari remote control. Yang tersedia adalah umpan balik atas sebuah keputusan **[Asumsi]**.
- Mengedit kode secara bebas dari HP **[Asumsi]**.
- Fitur tim dan billing **[Asumsi]**.

## 5. Pengguna

| Persona | Kebutuhan utama |
|---|---|
| **Developer solo** yang memakai Claude Code atau Codex | Meninggalkan laptop tanpa kehilangan kendali, dan tanpa dibanjiri notifikasi. |
| **Developer di Indonesia** | Penjelasan berbahasa Indonesia, tahan terhadap sinyal yang tidak stabil. |
| **Developer multi-editor** | Pengalaman yang sama di VS Code, Antigravity, Cursor, Windsurf. |
| **Pengguna kurang teknis** | Penjelasan risiko yang mudah dipahami, panduan install per perangkat. |

## 6. Alur utama

| # | Pengguna | Yang terjadi di sistem |
|---|---|---|
| 1 | Bekerja di editor, agent jalan seperti biasa | Hooks sudah terpasang. Daemon berjalan di background. |
| 2 | Memberi tugas, lalu menunggu | Tiap aksi memicu hook: hook → daemon → relay → HP. Timeline diperbarui real-time. |
| 3 | Tidak perlu melakukan apa-apa untuk aksi yang aman | Daemon menilai risiko dan mencocokkan aturan. Aksi yang cocok dengan aturan izinkan berjalan dan tercatat di timeline. |
| 4 | Menerima notifikasi untuk aksi yang perlu keputusan | Hook menahan aksi. HP menerima level risiko, alasan, ringkasan, dan diff. |
| 5 | Swipe per hunk atau beri komentar | Hunk yang disetujui diterapkan lewat `updatedInput`. Hunk yang ditolak dan komentarnya dikirim ke agent, lalu agent memperbaiki. |
| 6 | Melihat rekap saat agent selesai | Daftar perubahan, durasi, dan yang ditolak, dikelompokkan per maksud. Perbaikan bisa dikirim sebagai umpan balik. |
| 7 | Rollback bila perlu | Daemon memulihkan checkpoint sebelum aksi yang dipilih. |

### Dua tingkat review

Hook hanya melihat **satu aksi dalam satu waktu**. Edit berikutnya belum diketahui sampai edit saat ini diputuskan. Karena itu ringkasan multi-file dan pengelompokan per maksud **tidak bisa dilakukan sebelum aksi** dan dipisah menjadi dua tingkat:

| Tingkat | Kapan | Isi | Tindakan |
|---|---|---|---|
| **Per aksi** | Sebelum aksi (`PreToolUse`, `PermissionRequest`) | Risiko, ringkasan satu aksi, swipe per hunk | Setujui, tolak, terima sebagian, komentar |
| **Per giliran** | Setelah agent selesai (`Stop`) | Ringkasan semua file, kelompok per maksud, rekap | Kirim umpan balik supaya agent lanjut memperbaiki, atau rollback |

## 7. Arsitektur

```
 Laptop                                     Cloud              HP
┌───────────────────────────────┐
│ Claude Code / Codex           │
│   │ stdin JSON      ▲ keputusan
│   ▼                 │         │
│ Hook (proses singkat)         │
│   │ localhost       ▲         │
│   ▼                 │         │      ┌───────────┐     ┌──────────┐
│ Daemon AgentMon ──────────────┼─WSS─►│  Relay    │◄WSS►│   PWA    │
│   ├ penilai risiko            │      │  (Hono)   │     │ (React)  │
│   ├ policy engine             │      ├───────────┤     └──────────┘
│   ├ approval engine           │      │ PostgreSQL│          ▲
│   ├ kalkulator diff, ringkasan│      └─────┬─────┘          │
│   └ checkpoint git            │            └── Web Push ────┘
└───────────────────────────────┘
```

**Semua kecerdasan berada di laptop.** Penilaian risiko, aturan, ringkasan, dan checkpoint berjalan di daemon. Relay hanya meneruskan data, sehingga pembeda utama tetap sejalan dengan E2E.

### Komponen

| Komponen | Paket | Tanggung jawab |
|---|---|---|
| **Hook** | `bridge` | Proses singkat. Membaca JSON dari stdin, bicara ke daemon, mengembalikan keputusan. Tidak mengakses internet. |
| **Daemon** | `bridge` | Risiko, aturan, approval, diff, ringkasan, checkpoint, koneksi ke relay. |
| **CLI** | `bridge` | `setup`, `uninstall`, `pause`, `resume`, `status`, pairing. |
| **Relay** | `server` | Meneruskan pesan, menyimpan riwayat terenkripsi, mengelola perangkat, mengirim push. |
| **PWA** | `web` | Timeline, review, keputusan, rekap, rollback, pengaturan. |
| **Kontrak** | `shared` | Skema Zod, satu sumber kebenaran bentuk pesan. |
| **Extension** | `extension` (tahap 8) | Jalur instalasi dan pairing tanpa terminal. |

## 8. Prinsip anti-macet (G7)

| Kondisi | Perilaku wajib |
|---|---|
| Daemon mati atau tidak merespons | Hook keluar tanpa keputusan, sehingga agent berperilaku normal. |
| Tidak ada perangkat yang bisa dihubungi **[Asumsi]** | Daemon langsung kembali ke alur izin normal, tanpa menunggu batas waktu. |
| HP tidak menjawab sampai batas waktu | Kembali ke alur izin normal, prompt muncul di terminal. |
| Relay putus | Daemon reconnect dan menyimpan event ke antrean. Keputusan tertahan mengikuti aturan batas waktu. |
| Hook, penilai risiko, atau policy error | Tidak ada auto-approve. Kembali ke alur izin normal, dan error dicatat. |
| Checkpoint gagal | Aksi tetap diputuskan seperti biasa, dan peringatan tampil di timeline. |

Aturan turunan:

- **Gagal berarti kembali ke perilaku normal, bukan auto-approve.** Persetujuan hanya boleh berasal dari keputusan eksplisit pengguna, atau dari aturan yang pengguna aktifkan sendiri.
- **"Kembali ke alur normal" dicapai dengan tidak mengembalikan keputusan.** Cara ini berlaku di semua hook dan agent. Jangan mengembalikan `ask` secara umum: `PermissionRequest` tidak mendukungnya, dan di Codex `PreToolUse` dengan `ask` **malah meneruskan aksi** (lihat [bagian 11](#11-integrasi-agent)).
- **Batas waktu internal lebih pendek dari timeout konfigurasi.** Claude Code melanjutkan alur izin normal bila hook timeout, tetapi perilaku Codex perlu diuji. Batas internal membuat hasilnya pasti di kedua agent.
- **Mode "di depan laptop" [Asumsi].** Selama hook menahan aksi, prompt terminal belum muncul. Perlu `agentmon pause` dan `agentmon resume`, ditambah status yang menjelaskan bahwa AgentMon sedang menunggu HP.

## 9. Tiga pilar pembeda

### Pilar 1: Approval berbasis risiko dan kebijakan

**Penilai risiko** berbasis aturan, tanpa AI, dan konservatif. Daftar default **[Asumsi]**:

| Level | Contoh |
|---|---|
| **Tinggi** | Hapus massal, menyentuh file rahasia (`.env`, kunci), mengubah file di luar folder proyek, push ke git, unduhan yang dijalankan langsung (`curl ... \| sh`) |
| **Sedang** | Instal dependency, akses jaringan, perintah yang tidak dikenali, perintah yang tidak bisa diurai |
| **Rendah** | Edit file biasa di dalam proyek, perintah baca saja yang dikenali |

**Policy engine.** Aturan ditulis pengguna, misalnya "test dan lint selalu boleh" dan "apa pun yang menyentuh `.env` selalu tanya". Aturan keselamatan:

1. **Batas keras.** Aksi berisiko tinggi tidak bisa di-auto-approve oleh aturan apa pun.
2. **Default ketat.** Tanpa aturan dari pengguna, tidak ada aksi pengubah yang berjalan otomatis. Risiko rendah saja tidak cukup untuk auto-approve.
3. **Ragu berarti tanya.** Perintah berantai, substitusi, atau redirect (`npm test && curl ...`) tidak cocok dengan aturan izinkan, kecuali setiap bagiannya diizinkan.
4. **Celah skrip.** `npm test` menjalankan kode dari repo, dan agent bisa mengubah skripnya lebih dulu. Jika `package.json` atau konfigurasi sejenis berubah di sesi yang sama, aturan izinkan untuk perintah tersebut ditangguhkan **[Asumsi]**.
5. **Repo tidak dipercaya.** Aturan izinkan hanya dibaca dari konfigurasi pengguna. Aturan di dalam repo hanya boleh memperketat, supaya repo jahat tidak bisa mengizinkan aksinya sendiri **[Asumsi]**.
6. **Tetap menghormati aturan agent.** Aturan deny dan ask milik agent tetap berlaku.
7. **Bisa diaudit.** Setiap auto-approve tercatat di timeline beserta aturan penyebabnya.
8. **Dievaluasi di laptop.** Relay tidak bisa memengaruhi hasilnya. Mengubah aturan dari HP memerlukan keputusan yang ditandatangani.

### Pilar 2: Review diff yang ramah HP

- **Swipe per hunk:** geser untuk setuju, geser untuk tolak, ketuk untuk komentar. Tombol tetap tersedia untuk aksesibilitas.
- **Hunk atau aksi berisiko tinggi** memerlukan konfirmasi eksplisit, tidak cukup dengan satu swipe **[Asumsi]**.
- **Penolakan menjadi umpan balik:** agent memperbaiki, bukan sekadar berhenti.
- **Ringkasan bertahap:**
  - *Deterministik (dasar):* jumlah file, baris bertambah/berkurang, nama fungsi jika terdeteksi, dalam Bahasa Indonesia.
  - *AI (opsional, opt-in) **[Asumsi]**:* dijalankan di laptop memakai agent milik pengguna sehingga E2E tetap utuh. Contoh: "menambah validasi email di form login, mengubah 3 file".
- **Ringkasan tidak dipercaya untuk keamanan.** Isi diff bisa memuat prompt injection, jadi ringkasan AI diberi label jelas dan tidak pernah memengaruhi level risiko. Yang menjadi acuan adalah diff.
- **Pengelompokan per maksud** tersedia di review per giliran.

### Pilar 3: Checkpoint dan rollback

- Snapshot sebelum tiap aksi pengubah yang disetujui.
- Rollback satu ketukan dari HP, dengan konfirmasi.
- Rekap sesi: apa yang diubah, berapa lama, apa yang ditolak.
- **Keterbatasan yang harus ditampilkan ke pengguna:** rollback hanya memulihkan file yang dilacak checkpoint. File yang diabaikan `.gitignore` (misalnya `.env`) tidak ikut dipulihkan, dan efek luar seperti `git push`, panggilan jaringan, atau perubahan database tidak bisa dibatalkan.

## 10. Persyaratan fungsional

Prioritas: **P0** wajib untuk beta publik, **P1** penting setelahnya, **P2** backlog.

### 10.1 Penangkapan event

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-1 | Menangkap sesi mulai, permintaan tool, hasil tool, notifikasi, dan selesai dari Claude Code. | P0 |
| FR-2 | Menangkap aksi dari agent yang berjalan di editor apa pun. | P0 |
| FR-3 | Setiap event divalidasi skema `shared`. Event tak dikenal dicatat, tidak membuat proses crash. | P0 |
| FR-4 | Event punya ID unik dan urutan per sesi. | P0 |
| FR-5 | Menangkap event yang sama dari Codex CLI v0.124+. | P1 |

### 10.2 Timeline

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-10 | Daftar sesi per laptop beserta status. | P0 |
| FR-11 | Timeline sesi diperbarui real-time. | P0 |
| FR-12 | Event yang terlewat dimuat otomatis setelah koneksi pulih. | P0 |
| FR-13 | Auto-approve tampil berbeda di timeline, lengkap dengan aturan penyebabnya. | P0 |
| FR-14 | Riwayat yang tersimpan bisa dibaca saat offline. | P1 |

### 10.3 Keputusan

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-20 | Hook menahan aksi pengubah file melalui `PreToolUse`. | P0 |
| FR-21 | Permintaan izin lain diteruskan melalui `PermissionRequest`. | P0 |
| FR-22 | Daemon menghitung diff, termasuk file baru. | P0 |
| FR-24 | Approve dari HP melanjutkan eksekusi. | P0 |
| FR-25 | Deny + komentar sampai ke agent sebagai alasan. | P0 |
| FR-27 | Beberapa permintaan bersamaan ditampilkan sebagai antrean, yang berisiko tinggi di atas. | P0 |
| FR-28 | Keputusan idempoten, keputusan pertama yang berlaku. | P0 |
| FR-29 | HP menampilkan sisa waktu, permintaan kedaluwarsa tidak bisa diputuskan. | P0 |

### 10.4 Penilaian risiko (Pilar 1)

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-70 | Setiap permintaan diberi level rendah, sedang, atau tinggi beserta alasan singkat. | P0 |
| FR-71 | Pola berbahaya disorot: hapus massal, file rahasia, jaringan, instal dependency, push git, file di luar proyek. | P0 |
| FR-72 | Input yang tidak bisa dinilai tidak pernah mendapat level rendah. | P0 |
| FR-73 | Penilaian hanya memakai input tool yang sebenarnya, bukan penjelasan agent. | P0 |
| FR-74 | Penjelasan risiko berbahasa Indonesia secara default. | P0 |

### 10.5 Policy engine (Pilar 1)

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-80 | Aturan izinkan, tanya, dan tolak dari file konfigurasi pengguna. | P0 |
| FR-81 | Aksi berisiko tinggi tidak bisa di-auto-approve. | P0 |
| FR-82 | Konfigurasi rusak atau tidak valid berarti tidak ada auto-approve. | P0 |
| FR-83 | Hanya aksi yang tersisa setelah aturan dievaluasi yang naik ke HP dan memicu notifikasi. | P0 |
| FR-84 | Perintah `agentmon policy test "<perintah>"` menunjukkan hasil evaluasi tanpa menjalankannya. | P0 |
| FR-85 | Melihat aturan aktif di HP. | P0 |
| FR-86 | Setelah menyetujui, HP bisa menyarankan aturan baru. Aturan aktif setelah konfirmasi yang ditandatangani. | P1 |

### 10.6 Review (Pilar 2)

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-23 | Diff terbaca baik di layar sempit, highlight sintaks dimuat lazy. | P0 |
| FR-26 | Terima sebagian: hunk yang disetujui diterapkan lewat `updatedInput`. | P0 |
| FR-90 | Mode swipe per hunk, dengan alternatif tombol. | P0 |
| FR-91 | Komentar per hunk dan penolakan sampai ke agent. | P0 |
| FR-92 | Ringkasan deterministik di atas diff. | P0 |
| FR-93 | Review per giliran saat `Stop`, dengan umpan balik yang membuat agent lanjut memperbaiki. | P0 |
| FR-94 | Ringkasan dan pengelompokan per maksud berbasis AI, opt-in, dijalankan di laptop. | P1 |

### 10.7 Notifikasi

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-30 | Web Push (VAPID) saat ada keputusan yang dibutuhkan. | P0 |
| FR-31 | Web Push saat agent selesai. | P0 |
| FR-32 | Mengetuk notifikasi membuka layar yang relevan. | P0 |
| FR-33 | Pengguna bisa mengatur jenis notifikasi. | P1 |
| FR-34 | Isi push tidak memuat kode atau data sensitif. | P0 |

### 10.8 Checkpoint, rollback, rekap (Pilar 3)

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-40 | Snapshot git otomatis sebelum aksi pengubah. | P0 |
| FR-41 | Rollback satu ketukan dari HP dengan konfirmasi. | P0 |
| FR-42 | Checkpoint tidak mengubah index, branch, stash, atau riwayat commit pengguna **[Asumsi]**. | P0 |
| FR-43 | Direktori non-git: fitur nonaktif dengan pesan jelas. | P0 |
| FR-44 | Rekap sesi: apa yang diubah, berapa lama, apa yang ditolak, apa yang di-auto-approve. | P0 |

### 10.9 Instalasi, pairing, pencabutan

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-50 | `npx agentmon setup` mendeteksi Claude Code dan Codex. | P0 |
| FR-51 | Setup menggabungkan hooks ke konfigurasi yang ada dan membuat backup. | P0 |
| FR-52 | Daemon berjalan saat laptop menyala di Windows, macOS, dan Linux. | P0 |
| FR-53 | Setup menampilkan QR untuk pairing. | P0 |
| FR-54 | PWA menampilkan panduan install sesuai perangkat. | P0 |
| FR-55 | Di iOS, app memandu membuka dari ikon home screen sebelum meminta izin notifikasi. | P0 |
| FR-56 | Perangkat bisa dicabut dari Pengaturan → Perangkat → Cabut. | P0 |
| FR-57 | `npx agentmon uninstall` mengembalikan konfigurasi hooks dan menghentikan daemon. | P0 |
| FR-58 | Setup bisa dijalankan berulang tanpa hook ganda. | P0 |
| FR-59 | Panduan Codex: `/hooks` untuk trust hook. | P1 |
| FR-60 | Extension untuk VS Code, Antigravity, Cursor, Windsurf. | P1 |

### 10.10 Pembeda tambahan (backlog)

| ID | Persyaratan | Prioritas |
|---|---|---|
| FR-100 | Approval cepat lewat Telegram, Discord, atau WhatsApp. Diff panjang tetap di PWA. | P2 |
| FR-101 | Hemat data: diff dikompres, antrean keputusan yang tahan sinyal putus. | P2 |
| FR-102 | Self-host relay dengan satu perintah. | P2 |
| FR-103 | Second opinion: diff dikirim ke agent kedua sebelum diputuskan. | P2 |

## 11. Integrasi agent

Sudah dicek dengan dokumentasi resmi pada 31 Oktober 2026. Perilaku nyata tetap dibuktikan lewat spike ([#003](docs/issues/003-spike-hook-logger-claude-code.md), [#048](docs/issues/048-spike-hooks-codex.md)).

| Kemampuan | Claude Code | Codex CLI |
|---|---|---|
| Menahan sebelum aksi | `PreToolUse` | `PreToolUse` |
| Izinkan | `permissionDecision: "allow"` | `permissionDecision: "allow"` |
| Tolak + alasan | `deny` + `permissionDecisionReason`, terlihat oleh Claude | `deny` didukung, tetapi **tidak terdokumentasi** apakah model melihat alasannya |
| Kembali ke alur normal | Tanpa keputusan | Tanpa keputusan (perlu dibuktikan untuk `PreToolUse`) |
| `ask` di `PreToolUse` | Didukung | **Tidak didukung. Hook dianggap gagal dan aksi dilanjutkan.** |
| Mengubah input | `updatedInput`, mengganti seluruh input | `updatedInput` bersama `allow`. Bash dan `apply_patch` memakai string `command`. |
| `PermissionRequest` | `behavior`: `allow`/`deny`, `updatedInput`, `message`, `interrupt` | `behavior`: `allow`/`deny`, `message`. `updatedInput` **tidak didukung**. |
| Catatan tambahan ke agent | `additionalContext` | Perlu diuji |
| Lanjut setelah selesai | `Stop` + `decision: "block"` + `reason` | Sama. `reason` menjadi prompt lanjutan. |
| Timeout hook | Default 600 detik. `PreToolUse` yang timeout melanjutkan alur normal. | Perlu diuji |
| Konfigurasi | `settings.json` | `~/.codex/hooks.json`, trust lewat `/hooks` |

Dampak ke desain:

- **Dua hal di dokumen sumber terkoreksi:** `PermissionRequest` tidak mendukung `ask`, dan `ask` di Codex tidak aman (lihat bagian 8).
- **Allow melewati prompt.** Mengembalikan `allow` berarti melewati prompt terminal, tetapi aturan deny dan ask agent tetap berlaku.
- **`permission_mode` tersedia di input hook.** Pada mode `bypassPermissions`, AgentMon hanya memantau dan tidak menahan aksi, kecuali diatur lain oleh pengguna.
- **Trust Codex terikat ke hash hook.** Isi hook berubah berarti perlu trust ulang, jadi command hook harus stabil antarversi.
- **Terima sebagian di Codex** harus menyusun ulang `apply_patch`, sehingga dibuktikan terpisah.
- **Fallback** bila terima sebagian tidak bisa: tolak utuh + komentar per hunk.

Agent yang berjalan di terminal Antigravity atau editor lain tetap terpantau karena hooks melekat pada agent.

## 12. Model data

### Pesan (`shared`)

```ts
type Envelope = {
  v: 1;                   // versi kontrak
  id: string;             // UUID, untuk deduplikasi
  machineId: string;
  sessionId: string;
  seq: number;            // urutan per sesi
  ts: string;             // ISO 8601
  agent: "claude-code" | "codex";
  type: EventType;
  payload: unknown;       // divalidasi per type; terenkripsi sejak tahap 4
};

type Risk = {
  level: "low" | "medium" | "high";
  reasons: { code: string; message: string }[];
};

type PolicyResult = {
  action: "allow" | "ask" | "deny";
  ruleId: string | null;  // null = default
};
```

**Jenis event:** `session.started`, `tool.requested`, `tool.completed`, `approval.requested`, `approval.resolved`, `approval.auto_resolved`, `agent.notification`, `agent.stopped`, `turn.review_requested`, `checkpoint.created`, `checkpoint.restored`, `session.recap`.

### Status approval

```
pending ─┬─► approved
         ├─► partially_approved
         ├─► denied
         ├─► timed_out   (kembali ke alur normal)
         └─► cancelled   (daemon restart atau sesi berakhir)

auto_approved / auto_denied   (langsung dari policy, tanpa pending)
```

### Tabel PostgreSQL

| Tabel | Isi |
|---|---|
| `machines` | Laptop: ID, nama, hash token, terakhir terlihat. |
| `devices` | HP: ID, nama, hash token, kunci publik (tahap 4), waktu dicabut. |
| `pairings` | Relasi laptop dan HP. |
| `pairing_codes` | Kode sekali pakai yang kedaluwarsa. |
| `sessions` | Sesi agent: agent, status, waktu. |
| `events` | Envelope. Sejak tahap 4, `payload` hanya ciphertext. |
| `push_subscriptions` | Endpoint dan kunci Web Push. |

Aturan policy dan checkpoint **hanya disimpan di laptop**. **[Asumsi]** Tidak ada akun, identitas berasal dari pairing. Riwayat dihapus otomatis setelah 30 hari.

## 13. Keamanan

Approve dari HP pada dasarnya mengizinkan eksekusi kode di laptop.

| Ancaman | Mitigasi |
|---|---|
| Penilai risiko memberi rasa aman palsu | Aturan konservatif, ragu berarti tanya. UI menyebut level sebagai bantuan, bukan jaminan. |
| Auto-approve disalahgunakan | Default ketat, batas keras untuk risiko tinggi, audit di timeline. |
| Perintah aman menyembunyikan aksi berbahaya | Evaluasi per bagian perintah, dan aturan tertangguhkan saat skrip berubah. |
| Repo jahat melonggarkan aturan | Aturan repo hanya boleh memperketat. |
| Prompt injection lewat kode atau ringkasan | Risiko dihitung dari input tool, ringkasan AI tidak memengaruhi level. |
| Relay membaca kode | E2E dengan libsodium (tahap 4). |
| Relay memalsukan keputusan atau rollback | Keputusan, rollback, dan perubahan aturan ditandatangani kunci perangkat dan diverifikasi daemon **[Asumsi]**. |
| Keputusan lama diputar ulang | Terikat pada ID permintaan, hash isi aksi, dan masa berlaku. |
| QR atau tautan pairing bocor | Kode sekali pakai dan singkat. Rahasia E2E di fragmen URL. |
| Token di database bocor | Hanya hash token yang disimpan. |
| Situs web mengakses daemon di `localhost` | Bind ke `127.0.0.1`, token lokal, validasi `Host` dan `Origin`. |
| HP hilang | Cabut dari perangkat lain atau CLI. |

**Gerbang rilis:** rollback dari HP (tahap 2.5) dan keputusan dari HP (tahap 2) belum ditandatangani sampai tahap 4 selesai. **Rilis publik wajib menunggu semua tiga pilar, tahap 4, dan tahap 6 selesai.** Sebelum itu, hanya relay milik sendiri dengan kode milik sendiri.

## 14. Persyaratan non-fungsional

Angka berikut adalah target awal **[Asumsi]**.

| Aspek | Target |
|---|---|
| Instalasi | ≤ 2 menit, termasuk pairing. |
| Overhead hook non-penahan | p95 < 150 ms. Hook tidak dipanggil lewat `npx`. |
| Penilaian risiko dan policy | p95 < 20 ms di daemon. |
| Latensi event ke HP | p95 < 2 detik saat relay aktif. |
| Reconnect | < 5 detik setelah jaringan pulih, tanpa kehilangan event. |
| Bundle PWA | JS awal < 200 KB gzip. Diff viewer dan highlight dimuat lazy. |
| Bahasa | Bahasa Indonesia default. Semua teks lewat satu lapisan i18n, dengan Inggris menyusul. |
| Biaya MVP | Rp0 memakai free tier. Pemakaian serius perlu paket Render kecil. |
| Platform | Windows, macOS, Linux. Chrome Android, Safari iOS 16.4+ (PWA dari home screen). |
| Tampilan | Dark mode, nyaman dipakai satu tangan. |

## 15. Tech stack

| Bagian | Pilihan | Alasan |
|---|---|---|
| Monorepo | pnpm workspaces | Sederhana dan cepat. |
| Kontrak | `shared` + Zod | Validasi di semua sisi. |
| Hook, daemon, CLI | Node.js LTS + TypeScript, npm | Lintas OS, bisa `npx`. |
| Penilai risiko dan policy | TypeScript murni di `bridge` | Tanpa AI, cepat, mudah dites. |
| Checkpoint | git CLI | Snapshot dan rollback. |
| Relay | Node.js + Hono + WebSocket | Ringan, bisa dipindah ke Cloudflare Workers. |
| Database | PostgreSQL (Neon) + Drizzle | Riwayat, perangkat, langganan push. |
| Push | Web Push (VAPID) | Gratis, tanpa Firebase. |
| App | Vite + React + TypeScript (PWA) | Sepenuhnya di klien. |
| UI | Tailwind CSS + shadcn/ui | Cepat dibangun, mudah dark mode. |
| Data real-time | TanStack Query + WebSocket | Cache dan sinkronisasi rapi. |
| PWA tooling | vite-plugin-pwa | Service worker, manifest, offline. |
| Diff | diff2html atau react-diff-view | Dipilih di [#024](docs/issues/024-diff-viewer-mobile.md). Harus mendukung hunk sebagai komponen untuk swipe. |
| E2E | libsodium | Relay hanya meneruskan ciphertext. |
| Extension | VS Code Extension API | Satu extension untuk semua editor kompatibel. |
| Hosting | Cloudflare Pages atau Vercel (app), Render (server) | Free tier Render tidur saat idle. |

## 16. Rencana tahap

Mengikuti bagian 6 `diferensiasi-kompetitor.md`. Tahap 4 (E2E), 7 (Codex), dan 8 (Extension) berasal dari dokumen sumber. Tabel ini adalah rencana tahap resmi proyek.

| Tahap | Tema | Hasil yang bisa didemokan | Issue |
|---|---|---|---|
| **0** | Fondasi | Monorepo, kontrak, contoh data hook asli. | #001–003 |
| **1** | Loop lokal | Approve/deny dari web lokal menahan Claude Code. | #004–010 |
| **2** | Relay & PWA | Timeline dan approve/deny dari HP lewat internet. | #011–021 |
| **2.5** | Checkpoint (Pilar 3) | Rollback satu ketukan dari HP. | #022–023 |
| **3** | Diff & push | Diff dan ringkasan nyaman dibaca, notifikasi masuk. | #024–029 |
| **3.5** | Risiko (Pilar 1) | Tiap permintaan punya level dan alasan. | #030–031 |
| **4** | E2E | Relay hanya melihat ciphertext, keputusan ditandatangani. | #032–035 |
| **4.5** | Policy (Pilar 1) | Yang aman jalan otomatis, notifikasi berkurang. | #036–038 |
| **5** | Review per hunk (Pilar 2) | Swipe, umpan balik ke agent, rekap per giliran. | #039–042 |
| **6** | Instalasi & rilis | `npx agentmon setup` ≤ 2 menit, beta publik. | #043–047 |
| **7** | Codex | Kemampuan setara untuk Codex CLI. | #048–050 |
| **8** | Extension | Pairing dari editor, tanpa terminal. | #051–052 |
| **Backlog** | Pembeda tambahan | Chat, hemat data, self-host, second opinion. | #053–056 |

Codex ditempatkan setelah beta sesuai nomor tahap di dokumen sumber. Claude Code menjadi jalur utama untuk membuktikan tiga pilar lebih dulu.

## 17. Metrik keberhasilan dan risiko

### Metrik

Target awal **[Asumsi]**.

| Metrik | Target | Mengukur |
|---|---|---|
| Insiden agent macet karena AgentMon | 0 | Keandalan |
| Aksi berbahaya yang lolos otomatis | 0 | Keamanan policy |
| Permintaan yang naik ke HP per sesi | Turun ≥ 50% setelah policy aktif | Pilar 1 |
| Keputusan dengan review, bukan approve instan | Mayoritas untuk risiko tinggi | Approval fatigue |
| Penolakan yang berujung perbaikan oleh agent | > 70% | Pilar 2 |
| Waktu keputusan per permintaan | Median < 30 detik | Pilar 2 |
| Rollback yang berhasil | 100% | Pilar 3 |
| Waktu instalasi median | ≤ 2 menit | Aktivasi |
| Keberhasilan aktivasi push | > 80% perangkat yang sudah pairing | Aktivasi |

Metrik dihitung lokal lewat rekap. Telemetri ke server hanya bila pengguna menyetujui **[Asumsi]**.

### Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Penilai risiko salah, rasa aman palsu | Aksi berbahaya disetujui | Konservatif, test korpus perintah berbahaya, penjelasan bahwa level adalah bantuan. |
| Auto-approve menambah permukaan serangan | Laptop dikompromikan | Default ketat dan batas keras. |
| Terlalu banyak tanya | Pilar 1 gagal | Saran aturan, ukur tingkat permintaan. |
| Kompetitor menyalin fitur | Pembeda terkikis | Fokus pada kualitas UX review dan kontrol keamanan. |
| Swipe tidak sengaja | Perubahan salah disetujui | Konfirmasi untuk risiko tinggi, urungkan sebelum dikirim, tersedia checkpoint. |
| Terima sebagian membuat kode tidak konsisten | Build rusak | Agent diberi tahu hunk yang ditolak, sehingga bisa menyesuaikan. |
| Format hook berubah | Fitur rusak diam-diam | Fixture, validasi Zod, event tak dikenal tetap lolos. |
| Pengguna di laptop menunggu HP | Terasa macet | Mode pause dan pesan status. |
| Push iOS PWA tidak andal | Permintaan terlewat | Onboarding, tes perangkat nyata, fallback batas waktu. |
| Free tier Render tidur | Event tertunda | Paket kecil atau Cloudflare Workers + Durable Objects. |
| `setup` merusak konfigurasi | Kepercayaan hilang | Backup, penggabungan aman, idempoten. |
| Checkpoint mengacaukan repo | Kehilangan kerja | Ref privat, tidak menyentuh index atau stash. |

## 18. Asumsi dan pertanyaan terbuka

### Keputusan (31 Oktober 2026)

1. **Rencana tahap.** `rencana-agent-monitor.md` tidak ada. [Bagian 16](#16-rencana-tahap) menjadi rencana resmi.
2. **Ringkasan AI.** Beta memakai ringkasan deterministik. AI berjalan di laptop sebagai opt-in sesudahnya.
3. **`git push`.** Termasuk risiko tinggi dan tidak bisa di-auto-approve.
4. **Mode longgar.** Pada `bypassPermissions`, AgentMon hanya memantau, kecuali diatur lain oleh pengguna.

### Pertanyaan terbuka

1. **Identitas.** Cukup pairing perangkat tanpa akun? Ini sekarang juga jadi pembeda.
2. **Model produk.** Open source, self-host, atau berbayar? Happy Coder sudah open source dengan lisensi MIT.
3. **Batas lingkup HP.** Apakah prompt bebas dari HP memang di luar versi ini? Kompetitor punya fitur ini.
4. **Level risiko default.** Daftar lainnya di bagian 9 perlu ditinjau setelah ada data alarm palsu dari #030.
5. **Retensi riwayat.** Apakah 30 hari sudah tepat?
6. **Nama final.** Nama `agentmon` di npm perlu dicek.
