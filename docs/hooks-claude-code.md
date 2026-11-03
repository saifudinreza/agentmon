# Hook Claude Code: temuan uji nyata

Hasil riset issue "Spike: hook logger Claude Code dan fixture" (#5). Diuji dengan **Claude Code 2.1.314 di Windows 11**, pada 1 November 2026. Alat ujinya ada di [tools/hook-spike](../tools/hook-spike/README.md), dan contoh datanya di [packages/bridge/fixtures/claude-code](../packages/bridge/fixtures/claude-code).

## 1. Kesimpulan

1. **Semua kemampuan yang dibutuhkan ketiga pilar terbukti bekerja:** menahan aksi, menolak dengan alasan yang dibaca Claude, mengizinkan, mengubah input (terima sebagian), dan melanjutkan agent setelah selesai.
2. **Terima sebagian di Claude Code bisa dilakukan** lewat `updatedInput`. Fallback "tolak utuh + komentar per hunk" hanya cadangan.
3. **Claude tidak diberi tahu bila inputnya diubah.** Ia mengira usulan aslinya yang diterapkan. Catatan lewat `additionalContext` wajib dikirim bersama keputusan sebagian.
4. **Semua kegagalan berujung ke alur izin normal:** hook mati, timeout, keluar dengan kode 1, dan server hook `http` yang mati. Tidak ada kegagalan yang berubah menjadi `allow`.
5. **Dua asumsi PRD perlu disesuaikan:** nama alat shell berbeda per sistem (`Bash` dan `PowerShell`), dan `PermissionRequest` tidak muncul untuk semua aksi.
6. **Hook `command` yang memanggil `node` butuh sekitar 200 ms**, lebih lambat dari target 150 ms. Hook bertipe `http` terbukti berfungsi sebagai alternatif.
7. **Skema di paket `shared` (#3) tidak perlu diubah.**
8. **Hook `http` aman terhadap semua kegagalan yang diuji**, dan overhead-nya jauh di bawah hook `node` (bagian 8b).

## 2. Cara riset dan batasannya

- 20 sesi `claude -p` (mode non-interaktif) dengan model `haiku`, masing-masing di folder proyek sementara. Hook dipasang lewat `--settings` untuk satu sesi saja.
- Tiap sesi dicatat dua sisi: yang diterima hook (`events.jsonl`) dan yang dilihat Claude (`stream.jsonl`).
- **Batasan penting:** mode non-interaktif tidak bisa menampilkan prompt izin. Saat tidak ada keputusan, Claude menolak aksinya dengan pesan `Claude requested permissions to write to ..., but you haven't granted it yet`. Jadi "kembali ke alur normal" terbukti sebagai *hook tidak memengaruhi apa pun*, tetapi munculnya prompt di terminal interaktif belum teramati langsung.
- Sesi percobaan tidak sepenuhnya terisolasi: memori pengguna (`MEMORY.md`) tetap terbaca Claude meski `--setting-sources project` dipakai.

## 3. Event yang teramati

| Event | Muncul | Catatan |
|---|---|---|
| `SessionStart` | Ya | Berisi `source` (misalnya `startup`), tanpa `permission_mode` |
| `UserPromptSubmit` | Ya | Berisi `prompt` dan `prompt_id` |
| `PreToolUse` | Ya, untuk **semua** alat | `Read`, `Glob`, `Write`, `Edit`, `Bash`, `PowerShell` |
| `PermissionRequest` | Hanya bila ada prompt izin | Muncul untuk `Write`, `Edit`, dan perintah shell yang mengubah sesuatu. **Tidak** untuk `Read`, `Glob`, atau `echo` |
| `PostToolUse` | Ya, bila alat berhasil | Berisi `tool_response` dan `duration_ms` |
| `Stop` | Ya | Berisi `stop_hook_active` dan `last_assistant_message` |
| `SessionEnd` | Ya | Berisi `reason` |
| `Notification` | **Tidak teramati** | Tidak muncul di mode non-interaktif |

**Kolom umum** di hampir semua event: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`, `permission_mode`. Kolom `effort` muncul di sebagian pemanggilan, jadi parser harus toleran terhadap kolom tambahan (Zod membuang kolom asing, sesuai yang kita mau).

**Bentuk input alat** (`tool_input`):

| Alat | Kolom |
|---|---|
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` (satu penggantian per panggilan, tidak ada `MultiEdit`) |
| `Write` | `file_path`, `content` |
| `Read` | `file_path` |
| `Glob` | `pattern` |
| `Bash`, `PowerShell` | `command`, `description` |

`PermissionRequest` membawa `tool_input` yang sama, ditambah `permission_suggestions` (contoh: `[{"type":"setMode","mode":"acceptEdits","destination":"session"}]`).

**Nama alat shell.** Claude Code di Windows menyediakan `Bash` dan `PowerShell`, dan model memilih `PowerShell` secara bawaan. Keduanya muncul dengan nama alat yang berbeda. Perilaku di macOS dan Linux belum diuji.

## 4. Hasil eksperimen

Semua pada `permission_mode: default` kecuali disebut lain. Nomor mengikuti nama folder hasil.

| # | Eksperimen | Hasil |
|---|---|---|
| 01 | Dasar, semua izin dijawab `allow` | Semua event di bagian 3 tertangkap, file berhasil dibuat dan diubah |
| 02 | `PreToolUse` mengembalikan `deny` + alasan | Aksi tidak berjalan. Claude mengutip alasan dengan awalan `PreToolUse:Write hook error:`. `PermissionRequest` dan `PostToolUse` **tidak** muncul |
| 03 | `PreToolUse` mengembalikan `allow` | Aksi berjalan **tanpa** `PermissionRequest`, jadi `allow` melewati prompt |
| 04 | Tanpa keputusan | `PermissionRequest` muncul tanpa jawaban. Alur normal berlanjut (headless: ditolak) |
| 05 | `PermissionRequest` mengembalikan `deny` + `message` | Aksi tidak berjalan. Claude mengutip `message` **apa adanya**, tanpa awalan |
| 06 | `PreToolUse` `allow` + `updatedInput` + `additionalContext` pada `Edit` | **File berisi versi hook**, bukan versi Claude. Claude mengira ia menulis "Hai", dan baru tahu soal perubahan karena `additionalContext`, yang tampil sebagai `PreToolUse:Edit hook additional context` |
| 07 | `PermissionRequest` `allow` + `updatedInput` pada `Write` | File berisi versi hook. Claude tetap mengira ia menulis isi aslinya |
| 08 | `Stop` mengembalikan `decision: block` + `reason` | Claude melanjutkan dan mengerjakan `reason`. Pemanggilan `Stop` kedua membawa `stop_hook_active: true`. UI memunculkan pemberitahuan "Stop hook error" |
| 09 | `PreToolUse` tidur 6 detik, timeout 2 detik | Hook dihentikan sekitar 2 detik, keluarannya dibuang, alur normal berlanjut ke `PermissionRequest` |
| 10 | `PermissionRequest` tidur 6 detik, timeout 2 detik | Hook dihentikan. Karena jawabannya `allow` ikut terbuang, hasilnya sama seperti tanpa keputusan |
| 11 | `PreToolUse` keluar dengan kode 2 + stderr | Aksi diblokir. Pesan ke Claude berisi **perintah hook** (path skrip) di depan stderr |
| 12 | `PreToolUse` keluar dengan kode 1 | **Tidak memblokir**, alur normal berlanjut |
| 13 | Mode `acceptEdits` | `PreToolUse` dan `PostToolUse` tetap muncul. `PermissionRequest` tidak muncul untuk `Edit` |
| 14 | Mode `bypassPermissions` | `PreToolUse` tetap muncul dengan `permission_mode: "bypassPermissions"` |
| 15 | Alat `Bash`, perintah mengubah file | `PreToolUse`, `PermissionRequest`, `PostToolUse` muncul dengan `tool_name: "Bash"` |
| 16 | Alat `PowerShell`, perintah mengubah file | Sama, dengan `tool_name: "PowerShell"` |
| 17 | `PreToolUse` mengembalikan `ask` | Diterima, tetapi di mode headless langsung ditolak dengan alasannya. `PermissionRequest` **tidak** muncul |
| 18 | `PermissionRequest` mengembalikan `behavior: "ask"` | **Diabaikan**, sama seperti tanpa keputusan |
| 19 | Hook bertipe `http` | Claude Code mengirim `POST` berisi JSON yang sama dengan stdin. Jawaban `allow` dari server berfungsi |
| 20 | Hook `http` ke server yang mati | Tidak memblokir dan tidak membuat agent macet. Alur normal berlanjut |

**Kecepatan hook `command`** (12 pemanggilan `node log-hook.mjs`, Windows): median sekitar 203 ms, rentang 192 sampai 264 ms (satu pengukuran 612 ms). Menjalankan `node` kosong saja sudah 141 sampai 177 ms.

## 5. Verifikasi klaim PRD §11 (kolom Claude Code)

| Klaim | Status |
|---|---|
| `PreToolUse` menahan sebelum aksi | Terbukti (02, 03) |
| `permissionDecision: "allow"` | Terbukti, dan melewati prompt (03) |
| `deny` + alasan terlihat oleh Claude | Terbukti. **Koreksi:** alasan diberi awalan `PreToolUse:<Alat> hook error:` (02) |
| Tanpa keputusan kembali ke alur normal | Terbukti (04, 09, 10, 12, 20). Prompt interaktif belum teramati |
| `ask` didukung di `PreToolUse` | **Sebagian.** Diterima, tetapi di mode headless langsung menolak. Perilaku interaktif belum teramati (17) |
| `updatedInput` mengganti seluruh input | Terbukti di `PreToolUse` (06) dan `PermissionRequest` (07). **Tambahan:** Claude tidak diberi tahu |
| `PermissionRequest`: `allow`/`deny`, `updatedInput`, `message` | Terbukti (05, 07). `interrupt` belum diuji |
| `PermissionRequest` tidak mendukung `ask` | Terbukti. Nilai itu diabaikan (18) |
| `additionalContext` | Terbukti di `PreToolUse` (06). Di event lain belum diuji |
| `Stop` + `block` + `reason` melanjutkan agent | Terbukti (08). `stop_hook_active` bernilai `true` pada pemanggilan kedua |
| Timeout `PreToolUse` melanjutkan alur normal | Terbukti (09). Berlaku juga untuk `PermissionRequest` (10) |
| Timeout bawaan 600 detik | Tidak diuji, mengikuti dokumentasi |

## 6. Bentuk keputusan yang sudah terbukti

Ini keluaran hook (ke stdout, kode keluar 0) yang diuji dan berfungsi.

**Izinkan di `PreToolUse`** (melewati prompt):
```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" } }
```

**Tolak di `PreToolUse`** (Claude membaca alasannya):
```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
  "permissionDecisionReason": "alasan untuk Claude" } }
```

**Terima sebagian** (input diganti seluruhnya, Claude diberi catatan):
```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow",
  "updatedInput": { "file_path": "...", "old_string": "...", "new_string": "versi yang disaring", "replace_all": false },
  "additionalContext": "Hunk 2 ditolak pengguna: ..." } }
```

**`PermissionRequest`** (izinkan atau tolak):
```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": "alasan" } } }
```

**Lanjutkan agent saat `Stop`:**
```json
{ "decision": "block", "reason": "umpan balik untuk Claude" }
```

**Kembali ke alur normal:** keluar dengan kode 0 tanpa keluaran apa pun.

Pada percobaan `updatedInput`, hook selalu mengembalikan **objek input lengkap**. Mengembalikan sebagian kolom saja belum diuji.

## 7. Dampak ke desain

- **Ambil keputusan Edit dan Write di `PreToolUse`.** Muncul untuk semua alat, `allow` melewati prompt, dan `updatedInput` tersedia di sana. `PermissionRequest` cukup sebagai pengaman bila `PreToolUse` tidak memberi keputusan.
- **Alasan penolakan yang bersih** didapat dari `PermissionRequest` (`message` tanpa awalan) atau JSON `deny` di `PreToolUse`. Hindari kode keluar 2, karena pesannya membocorkan perintah hook ke Claude.
- **Terima sebagian wajib disertai `additionalContext`.** Tanpa itu, Claude mengira seluruh usulannya diterapkan dan mengambil keputusan berikutnya berdasarkan keadaan yang salah.
- **Mode `bypassPermissions`** bisa dipantau saja lewat `PreToolUse` (sesuai keputusan PRD §18), karena event tetap muncul dengan `permission_mode` yang jelas.
- **Hook `command` dengan `node` terlalu lambat untuk target 150 ms** pada laptop ini. Pilihan: hook `http` ke daemon (tanpa proses baru, gagal secara aman), atau runner yang lebih cepat dari `node`. Hook `http` hanya terbukti di Claude Code. Dukungan Codex belum ada di dokumentasi yang kita periksa.
- **Penilai risiko** harus memahami sintaks `PowerShell`, bukan hanya `Bash`.
- **Umpan balik per giliran lewat `Stop`** berfungsi, tetapi UI Claude Code menampilkan pemberitahuan "Stop hook error". Perlu dipertimbangkan agar pengguna tidak mengira ada yang rusak.
- **`PermissionRequest` tidak bisa dipakai untuk memantau semua aksi.** Pemantauan timeline dan auto-approve harus bersumber dari `PreToolUse` dan `PostToolUse`.

### Skema di paket `shared` (#3)
Dicocokkan dengan data nyata, **tidak ada yang perlu diubah**:

| Payload | Sumber | Status |
|---|---|---|
| `session.started` (`cwd`, `permissionMode?`) | `SessionStart` | Cocok. `permission_mode` tidak ada di event ini, dan sudah opsional |
| `tool.requested` (`toolName`, `toolInput`, `toolUseId?`) | `PreToolUse` | Cocok. `tool_input` selalu berupa objek pada semua alat yang diuji |
| `tool.completed` (`toolName`, `toolUseId?`, `ok`) | `PostToolUse` | Cocok. Tidak ada kolom sukses eksplisit, jadi `ok` diturunkan oleh adapter. `duration_ms` bisa ditambahkan nanti |
| `agent.stopped` (`lastMessage?`) | `Stop` | Cocok dengan `last_assistant_message` |
| `agent.notification` | `Notification` | Belum teramati |

## 8a. Hook `http` dengan daemon sungguhan (issue daemon lokal)

Diuji pada 1 November 2026 dengan daemon di `packages/bridge` (lihat [daemon.md](daemon.md)) dan Claude Code 2.1.314, tiap kali satu sesi `claude -p`.

| # | Percobaan | Hasil |
|---|---|---|
| 22 | Header `Authorization: Bearer <token>` ditulis langsung di pengaturan | Diterima. `PreToolUse`, `PermissionRequest`, dan `Stop` sampai ke daemon |
| 23 | Header `Bearer $AGENTMON_TOKEN` dengan `allowedEnvVars` | Diterima. Interpolasi variabel lingkungan berfungsi |
| 24 | Tanpa header | Daemon menolak dengan 401. Alur Claude normal |
| 25 | Token salah | Daemon menolak dengan 401. Alur Claude normal |
| 26 | Daemon dimatikan | Port menolak koneksi seketika. Sesi selesai normal, tanpa jeda akibat hook |

Temuan:
- **Claude Code tidak mengirim `Origin` maupun `Sec-Fetch-*`**, dan `Host` berbentuk `127.0.0.1:<port>`. Aturan daemon yang menolak request dari browser tidak mengganggu Claude Code.
- **Hook yang ditolak (401) tidak dapat dibedakan dari hook tanpa keputusan** dari sisi Claude: tidak ada pesan error hook yang sampai ke model, dan aksi mengikuti alur izin normal.
- **Autentikasi dengan header terbukti**, jadi daemon tidak perlu rancangan token lain.
- Pada macOS dan Linux belum diuji, hanya Windows.

## 8b. Kondisi gagal dan overhead hook `http` (issue hook http ke daemon)

Diuji pada 2 November 2026 dengan Claude Code 2.1.314 di Windows. Konfigurasi hook berasal dari pembuat konfigurasi yang sebenarnya (`buildClaudeHookSettings`), dipasang lewat `--settings` untuk satu sesi, jadi pengaturan Claude Code pengguna tidak disentuh (hash berkas pengaturannya sama sebelum dan sesudah). Skrip: `tools/hook-spike/verify-fail-open.sh` dan `measure-overhead.ts`.

### Kondisi gagal
Setiap skenario meminta Claude membuat sebuah berkas. Yang dinilai: sesi selesai, berkas **tidak** terbuat (tidak ada persetujuan), alur izin normal teramati, tidak ada pesan error hook yang sampai ke Claude, dan waktunya wajar.

| # | Skenario | Hasil |
|---|---|---|
| 00 | Tanpa hook sama sekali (pembanding) | Ditolak lewat alur izin normal, sesi 9 sampai 10 detik |
| 01 | Daemon sungguhan, token benar, tanpa keputusan | Sama seperti pembanding |
| 02 | Daemon mati | Sama seperti pembanding, tanpa jeda yang konsisten |
| 03 | Port salah | Sama seperti pembanding |
| 04 | Token salah (ditolak 401 oleh daemon sungguhan) | Sama seperti pembanding |
| 05 | Daemon terlalu lambat (menjawab setelah 15 detik, batas waktu hook 3 detik) | Hook dihentikan pada batas waktunya. Sesi 17 sampai 20 detik, bukan puluhan detik |
| 06 | Jawaban 200 berupa teks biasa | Sama seperti pembanding |
| 07 | Jawaban 200 berupa JSON terpotong | Sama seperti pembanding |
| 08 | Jawaban 200 berupa JSON valid dengan nilai keputusan yang tidak dikenal | Sama seperti pembanding |
| 09 | Jawaban status 500 | Sama seperti pembanding |
| 10 | Kontrol positif: jawaban `allow` yang sah | Aksi **berjalan**, berkas terbuat |

Dua putaran penuh: 11 dari 11 lolos pada keduanya. Kontrol positif (10) penting: ia membuktikan uji ini memang bisa mendeteksi aksi yang disetujui, sehingga "tidak ada yang disetujui" di skenario lain bermakna.

Temuan:
- **Tidak ada kegagalan yang menghasilkan persetujuan**, dan tidak ada yang mengirim pesan error hook ke Claude. Semuanya identik dengan tanpa hook.
- **Daemon mati tidak menambah jeda yang konsisten.** Selisih durasi antara skenario 00 dan 02 berubah arah antar putaran (sekitar 2 detik ke dua arah) dan berasal dari pilihan alat oleh model, bukan dari hook.
- **Batas waktu hook dipatuhi.** Dengan batas 3 detik, sesi yang daemon-nya diam 15 detik hanya bertambah sekitar 8 sampai 10 detik, bukan menunggu 15 detik per hook.
- Dalam beberapa sesi Claude memilih `Bash` dengan pengalihan keluaran (`> notes.txt`), bukan `Write`. Penolakannya tetap alur izin normal ("needs approval").
- **Daemon yang membeku membuat agent menunggu sampai batas waktu hook** (bawaan 600 detik). Ini sempat terjadi tanpa sengaja: skrip pengukuran memblokir proses yang sama dengan tempat daemon berjalan (`spawnSync`), dan Claude menunggu tanpa jawaban. Bagi Claude itu sama dengan skenario 05. Akibat untuk desain: **daemon tidak boleh memblokir event loop-nya**, misalnya dengan menghitung diff besar atau menjalankan git secara sinkron di dalam penangan hook.

### Overhead
Diukur dengan 15 pembacaan berkas berurutan per putaran, tiga putaran. Untuk tiap pembacaan: waktu antara `PreToolUse` dan `PostToolUse` di daemon dikurangi `duration_ms` dari Claude Code. Angkanya memuat dua panggilan sekaligus (Pre dan Post), jadi **satu hook pasti tidak lebih lambat dari angka ini**.

| Putaran | Median | p95 | Target PRD §14 (< 150 ms) |
|---|---|---|---|
| 1 | 24,5 ms | 59,8 ms | Terpenuhi |
| 2 | 28,2 ms | 122,7 ms | Terpenuhi |
| 3 | 28,2 ms | 48,4 ms | Terpenuhi |

Pembanding: hook `node` sekitar 200 ms per panggilan (bagian 4). Hanya 15 sampel per putaran, jadi p95 praktis sama dengan nilai tertinggi, dan putaran 2 memuat satu pencilan 122,7 ms yang masih di bawah target. Ukuran ini juga memuat sedikit kerja internal Claude Code di antara dua hook, jadi cenderung melebih-lebihkan.

## 8. Belum terbukti

- Event `Notification` (tidak muncul di mode non-interaktif).
- Munculnya prompt di terminal interaktif setelah tanpa keputusan atau `ask`.
- `PostToolUse` untuk alat yang gagal, dan event khusus kegagalan bila ada.
- `interrupt` pada `deny`, dan `additionalContext` di event selain `PreToolUse`.
- Interaksi `allow` dengan aturan deny atau ask milik pengguna, serta beberapa hook sekaligus pada satu event.
- `updatedInput` dengan sebagian kolom saja.
- Pembatasan URL hook `http` lewat pengaturan `allowedHttpHookUrls` (header sudah terbukti, lihat bagian 8a).
- Kondisi gagal hook `http` di macOS dan Linux (bagian 8b hanya diuji di Windows).
- Perilaku bila hook `http` lambat pada event yang menunggu keputusan di terminal interaktif. Mode non-interaktif tidak memunculkan prompt.
- Alat selain `Read`, `Glob`, `Write`, `Edit`, `Bash`, `PowerShell`, misalnya `NotebookEdit` dan alat MCP.
- Perilaku di macOS dan Linux.

## 9. Fixture

19 berkas di `packages/bridge/fixtures/claude-code`, sudah dibersihkan dari path dan ID asli:
`SessionStart`, `UserPromptSubmit`, `Stop`, `Stop.continued`, `SessionEnd`, serta `PreToolUse`, `PermissionRequest`, dan `PostToolUse` untuk alat yang relevan (`Read`, `Write`, `Edit`, `PowerShell`, `Bash`). `PermissionRequest` tidak punya fixture `Read` karena memang tidak muncul.
