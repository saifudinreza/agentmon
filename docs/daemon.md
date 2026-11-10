# Daemon AgentMon

Proses background di laptop yang menjadi pusat kerja AgentMon. Pada tahap ini ia menerima hook dari Claude Code, memeriksa siapa pengirimnya, dan mencatat event ke log. Keputusan approval ditambahkan di issue berikutnya.

## Menjalankan
```bash
pnpm --filter @agentmon/bridge daemon
```
Daemon membuka `http://127.0.0.1:47821`. Variabel yang bisa diatur:

| Variabel | Fungsi | Bawaan |
|---|---|---|
| `AGENTMON_PORT` | Port daemon | `47821` |
| `AGENTMON_HOME` | Folder data | `~/.agentmon` |

Port dibuat tetap karena alamatnya tertulis di pengaturan hook Claude Code. Menjalankan daemon kedua tidak merusak yang pertama: ia mendeteksi daemon yang berjalan, mencetak pesan, lalu keluar dengan kode 0.

## Data di `~/.agentmon`
| Berkas | Isi |
|---|---|
| `token` | Rahasia untuk autentikasi (64 karakter heksadesimal). Dibuat sekali, izin `0600` di macOS dan Linux |
| `daemon.json` | PID, port, dan waktu mulai. Dihapus saat daemon berhenti baik-baik. Yang tertinggal setelah daemon mati mendadak tidak menghalangi start berikutnya |
| `daemon.log` | Log, berputar ke `daemon.log.1` saat melewati 1 MB |

Log hanya berisi nama event, nama alat, dan hasilnya. Isi pesan (kode, perintah) tidak pernah dicatat.

## Keamanan
Daemon hanya mendengarkan di `127.0.0.1`, jadi tidak terjangkau dari jaringan. Karena situs web di browser juga bisa menembak `127.0.0.1`, setiap request melewati tiga pemeriksaan:

1. **Host** harus `127.0.0.1:<port>` atau `localhost:<port>` (menolak DNS rebinding). Jika tidak: 403.
2. **Bukan dari browser:** request dengan `Origin` atau `Sec-Fetch-*` ditolak walau tokennya benar. Jika tidak: 403.
3. **Token** di header `Authorization: Bearer <token>`. Jika tidak: 401. Token di query string tidak diterima.

Daemon tidak mengirim header CORS, jadi browser tidak bisa membaca jawabannya.

## Menghubungkan Claude Code (hook `http`)
Claude Code mengirim input hook sebagai `POST` JSON ke `/hook`. Contoh pengaturan (isi `<token>` dengan isi berkas `token`):

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{
        "type": "http",
        "url": "http://127.0.0.1:47821/hook",
        "headers": { "Authorization": "Bearer <token>" },
        "timeout": 600
      }] }
    ]
  }
}
```
Daftarkan hal yang sama untuk event lain yang dibutuhkan. Jangan memakai `onFailure: "block"`, karena itu membuat agent berhenti saat daemon mati.

Tulis alamatnya sebagai `127.0.0.1`, **bukan** `localhost`. Daemon hanya mendengarkan di IPv4, sedangkan di sebagian komputer `localhost` diarahkan ke `::1` (IPv6) lebih dulu. Koneksinya akan ditolak, dan hook gagal diam-diam (aman, tetapi tidak berfungsi). Daemon menerima `Host: localhost`, tetapi itu tidak menjamin koneksinya sampai.

Token juga bisa dibaca dari variabel lingkungan: `"Authorization": "Bearer $AGENTMON_TOKEN"` bersama `"allowedEnvVars": ["AGENTMON_TOKEN"]`. Variabel itu harus ada di lingkungan proses Claude Code, jadi pemasang otomatis (issue setup) lebih baik menuliskan tokennya langsung di pengaturan tingkat pengguna.

**Konfigurasi ini memuat token.** Siapa pun yang bisa membaca berkas pengaturannya bisa memanggil daemon. Karena itu pemasang (issue setup) harus: mempertahankan izin berkas pengaturan yang sudah ada dan tidak membuatnya lebih longgar (di macOS dan Linux, berkas baru dibuat `0600`), tidak pernah menuliskan isi konfigurasi atau token ke log, dan tidak menaruhnya di dalam repo proyek. Pembuat konfigurasi sendiri tidak memasukkan token ke pesan error.

Jawaban daemon selalu objek JSON. `{}` berarti tanpa keputusan, sehingga alur izin normal berjalan.

Konfigurasi di atas dihasilkan oleh `buildClaudeHookSettings` (`packages/bridge/src/hook-config.ts`), bukan ditulis tangan, supaya persis sama dengan yang nanti dipasang oleh perintah setup. Fungsi itu mendaftarkan enam event (`PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`), memakai `127.0.0.1`, dan tidak pernah memuat `onFailure`. Batas tunggu hook dibedakan: 600 detik hanya untuk `PreToolUse` dan `PermissionRequest` (menunggu keputusan dari HP), 10 detik untuk empat event pengamatan, supaya daemon yang membeku tidak menahan agent lama pada event yang tidak menunggu siapa pun. `UserPromptSubmit` sengaja tidak didaftarkan karena isinya adalah teks perintah pengguna dan tidak dipakai kontrak pesan. `SessionStart` juga tidak didaftarkan: event itu hanya mendukung hook `command`, bukan `http`, sehingga event `session.started` tidak datang dari hook ini.

## Adapter Claude Code (pemetaan ke kontrak)
Input hook mentah dari Claude Code diubah menjadi event baku (paket `shared`) oleh adapter di `packages/bridge/src/adapters/`. Inti daemon (`daemon.ts`, `server.ts`, dan lainnya) tidak mengenal nama event atau logika Claude Code; ada test yang menjaganya. Satu hal yang masih dipakai bersama: `HookInput` menuntut objek JSON dengan `hook_event_name`, dan `tool_name` dipakai untuk baris log. Itu amplop minimum yang diasumsikan umum, dan akan ditinjau lagi setelah riset Codex.

| Input hook | Hasil |
|---|---|
| `PreToolUse` | event `tool.requested` |
| `PostToolUse` | event `tool.completed` (`ok` bernilai `false` bila perintah dihentikan di tengah jalan) |
| `Stop` | event `agent.stopped` |
| `Notification` | event `agent.notification` (belum pernah teramati, bentuknya dari dokumentasi) |
| `SessionStart` | event `session.started` (dipetakan, tetapi tidak datang lewat hook `http`, lihat di bawah) |
| `PermissionRequest` | permintaan izin netral untuk approval engine. Bukan event, karena `approval.requested` butuh nomor persetujuan dan batas waktu |
| `SessionEnd` | penanda sesi berakhir. Kontrak tidak punya event ini, dan `session.recap` dihitung dari catatan sesi |
| `UserPromptSubmit` | diabaikan (isinya teks perintahmu) |
| nama lain | dicatat sebagai tidak dikenal, lalu diabaikan |
| kolom wajib hilang | dicatat sebagai tidak sah, lalu diabaikan |

Setiap event diberi `id` unik, `machineId` (UUID acak di `~/.agentmon/machine-id`), waktu, dan `seq` yang naik per sesi mulai dari 0. Nomor urut hanya terpakai oleh event yang benar-benar dikirim, jadi tidak ada celah. Data yang tidak dikenal atau rusak hanya dicatat (nama event, tanpa isinya) dan agent tidak terganggu.

Event dikirim ke penerima (`EventSink`) di belakang layar, sedangkan jawaban ke Claude Code langsung `{}`. Penerima yang lambat, macet, atau error tidak menahan agent. Sebaliknya penerima tidak mendapat jaminan: penyelesaiannya bisa tidak berurutan, event yang gagal dikirim tidak dicoba lagi, dan `seq` bisa punya celah. Penerima yang butuh kelengkapan (klien relay) harus punya antrean dan percobaan ulang sendiri. Sementara ini penerimanya hanya mencatat jenis event ke log. Relay dan timeline menggantikannya di issue berikutnya.

**Keterbatasan yang perlu diingat:**
- `SessionStart` hanya mendukung hook `command`, jadi daemon tidak menerima awal sesi. Penanda awal sesi harus diturunkan dari event pertama sebuah sesi. Ini perlu diputuskan sebelum daftar sesi dibuat.
- Nomor urut diingat untuk paling banyak 1000 sesi; yang paling lama tidak dipakai disingkirkan (sesi yang berakhir mendadak tidak mengirim `SessionEnd`).
- `seq` hanya hidup selama daemon berjalan. Bila daemon dimulai ulang di tengah sesi, urutan sesi itu mulai lagi dari 0; penerima menyaring duplikat lewat `id`.

## Approval engine (buku antrean izin)
`packages/bridge/src/approvals.ts` mengelola siklus hidup setiap permintaan izin. Mesinnya dibuat satu kali oleh daemon dan diberikan ke penangan hook lewat `context.approvals`. Mesin ini tidak tahu apa pun soal Claude Code atau HTTP; menyambungkannya ke hook dikerjakan issue berikutnya.

```
pending --+--> approved | partially_approved | denied | timed_out | cancelled
```
Hanya `pending` yang boleh pindah, dan status akhir tidak bisa berubah lagi. `auto_approved` dan `auto_denied` tidak lewat `pending` (langsung dari policy), jadi tidak dibuat oleh mesin ini.

| Fungsi | Tugas |
|---|---|
| `request(input)` | Membuka satu kartu. Mengembalikan `approvalId`, `expiresAt`, dan `outcome`: janji jawaban yang **selalu selesai dan tidak pernah gagal** |
| `decide(input)` | Memutuskan kartu. `input` diperiksa lebih dulu karena datang dari HP. Hasilnya `ok`, `invalid`, `unknown`, atau `already_resolved` |
| `cancelSession(id)` | Membatalkan kartu satu sesi (dipanggil saat `SessionEnd`) |
| `close()` | Dipanggil saat daemon berhenti: membatalkan semua kartu dan membatalkan kartu baru yang telat masuk |
| `get`, `listPending` | Membaca keadaan (salinan, aman diubah) |

**Aturan yang dijaga:**
- **Keputusan pertama yang berlaku.** Keputusan kedua, atau yang datang terlambat, ditolak dengan `already_resolved` beserta hasil yang sebenarnya.
- **Kedaluwarsa tidak bisa diputuskan.** Kartu yang waktunya lewat dianggap `timed_out` walau timer-nya belum sempat berjalan, dan keputusannya ditolak.
- **Kegagalan bukan persetujuan.** Waktu habis dan pembatalan adalah "tanpa keputusan".
- **Batas waktu bawaan 540 detik**, sengaja lebih pendek dari batas hook di Claude Code (600 detik), supaya daemon yang memutuskan lebih dulu dan menjawab dengan benar. Ada test yang menjaga hubungan ini.
- **Daemon berhenti dengan urutan tertentu:** batalkan semua kartu, tunggu hook yang menunggu selesai dijawab (`drain`, maksimum 3 detik), baru tutup koneksi. Tanpa langkah tunggu, koneksi terputus sebelum hook sempat menerima jawabannya.
- Kartu yang sudah selesai diingat paling banyak 1000, supaya keputusan yang terlambat bisa dijawab "sudah selesai" dan bukan "tidak dikenal".

Kabar perubahan (`onChange`: dibuka atau diselesaikan) disiapkan untuk event `approval.requested` dan `approval.resolved` di issue berikutnya.

## Menahan aksi agent sampai ada keputusan
Penangan hook Claude Code (`adapters/claude-code-handler.ts`) menahan aksi lewat approval engine, lalu menerjemahkan hasilnya.

**Aksi mana yang ditahan** (kebijakannya `holdCandidate` di `adapters/claude-code.ts`):

| Hook | Ditahan | Alasan |
|---|---|---|
| `PreToolUse` | Alat pengubah berkas: `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | `allow` di sini melewati prompt Claude, jadi tidak ada prompt izin kedua (FR-20) |
| `PermissionRequest` | Semua alat, termasuk `Bash` dan `PowerShell` | Hook ini hanya muncul bila Claude memang akan bertanya (FR-21) |
| `PreToolUse` untuk alat baca-saja (`Read`, `Glob`, `Grep`, ...) | Tidak | Tidak mengubah apa pun |
| Mode `bypassPermissions` | Tidak, hanya dipantau | Pengguna memilih agent berjalan tanpa izin (keputusan PRD §18) |

**Terjemahan hasil** (`toClaudeDecision`):

| Hasil | Jawaban ke Claude Code |
|---|---|
| Disetujui | `allow` |
| Ditolak | `deny` dengan komentar pengguna apa adanya sebagai alasan (alasan bawaan bila kosong). Claude membaca dan menanggapinya |
| Waktu habis, dibatalkan, dijeda, error, terima sebagian | **Tanpa keputusan**: Claude Code bertanya di terminal seperti biasa. Tidak pernah `allow` dan tidak pernah `ask` |

Terima sebagian (`partial`) belum bisa diterapkan karena butuh penyaringan hunk; sementara ini kembali ke alur normal.

**Tidak menunggu dua kali.** Bila sebuah aksi sudah menunggu di `PreToolUse` lalu waktunya habis, Claude Code lanjut dengan `PermissionRequest` untuk aksi yang sama. Aksi yang baru dilepas itu diingat selama 60 detik sehingga `PermissionRequest` susulannya langsung diteruskan, dan prompt terminal muncul seketika. Tanpa ini pengguna menunggu dua kali.

**Hook yang menunggu tidak menahan hook lain.** Daemon tetap melayani hook dan perintah lain selama satu hook menunggu.

**Event** yang dikirim ke penerima: `tool.requested`, lalu `approval.requested` (berisi `approvalId` dan `expiresAt`), dan `approval.resolved` (status akhir, komentar).

### Saklar penahanan dan perintah kontrol
Penahanan **mati secara bawaan**, karena belum ada HP yang bisa menjawab (relay dibuat di tahap 2). Bila menyala tanpa ada yang menjawab, setiap aksi tertahan 9 menit sebelum prompt terminal muncul. Nyalakan dengan `AGENTMON_HOLD=1` saat menjalankan daemon.

```bash
AGENTMON_HOLD=1 pnpm --filter @agentmon/bridge daemon
pnpm --filter @agentmon/bridge cli status        # apa yang sedang terjadi?
pnpm --filter @agentmon/bridge cli approve       # setujui (id boleh dilewati bila hanya ada satu)
pnpm --filter @agentmon/bridge cli deny jangan ubah berkas ini   # tolak dengan komentar
pnpm --filter @agentmon/bridge cli pause         # jeda: tidak menahan, yang menunggu dilepas
pnpm --filter @agentmon/bridge cli resume
```
`approve` dan `deny` menerima awalan id (8 karakter cukup). `status` menjelaskan keadaan dengan kalimat, misalnya "AgentMon sedang menunggu keputusan dari HP untuk 1 permintaan". Isi input alat tidak pernah ditampilkan, hanya nama alat.

`pause` untuk saat kamu duduk di depan laptop dan ingin menjawab di terminal: aksi yang sedang menunggu langsung dilepas, sehingga prompt terminal muncul saat itu juga, dan aksi berikutnya tidak ditahan sampai `resume`.

| Endpoint | Fungsi |
|---|---|
| `GET /status` | Keadaan: `paused`, `holdEnabled`, daftar izin yang menunggu, dan `message` |
| `POST /pause`, `POST /resume` | Menjeda dan melanjutkan |
| `POST /decision` | Memutuskan satu izin. Isinya `ApprovalDecision` dari paket `shared`. Hasil: `200`, `400` (bentuk salah), `404` (tidak dikenal), `409` (sudah selesai, menyebut hasil sebenarnya) |

Semua endpoint memakai tiga pemeriksaan keamanan yang sama dengan `/hook`.

## Endpoint
| Endpoint | Fungsi |
|---|---|
| `GET /health` | `status`, `version`, `pid`, `startedAt`, `uptimeMs` |
| `POST /hook` | Menerima input hook (`Content-Type: application/json`, maksimum 10 MiB). Jawaban `200` |

Kode lain: `400` (JSON atau bentuk tidak valid), `404`, `405`, `413` (terlalu besar), `415` (bukan JSON).

## Perilaku saat gagal
Penangan hook yang error tetap dijawab `200` dengan `{}` dan dicatat, bukan `500` dan bukan persetujuan. Daemon mati atau menolak request tidak menghentikan agent: Claude Code menganggapnya kesalahan tanpa pemblokiran dan meneruskan alur izin normal. Buktinya ada di [hooks-claude-code.md](hooks-claude-code.md), bagian 8b: jawaban teks biasa, JSON terpotong, nilai keputusan yang tidak dikenal, status 500, token salah, port salah, daemon mati, dan daemon yang terlalu lambat semuanya diperlakukan seperti tanpa keputusan.

**Daemon tidak boleh memblokir event loop-nya.** Hook menunggu jawaban sampai batas waktunya (bawaan 600 detik), jadi daemon yang membeku sama dengan agent yang berhenti. Pekerjaan berat di dalam penangan hook, misalnya menghitung diff besar atau menjalankan git, harus asinkron.
