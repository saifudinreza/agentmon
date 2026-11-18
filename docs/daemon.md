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

Token juga bisa dibaca dari variabel lingkungan: `"Authorization": "Bearer $AGENTMON_TOKEN"` bersama `"allowedEnvVars": ["AGENTMON_TOKEN"]`. Variabel itu harus ada di lingkungan proses Claude Code, jadi pemasang otomatis (`setup`, lihat `docs/setup.md`) menuliskan tokennya langsung di pengaturan tingkat pengguna.

**Konfigurasi ini memuat token.** Siapa pun yang bisa membaca berkas pengaturannya bisa memanggil daemon. Karena itu pemasang (issue setup) harus: mempertahankan izin berkas pengaturan yang sudah ada dan tidak membuatnya lebih longgar (di macOS dan Linux, berkas baru dibuat `0600`), tidak pernah menuliskan isi konfigurasi atau token ke log, dan tidak menaruhnya di dalam repo proyek. Pembuat konfigurasi sendiri tidak memasukkan token ke pesan error.

Jawaban daemon selalu objek JSON. `{}` berarti tanpa keputusan, sehingga alur izin normal berjalan.

Daemon bisa dinyalakan otomatis saat masuk ke laptop dengan `autostart install` (lihat `docs/autostart.md`); perintah `status` melaporkan daemon, relay, jumlah HP, dan autostart.

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
| `SessionEnd` | sesi berakhir: daemon mengirim event `session.recap` (lama sesi dihitung dari event pertama yang terlihat, berkas yang disetujui, jumlah yang ditolak; `autoApproved` 0 sampai ada policy engine). Relay menandai sesinya `ended`. `SessionEnd` ganda menghasilkan satu rekap; sesi yang tidak dikenal (daemon dimulai ulang di tengah sesi) menghasilkan rekap dengan durasi 0 |
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

**Keputusan otomatis (policy).** Sebelum menahan, daemon bertanya ke policy engine (`docs/policy.md`, bagian "Tersambung ke hook") untuk aksi `Bash`, `PowerShell`, dan alat pengubah berkas di `PreToolUse`. Aksi yang diizinkan atau ditolak aturan pengguna dijawab langsung, dicatat sebagai `approval.auto_resolved`, dan **tidak memicu notifikasi**; selebihnya ditahan seperti di atas.

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

## Halaman web lokal (alat pengembangan)
Halaman sederhana yang dilayani daemon untuk membuktikan alur inti dari awal sampai akhir sebelum ada relay dan HP: melihat izin yang menunggu beserta diff-nya, menyetujui atau menolak dengan komentar, dan membaca timeline. Tampilannya sengaja polos.

**Hanya aktif di mode pengembangan.** Bawaannya mati, dan alamat `/dev` tidak ada sama sekali (404). Nyalakan:

```bash
AGENTMON_HOLD=1 AGENTMON_DEV_UI=1 pnpm --filter @agentmon/bridge daemon
pnpm --filter @agentmon/bridge cli ui     # mencetak alamat lengkap dengan kredensial
```
`AGENTMON_DEV_UI=1` tidak berlaku bila `NODE_ENV=production`. Tanpa `AGENTMON_HOLD=1` halaman tetap menyala, tetapi tidak ada izin yang ditahan sehingga daftarnya kosong.

**Kredensial.** Alamat dari `cli ui` berbentuk `http://127.0.0.1:47821/dev#<token>`. Token ada di bagian setelah `#` (fragmen), yang tidak pernah dikirim ke server dan tidak masuk log. Halaman membacanya, langsung menghapusnya dari alamat, dan menyimpannya hanya untuk tab itu. Token tidak boleh ada di query string (`?token=`), karena itu akan masuk log dan riwayat. Alamat itu berisi kredensial, jadi jangan dibagikan.

| Alamat | Fungsi | Kredensial |
|---|---|---|
| `GET /dev` | Kode halaman. Tidak berisi data atau rahasia | Tidak perlu |
| `GET /dev/api/state` | Status, izin yang menunggu (dengan diff), timeline | Token wajib |
| `POST /dev/api/decision` | Setujui atau tolak. Aturannya sama dengan `/decision` | Token wajib |
| `POST /dev/api/pause`, `/dev/api/resume` | Jeda dan lanjutkan penahanan | Token wajib |

**Keamanan** (semuanya dijaga test):
- **Penjaga biasa tidak dilonggarkan.** Semua endpoint lain (`/hook`, `/status`, `/decision`, ...) tetap menolak setiap request dari browser. Hanya `/dev/...` yang memakai penjaga khusus.
- **Penjaga `/dev`:** Host harus `127.0.0.1` atau `localhost` (menolak DNS rebinding); `Origin` dari situs lain ditolak; API menolak `Sec-Fetch-Site` selain `same-origin` (penanda ini dipasang browser dan tidak bisa dipalsukan halaman web), jadi situs lain tidak bisa menembak API walau tahu tokennya; token Bearer tetap wajib.
- **Isi dari agent tidak dipercaya.** Isi berkas, perintah, dan nama berkas dirender sebagai **teks** (tidak pernah `innerHTML`), sehingga `<script>` atau `onerror` di dalam kode hanya tampil sebagai tulisan. Uji dengan browser sungguhan membuktikan skrip hostile tidak dieksekusi.
- **CSP ketat:** `default-src 'none'`, skrip dan gaya hanya yang membawa kode acak sekali pakai (berbeda tiap pemuatan), `connect-src 'self'`, `frame-ancestors 'none'`, tanpa `unsafe-inline` dan `unsafe-eval`. Halaman tidak memuat apa pun dari luar.
- **Timeline hanya ringkasan** ("alat diminta: Write", "keputusan: denied"), tanpa isi input, pesan agent, atau komentar. Jumlahnya dibatasi 200 dan tidak disimpan ke disk.
- Input alat yang tampil dipotong (teks lebih dari 2000 karakter); diff lengkap tampil terpisah.

Halaman memperbarui diri tiap detik (polling). Komentar yang sedang diketik tidak hilang saat pembaruan.

## Kalkulator diff
Saat sebuah aksi ditahan, daemon menghitung **perubahan yang diusulkan agent** dan menyimpannya bersama izin yang menunggu (`approvals.get(id).diff`), sebagai bahan tampilan review dan terima sebagian. Kodenya di `packages/bridge/src/diff/`, dan bentuk datanya di paket `shared` (`diff.ts`) karena dipakai bersama halaman web dan HP.

**Alurnya** (`computeToolDiff`):
1. Baca isi berkas **sekarang** di laptop (path relatif diselesaikan terhadap folder kerja agent).
2. Bayangkan hasil akhirnya. `Write` membawa isi lengkap; `Edit` dan `MultiEdit` diterapkan dulu pada isi yang ada, dengan aturan seperti di Claude Code (teks yang dicari harus ada, dan tunggal kecuali `replace_all`).
3. Bandingkan baris demi baris (algoritma Myers), kelompokkan menjadi **hunk** dengan 3 baris konteks. Hunk diberi id `h1`, `h2`, dan seterusnya, yang nanti dipakai sebagai `hunkId` pada keputusan terima sebagian.
4. Tandai path sensitif.

**Hasil** (`change.type`): `text` (hunk, jumlah baris ditambah dan dihapus, `isNew` untuk berkas baru), `unchanged` (isi sama), `binary`, `too_large`, atau `mismatch` (usulan tidak bisa diterapkan: berkas tidak ada, teks tidak ditemukan, ambigu, atau tidak terbaca).

**Kasus sulit:**

| Kasus | Perilaku |
|---|---|
| Berkas biner (ada byte NUL, atau bukan UTF-8 yang sah) | `binary`, isinya tidak ditampilkan |
| Berkas lebih dari 1 MiB | `too_large`. **Ukuran diperiksa sebelum membaca**, jadi isinya tidak pernah masuk memori |
| Terlalu banyak baris berbeda (lebih dari 20 000 baris dibandingkan, atau jarak edit di atas 1000) | `too_large` dengan perkiraan jumlah baris. Bagian awal dan akhir yang sama dibuang dulu, jadi berkas besar dengan perubahan kecil tetap menghasilkan diff penuh |
| Akhir baris Windows (CRLF) | Disamakan dengan LF saat membandingkan, sehingga berkas CRLF yang ditulis ulang dengan LF tidak terlihat berubah seluruhnya. Perbedaan gaya akhir baris dan enter di akhir berkas dicatat terpisah di `format` |
| `Edit` yang tidak cocok | `mismatch`, bukan error |
| Target bukan berkas biasa (folder, perangkat) | `mismatch` dengan alasan `unreadable` |

**Path sensitif** ditandai beserta alasannya, hanya dari path (isi tidak diperiksa): `env_file`, `private_key`, `credentials`, `git_internals`, `ci_workflow`, `agent_config` (`.claude`, `.agentmon`, `.codex`), `shell_profile`, `script_config` (`package.json`, `Makefile`, dan sejenisnya, yang membuka "celah skrip" di PRD §9), serta `outside_project`. Ini hanya penanda; level risikonya diberikan penilai risiko (lihat [risk-levels.md](risk-levels.md)), dan keputusan otomatis ada di policy engine. Setiap izin yang ditahan kini membawa `risk` (level dan alasan) di kartu dan di event `approval.requested`; penilainya hanya membaca nama alat, input alat, dan folder kerja.

**Tidak pernah menghalangi aksi.** Diff hanya bahan tampilan. Menghitungnya dibatasi 2 detik; bila gagal, error, atau melewati batas, aksi tetap ditahan tanpa diff. Kalkulator tidak pernah mengubah apa pun di disk.

**Catatan penting:**
- Diff **memuat isi berkas** (termasuk berkas yang ditandai sensitif). Ia hanya disimpan di memori daemon bersama izinnya, tidak masuk log, tidak ikut event `approval.requested`, dan tidak tampil di `status` (yang hanya menampilkan ringkasan seperti `+3 -1 (2 hunk)` dan kode alasan sensitif). Saat nanti dikirim ke HP, diff harus ikut terenkripsi (tahap 4).
- Menghitung diff berjalan di thread utama dan murni CPU. Batas di atas menjaganya tetap singkat (puluhan milidetik dalam kasus terburuk), sejalan dengan aturan bahwa daemon tidak boleh memblokir event loop-nya.

## Endpoint
| Endpoint | Fungsi |
|---|---|
| `GET /health` | `status`, `version`, `pid`, `startedAt`, `uptimeMs` |
| `POST /hook` | Menerima input hook (`Content-Type: application/json`, maksimum 10 MiB). Jawaban `200` |
| `POST /stop` | Menghentikan daemon dengan rapi (dipakai `agentmon uninstall`). Jawaban `200 {"stopping":true}` dikirim dulu, lalu daemon berhenti. Butuh token yang sama dengan perintah lain; `501` bila daemon dijalankan tanpa dukungan ini |

Kode lain: `400` (JSON atau bentuk tidak valid), `404`, `405`, `413` (terlalu besar), `415` (bukan JSON).

## Perilaku saat gagal
Penangan hook yang error tetap dijawab `200` dengan `{}` dan dicatat, bukan `500` dan bukan persetujuan. Daemon mati atau menolak request tidak menghentikan agent: Claude Code menganggapnya kesalahan tanpa pemblokiran dan meneruskan alur izin normal. Buktinya ada di [hooks-claude-code.md](hooks-claude-code.md), bagian 8b: jawaban teks biasa, JSON terpotong, nilai keputusan yang tidak dikenal, status 500, token salah, port salah, daemon mati, dan daemon yang terlalu lambat semuanya diperlakukan seperti tanpa keputusan.

**Daemon tidak boleh memblokir event loop-nya.** Hook menunggu jawaban sampai batas waktunya (bawaan 600 detik), jadi daemon yang membeku sama dengan agent yang berhenti. Pekerjaan berat di dalam penangan hook, misalnya menghitung diff besar atau menjalankan git, harus asinkron.

## Checkpoint git

Sebelum alat pengubah berkas (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) dijalankan, daemon memotret keadaan proyek (`src/checkpoint.ts`) dan mengirim event `checkpoint.created`. Pemotretan terjadi di hook `PreToolUse`, SEBELUM aksi ditahan menunggu keputusan atau dilepas, termasuk saat mode `bypassPermissions`. Matikan dengan `AGENTMON_CHECKPOINT=0`.

**Cara kerjanya (tidak menyentuh repo pengguna):** index git pengguna disalin ke berkas sementara, lalu `git add -A`, `git write-tree`, `git commit-tree` (induknya HEAD), dan `git update-ref` dijalankan terhadap salinan itu (lewat `GIT_INDEX_FILE`). Hasilnya disimpan di `refs/agentmon/checkpoints/<waktu>-<acak>`, di luar cabang, tag, dan stash. Index asli, cabang aktif, stash, `git status`, dan `git log` (HEAD) sama persis sebelum dan sesudah, dan itu diuji dengan membandingkan keadaannya (termasuk hash berkas index). Yang terlihat hanya: objek git baru di `.git/objects`, dan commit checkpoint muncul di `git log --all`. Perintah git dijalankan tanpa hook milik pengguna (`core.hooksPath` dikosongkan, jadi mis. hook `reference-transaction` tidak berjalan) dan tanpa fsmonitor, dan variabel `GIT_*` dari lingkungan daemon (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, dan sejenisnya) dibuang supaya checkpoint tidak tertulis ke repo yang salah.

**Isi snapshot:** berkas yang dilacak ditambah berkas baru yang belum dilacak; berkas yang dihapus tidak ada. Berkas yang di-ignore (`.gitignore`, mis. `.env`) **tidak** ditangkap, sehingga tidak ikut dipulihkan oleh rollback.

**Pembersihan:** hanya 50 checkpoint terbaru yang disimpan; yang lebih lama dihapus, dan hanya dari namespace `refs/agentmon/checkpoints/` (cabang, tag, atau ref lain milik pengguna tidak disentuh, termasuk yang namanya mirip).

**Gagal tidak menghalangi agent.** Semua galat menjadi hasil `ok: false` yang hanya dicatat di log: folder bukan repo git (fitur nonaktif untuk folder itu, dicatat sekali), git tidak terpasang, repo yang akarnya folder home (terlalu luas, ditolak), repo rusak, dan melewati batas waktu 10 detik. Index yang terkunci (`index.lock`) tidak menghalangi karena checkpoint memakai salinan index.

**Waktu pemotretan** (Windows, Node 24, satu perubahan kecil setelah commit; rata-rata tiga ukuran): 200 berkas ±350 ms, 5.000 berkas ±560 ms, 20.000 berkas ±580 ms. Batas waktu seluruh checkpoint 5 detik (checkpoint berada di jalur hook, tempat agent menunggu). Sebagian besar waktu adalah memulai proses git (beberapa kali per checkpoint), bukan membaca berkas, karena salinan index membawa catatan stat sehingga berkas tak berubah tidak dibaca ulang. Belum diukur: repo ratusan ribu berkas, disk jaringan, dan Linux/macOS (CI menjalankan tesnya di ketiganya).

Batas yang perlu diketahui: (1) berkas besar atau rahasia yang BELUM di-ignore ikut masuk ke database objek git, sama seperti bila di-`git add`; (2) repo yang memakai filter git (mis. git-lfs) tetap menjalankan filter `clean` pada berkas yang berubah saat `git add -A`, yang bisa menulis ke penyimpanan filter itu (misalnya `.git/lfs`); (3) bila waktu habis, proses git dihentikan tetapi proses anak seperti filter tidak dijamin ikut berhenti, terutama di Windows; (4) tes belum mencakup CRLF (`core.autocrlf=true`), worktree, dan submodule.

Keterbatasan: efek di luar berkas (`git push`, jaringan, database) tidak bisa dibatalkan. Rollback itu sendiri dikerjakan di issue lain; di sini hanya pemotretan.

## Rollback dari HP

Dari timeline di HP, event "Checkpoint dibuat" punya tautan "Kembalikan ke sini". Alurnya (`src/rollback.ts`, layar `src/rollback/RollbackScreen.tsx` di PWA):

1. **Pratinjau.** HP mengirim `rollback.preview`; laptop membandingkan checkpoint dengan keadaan sekarang dan membalas daftar berkas yang akan dibuat lagi, dikembalikan isinya, atau **dihapus** (pekerjaan setelah checkpoint ikut tercantum), beserta sidik (hash) daftar itu. Paling banyak 200 berkas dikirim; jumlah sebenarnya tetap dilaporkan.
2. **Konfirmasi dua ketukan** di HP, dengan keterangan hal yang tidak bisa dibatalkan.
3. **Penerapan.** HP mengirim `rollback.apply` beserta sidik pratinjau. Laptop menghitung ulang; bila daftarnya berbeda ditolak (`preview_changed`). Ditolak juga bila agent masih berjalan di sesi itu (`agent_running`), checkpoint tidak dikenal/hilang/rusak, jalur berkas tidak aman, atau rollback lain sedang berjalan untuk repo itu.
4. **Pengaman.** Sebelum menyentuh berkas apa pun, keadaan sekarang disimpan sebagai checkpoint baru; gagal menyimpannya berarti tidak ada yang diubah. Hasil akhir diverifikasi (isi harus sama persis dengan checkpoint); bila gagal di tengah jalan, keadaan sebelumnya dipulihkan otomatis dan hasilnya dilaporkan `failed` dengan `recovered`.
5. **Membatalkan rollback** = rollback ke checkpoint pengaman yang dikembalikan oleh rollback sebelumnya (tautan "Batalkan rollback" di HP). Rollback itu pun menyimpan pengamannya sendiri, jadi bisa diulang maju.

"Agent masih berjalan" dibaca dari event terakhir sesi (`src/session-activity.ts`): `agent.stopped` atau `session.recap` berarti selesai; event lain berarti bekerja, dan sesi yang tidak ada kabar 10 menit dianggap diam. Daftar nomor checkpoint ke repo dan sesi disimpan di `checkpoints.json` di folder data daemon, sehingga rollback tetap bekerja setelah daemon dimulai ulang. Setelah rollback berhasil, event `checkpoint.restored` dikirim.

**Yang dipulihkan:** berkas yang dilacak dan berkas baru yang belum dilacak. Berkas yang di-ignore tidak disentuh. Index git milik pengguna tidak diubah, jadi `git status` bisa menampilkan perbedaan terhadap index sesudah rollback. Hanya 50 checkpoint terbaru yang disimpan, termasuk checkpoint pengaman, jadi pembatalan lama kelamaan tidak lagi tersedia.

**Keamanan:** perintah hanya diterima dari HP yang dipasangkan dan belum dicabut (diperiksa relay pada setiap perintah, termasuk dari soket lama yang belum diputus; diuji). **Belum ada tanda tangan perintah**: issue 034 menambahkannya, jadi sampai itu selesai keamanan perintah bergantung pada token HP dan relay. Dokumentasi relay tidak perlu berubah.

**Belum diuji:** di HP dan browser nyata (hanya tes otomatis dan jsdom), pada repo yang sangat besar, dengan `core.autocrlf=true`, worktree, dan submodule. Pada Windows, pembersihan berkas yang sedang dikunci proses lain bisa gagal dan dilaporkan sebagai kegagalan dengan pemulihan otomatis.

**Perlindungan tambahan di rollback (hasil review):** (1) berkas yang di-ignore tidak pernah ditimpa atau dihapus: bila ada yang menempati jalur yang akan dipulihkan (berkas yang kini ter-ignore, folder berisi berkas ter-ignore di jalur sebuah berkas, atau berkas ter-ignore di jalur folder induk), rollback ditolak (`ignored_conflict`); (2) target dikunci ke SHA sebelum checkpoint pengaman dibuat, jadi pemangkasan checkpoint lama tidak bisa menghilangkannya; (3) setelah pengaman dibuat, keadaan dihitung ulang dan harus sama dengan yang baru disimpan, bila tidak ditolak; (4) pemulihan otomatis hanya menyentuh jalur yang disentuh rollback, jadi berkas milik pihak lain tidak ikut terhapus; (5) penolakan sebelum pengaman (sidik salah, agent berjalan, konflik) tidak memakan slot checkpoint; (6) status agent dicek lagi tepat sebelum berkas diubah, dan sesi yang masih punya izin menunggu dianggap berjalan walau lama tanpa event.

**Celah yang masih ada:** agent yang mulai bekerja di tengah rollback (setelah pemeriksaan terakhir) tidak dihalangi; status "berjalan" hilang saat daemon dimulai ulang (sesi dianggap diam sampai ada event); repo bersarang dan submodule belum didukung (rollback bisa gagal lalu dipulihkan otomatis); `checkpoint.restored` yang dikirim setelah sesi berakhir bernomor urut 0.

## Ringkasan perubahan (deterministik)

Untuk tiap permintaan izin yang punya diff, daemon menyusun ringkasan DATA (`src/diff-summary.ts`, skema di `shared/src/summary.ts`) dan mengirimnya di event `approval.requested` sebagai `diffSummary`, tanpa AI. HP menyusunnya menjadi kalimat Bahasa Indonesia atau Inggris lewat i18n. Ringkasan tetap terkirim walau diff-nya sendiri terlalu besar untuk dikirim.

**Isi:** berkas dan jenis perubahannya (diubah, baru, tidak berubah, hanya format, biner, terlalu besar, tidak cocok), jumlah baris ditambah dan dihapus, jumlah hunk, dan deklarasi (fungsi, kelas, tipe) yang **baris deklarasinya sendiri** ditambah atau dihapus. Nama yang sama di baris dihapus dan ditambah dicatat "diubah".

**Aturan agar tidak mengklaim yang tidak terbukti:** (1) angka diambil langsung dari diff; (2) fungsi yang hanya badannya berubah, dengan baris deklarasi tidak tersentuh, TIDAK dicantumkan, karena menyebut "perubahan di dalam fungsi X" butuh analisis ruang lingkup yang tidak bisa dibuktikan dari baris diff; (3) tidak ada tebakan ganti nama: nama lama (dihapus) dan nama baru (ditambah) dicantumkan terpisah; (4) deklarasi yang barisnya hanya dipindah atau diindentasi ulang (teks sama setelah spasi dirapikan) tidak dicantumkan sebagai berubah, dan nama sama dengan lingkup berbeda (receiver Go) dianggap deklarasi berbeda; (5) nama harus lengkap: nama yang terpotong (non-ASCII atau karakter kontrol) tidak dilaporkan, dan kata yang hanya mengandung `function` (functionality, functions) bukan deklarasi; (6) tampilan menyebut daftar ini "yang dikenali", menyertakan catatan keterbatasan deteksi, dan menyatakan bahwa ini bukan penilaian maksud perubahan.

**Bahasa:** deklarasi dideteksi untuk JavaScript/TypeScript (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`), Python, Go, dan Rust, dengan pola per baris. Bahasa lain (mis. Java, C) tetap mendapat ringkasan dasar (berkas, jumlah baris, hunk), dan tampilan memberi tahu bahwa bahasa itu tidak dikenali sehingga nama fungsi tidak dideteksi. Batas: paling banyak 50 berkas dan 10 deklarasi per berkas (sisanya ditandai), baris di atas 400 karakter diabaikan, dan deteksi per baris bisa melewatkan deklarasi yang ditulis berbaris-baris. **Batas yang diketahui:** pola per baris tidak tahu apakah sebuah baris berada di dalam template literal, komentar blok, docstring, atau teks JSX yang berbaris-baris, sehingga baris di sana yang menyerupai deklarasi bisa tercantum; sebaliknya method kelas, `export default () =>`, `const x = function`, dan fungsi anonim yang dibungkus pemanggilan tidak dikenali. Karena itu daftar kosong BUKAN bukti tidak ada deklarasi yang berubah, dan tampilan mengatakannya.

## Pengaturan relay dan pendaftaran

Daemon menyambung ke relay bila laptop sudah terdaftar. `register` menyimpan alamat relay dan token laptop di `relay.json` di folder data (`~/.agentmon`, atau `AGENTMON_HOME`); daemon membacanya saat mulai. `AGENTMON_RELAY_URL` dan `AGENTMON_RELAY_TOKEN` bila **keduanya** diisi tetap menang atas berkas. Berkas yang rusak hanya mematikan relay (dengan pesan yang menyebut lokasinya); daemon tetap jalan. Daemon dijalankan ulang setelah `register`. Langkah dan keamanannya: [`relay.md`](relay.md#pendaftaran-laptop) dan [`deploy.md`](deploy.md).
