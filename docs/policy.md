# Policy engine

Mesin aturan di laptop yang memutuskan satu permintaan izin: **izinkan otomatis**, **tanya** (naik ke HP), atau **tolak otomatis**. Kodenya di `packages/bridge/src/policy/`. Rujukan: PRD §9 (delapan aturan keselamatan), FR-80 sampai FR-84.

> **Sudah tersambung ke hook** (issue #037, lihat bagian "Tersambung ke hook" di bawah). Tampilan aturan aktif di HP ada di #038. Tanpa berkas `policy.json`, tidak ada aksi yang diputuskan otomatis dan semuanya berjalan seperti sebelumnya.

## Tiga hasil
| Hasil | Arti |
|---|---|
| `allow` | Jalan tanpa bertanya. Hanya bila **setiap bagian** permintaan diizinkan aturan milik **pengguna** (lihat "Cara pola `commands` mencocokkan"), penilai risiko menilainya **rendah** (atau sedang yang satu-satunya alasannya "menjalankan kode proyek" **dan** cocok pola persis), dan tidak ada alasan ragu |
| `ask` | Naik ke HP. **Ini bawaan.** Semua keraguan berujung di sini |
| `deny` | Ditolak otomatis oleh aturan tolak |

Urutan keputusan: **tolak > tanya > batas risiko > aturan izinkan > bawaan (tanya)**. Urutan penulisan aturan tidak memengaruhi hasil.

**Keselamatan `allow` tidak bergantung pada penilai risiko.** Penilai berbasis daftar hitam dan terbukti bocor di beberapa tempat (lihat "Batas"), jadi mesin ini menambah lapisan yang berdiri sendiri:
1. **Aturan allow untuk shell wajib memakai `commands`.** Tidak ada "izinkan semua perintah"; aturan tanpa `commands` tidak berlaku untuk Bash/PowerShell (tetap berlaku untuk alat berkas).
2. **Pola persis** (tanpa `*`) mengizinkan tepat perintah itu. **Pola dengan `*` hanya menerima kata biasa** sebagai argumen: diawali huruf, angka, `_`, atau `.`, lalu huruf, angka, `. / \ _ - @ + ~ ^` di dalam kata. Kata hasil pelepasan kutip yang dinilai (`cat 'src/a.ts'` sama dengan `cat src/a.ts`). **Flag (`-x`), jalur mutlak atau rumah (`/c`, `~`, `//host/x`), segmen `..`, koma, titik dua, `=`, `|`, `{}`, `$`, wildcard, dan karakter non-ASCII membuat perintah ditanyakan.** Pola tidak boleh diawali `*` (tidak ada "izinkan semua perintah"), dan pola dengan `*` **tidak pernah dihitung persis walau tanpa argumen** (`yarn *` tidak mengizinkan `yarn`, yang berarti install). Dengan begitu semua serangan lewat opsi atau skrip inline (`sed 's|x|y|e'`, `awk -f`, `git grep --open`, `sort -o`, `date -f`, ...) otomatis jatuh ke tanya, tanpa mesin perlu mengenalinya satu per satu. Perlu flag? Tulis pola persis (`git diff --stat`).
3. **Perintah yang argumennya bisa berupa skrip, program, atau tujuan tulis tidak pernah cocok lewat `*`**: `sed`, `awk`, `find`, `xargs`, `env`, `sort`, `uniq`, `tee`, `cp`, `mv`, `date`, `curl`, interpreter (`node`, `python`, `sh`, ...), dan sejenisnya. Tetap bisa lewat pola persis.
4. **Risiko sedang** (menjalankan kode proyek, mis. `npm test`) **hanya lewat pola persis**; `npm test *` dengan argumen tambahan ditanyakan. Risiko sedang karena alasan lain (perintah tidak dikenal, tidak bisa diurai, mengubah berkas lewat shell, menjalankan perintah di dalam perintah, di luar proyek) tidak pernah di-allow.
5. **Pipa (`|`) dan perintah yang mengubah keadaan shell** (`cd`, `pushd`, `export`, `set`, `alias`, `source`, `eval`, ...) tidak pernah di-allow: perintah sesudahnya berjalan di tempat atau keadaan yang tidak diketahui.

## Berkas aturan
`~/.agentmon/policy.json` (di folder data daemon, `AGENTMON_HOME` bila diubah). Tidak ada berkas berarti tidak ada aturan, dan itu wajar: **tanpa aturan, tidak ada aksi yang berjalan otomatis**, walau risikonya rendah.

```json
{
  "version": 1,
  "rules": [
    { "id": "tes", "action": "allow", "tool": "Bash", "commands": ["npm test", "git status", "git diff *"] },
    { "id": "edit-src", "action": "allow", "tool": "Write", "paths": ["src/**/*.ts"] },
    { "id": "jangan-hapus", "action": "deny", "tool": "Bash", "commands": ["rm *"] }
  ]
}
```

| Kolom | Isi |
|---|---|
| `id` | Nama aturan (huruf, angka, `.`, `_`, `-`; maksimal 64). Harus unik. Dicatat bersama tiap keputusan |
| `action` | `allow`, `ask`, atau `deny` |
| `tool` | Nama alat persis (`Bash`, `PowerShell`, `Write`, `Edit`, ...) tanpa membedakan huruf besar kecil, atau `*` untuk semua alat |
| `commands` | Hanya untuk shell. Tiap pola dicocokkan dengan **satu** perintah. Kata-kata dipisah spasi. `*` sebagai kata **terakhir** berarti "dan argumen apa saja" (`git diff *`); tanpa `*`, harus persis (`npm test`) |
| `paths` | Hanya untuk alat berkas (tulis **dan** baca: Read, Glob, Grep, LS; pola Glob/Grep ikut diperiksa). Pola relatif terhadap proyek, memakai `/`: `*` (dalam satu folder), `**` (lintas folder), `?`. Paling banyak 4 wildcard per pola, 2 di antaranya `**` (mencegah pencocokan yang mahal) |
| `note` | Catatan bebas untuk Anda |

Tanpa `commands` atau `paths`, aturan berlaku untuk semua pemakaian alat itu. `commands` dan `paths` tidak boleh dalam satu aturan. Pola perintah **tidak boleh memuat karakter shell** (`; & | < > $ \` ( ) \`): rantai tidak ditulis di aturan, dan tiap bagian rantai dicocokkan sendiri.

**Aturan izinkan mencocokkan persis** (huruf besar kecil dibedakan: `NPM test` tidak cocok dengan `npm test`). **Aturan tolak dan tanya mencocokkan longgar** supaya tidak mudah dilewati: tanpa membedakan huruf, tanpa folder dan `.exe` (`/usr/bin/rm`, `rm.exe`), dan setelah membuka pembungkus (`env`, `command`, `sudo`, `time`, `nohup`, awalan `VAR=...`) serta nama pendek PowerShell (`ri`, `del` untuk `Remove-Item`). Tetap saja daftar tolak adalah **daftar hitam yang lemah**: andalkan batas risiko dan default tanya, bukan daftar tolak, untuk keselamatan.

## Delapan aturan keselamatan dan penegakannya
| # | Aturan | Di kode |
|---|---|---|
| 1 | **Batas keras.** Risiko tinggi tidak pernah `allow`, apa pun aturannya (termasuk "izinkan semua"). Diuji terhadap seluruh korpus berbahaya penilai risiko (250+ kasus). Aturan tolak tetap bisa menolaknya | `evaluate.ts`, sebelum aturan izinkan dibaca |
| 2 | **Default ketat.** Tanpa aturan izinkan yang cocok: tanya. Risiko rendah saja tidak cukup | hasil bawaan |
| 3 | **Ragu berarti tanya.** Pipa, spasi/pemisah Unicode tak lazim, rantai (`&&` `;` `\|\|` `&` baris baru), pipa, substitusi, subshell, redirect ke berkas, heredoc, variabel (`$X`), ekspansi `{a,b}`, scriptblock PowerShell `{ }`, `\r` yang berdiri sendiri, awalan variabel lingkungan, kutip tidak tertutup: **setiap bagian harus diizinkan**, dan yang tidak bisa dianalisis tidak pernah `allow`. Hanya `> /dev/null` (di bash) dan `2>&1` yang dianggap tidak berefek. Aturan tolak dan tanya melihat sampai ke dalam substitusi | `shellParts` di `evaluate.ts`, dan `risk/shell.ts` |
| 4 | **Celah skrip.** Bila agent sudah mengubah proyek di sesi ini (`scriptsChanged`), aturan izinkan untuk perintah shell yang **menjalankan kode proyek** (risiko bukan rendah, mis. `npm test`) ditangguhkan. Perintah baca-saja yang dikenali (`git status`, `ls`) tetap berjalan. Penyambung (#037) yang mengisinya: lihat bagian "Tersambung ke hook" | `PolicyContext.scriptsChanged` |
| 5 | **Repo tidak dipercaya.** `<proyek>/.agentmon/policy.json` hanya boleh memperketat: aturan `allow` darinya dibuang dan pengguna diberi tahu; id aturan `deny`/`ask`-nya diberi awalan `repo:` | `loadPolicy` di `config.ts` |
| 6 | **Aturan agent tetap berlaku.** `agentRule` `deny`/`ask` tidak pernah dilonggarkan | `PolicyContext.agentRule` |
| 7 | **Bisa diaudit.** Setiap hasil membawa `ruleId` (aturan penyebab) dan `matched` (semua aturan yang terlibat). Pencatatan ke timeline dikerjakan #037 | `PolicyDecision` |
| 8 | **Dievaluasi di laptop.** Fungsi murni tanpa jaringan; relay tidak punya jalan masuk. Mengubah aturan dari HP butuh keputusan bertanda tangan (#034, #038) | seluruh modul |

## Berkas rusak (FR-82)
Berkas pengguna yang **kosong, bukan JSON, berisi kolom tak dikenal, versi asing, id ganda, pola tidak sah, lebih dari 200 aturan, atau lebih besar dari 256 KiB** ditolak **seluruhnya**: tidak ada aturan setengah berlaku, dan tidak ada aturan izinkan sama sekali. Berkas yang ada tetapi tidak terbaca juga dianggap rusak (bukan "tidak ada"). Pengguna diberi tahu lewat `PolicyLoad.problems`; `agentmon policy test` mencetaknya sebagai `PERINGATAN`, dan penyambung hook (#037) harus menampilkannya juga.

## Perintah
```bash
# Menguji tanpa menjalankan apa pun
pnpm --filter @agentmon/bridge cli policy test "npm test && curl evil.test"
pnpm --filter @agentmon/bridge cli policy test --tool Write --file src/a.ts
pnpm --filter @agentmon/bridge cli policy test "npm test" --scripts-changed

# Preset contoh (hanya MENCETAK; tidak ada yang aktif sampai Anda menyimpannya sendiri)
pnpm --filter @agentmon/bridge cli policy preset
pnpm --filter @agentmon/bridge cli policy preset baca-saja
```
`policy test` mencetak hasil, aturan penyebab, alasan, dan risiko, lalu menegaskan bahwa perintah **tidak dijalankan**. Cwd bawaannya folder saat ini (untuk membaca aturan proyek dan menilai jalur).

Preset (**hanya contoh**; gabungan beberapa preset menambah izin, jadi baca isinya): `baca-saja` (git status/diff/log, ls, pwd), `tes-dan-lint` (npm/pnpm test, lint, typecheck), `edit-di-proyek` (ubah berkas di `src/` dan `docs/`).

## Tersambung ke hook
Penangan hook Claude Code (`adapters/claude-code-handler.ts`) bertanya ke policy lewat `policy/runtime.ts` untuk setiap aksi yang memenuhi **semua** syarat ini; bila salah satu tidak terpenuhi, alur izin normal yang berjalan (tanya HP, atau terminal).

| Syarat | Alasan |
|---|---|
| Hook **`PreToolUse`** untuk `Bash`, `PowerShell`, atau alat pengubah berkas (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) | Dokumentasi resmi Claude Code menyatakan keputusan `allow` dari hook PreToolUse **tidak menimpa aturan deny atau ask milik pengguna**: aturan deny tetap memblokir dan aturan ask tetap bertanya (*Permissions › Extend permissions with hooks › Precedence among rules, hooks, and mods*). `PermissionRequest` **sengaja tidak dipakai**: hook itu juga muncul karena aturan ask, inputnya tidak memberi tahu sebabnya, dan `allow` di sana bisa menimpa aturan ask milik pengguna |
| **Penahanan aksi menyala** (`AGENTMON_HOLD=1` atau `autostart install --hold`) dan **tidak dijeda** | Pengguna yang memilih AgentMon ikut menentukan. `pause` berarti AgentMon tidak ikut campur sama sekali |
| Mode izin agent **`default` atau `acceptEdits`** (atau tidak disebut) | `bypassPermissions`: hanya dipantau (PRD §18). `plan`, `auto`, `dontAsk` dan mode yang belum dikenal punya aturan sendiri; AgentMon tidak ikut memutuskan |
| Untuk **izinkan** pada alat pengubah berkas: **checkpoint sudah berhasil dibuat** | Auto-approve tidak boleh tanpa jaring pengaman (Pilar 3). Checkpoint gagal, atau mustahil (folder bukan repo git), berarti ditanyakan seperti biasa dan dicatat di log. Bila pengguna mematikan checkpoint (`AGENTMON_CHECKPOINT=0`), itu pilihan sadar dan edit tetap boleh otomatis |

**Hasil keputusan:**
- **Izinkan** → jawaban `allow` di `PreToolUse`, event `approval.auto_resolved` (`auto_approved`, dengan aturan penyebab), **tanpa kartu, tanpa `approval.requested`, dan karena itu tanpa notifikasi push** (relay hanya memicu push dari `approval.requested`). Di timeline HP tampil berbeda dari izin yang diputuskan manusia.
- **Tolak** → jawaban `deny` dengan alasan yang dibaca agent (aturan penyebab, catatan `note` dari aturan Anda yang sudah dibersihkan dari karakter kontrol, dan permintaan untuk tidak menyiasatinya), event `auto_denied`.
- **Tanya** → tidak ada keputusan di sini; alur normal berjalan (aksi berkas ditahan di `PreToolUse`, perintah shell di `PermissionRequest`).

**Rekap sesi** (`session.recap`) kini mengisi `autoApproved`, dan penolakan otomatis ikut dihitung di `rejected`.

**Celah skrip (`scriptsChanged`).** Daemon mencatat per sesi apakah agent sudah **mengubah proyek**: setiap alat pengubah berkas, dan perintah shell yang menurut penilai mengubah sesuatu (selain sekadar menjalankan kode proyek atau jaringan). Setelah itu aturan izinkan untuk perintah yang menjalankan kode proyek (`npm test`) **ditangguhkan** di sesi itu; perintah baca-saja (`git status`) tetap otomatis. Jadi agent tidak bisa mengedit berkas tes lalu menjalankannya tanpa Anda tahu. Menjalankan tes berkali-kali tanpa mengubah apa pun tetap otomatis. Sesi lain tidak terpengaruh.

**Gagal berarti alur normal.** Galat di policy, berkas aturan rusak, atau policy yang melempar galat tidak pernah menjadi "izinkan": tanpa keputusan, dicatat di log **sekali per masalah** (`aturan otomatis: ...`), dan tampil di `status`. Daemon mati berarti hook gagal dan Claude Code berjalan seperti biasa. Aturan dibaca ulang di setiap permintaan, jadi perubahan `policy.json` langsung berlaku.

**Perintah `status`** menampilkan jumlah aturan atau peringatan berkas bermasalah.

### Pengukuran: jumlah permintaan ke HP pada skenario yang sama
Skenario tetap (diuji otomatis di `adapters/claude-code-policy.test.ts`): satu sesi dengan 20 aksi, yaitu membaca (`git status`, `git diff`, `ls`, `git log`), tes dan lint (`npm test` x3, `pnpm lint`), tiga edit di `src/` dan `docs/`, lalu aksi berisiko (`package.json`, `.env`, `npm install`, `rm -rf`, `git push`, `curl | sh`) dan satu `npm test` setelah edit.

| | Permintaan ke HP |
|---|---|
| Tanpa policy | **20** (semua) |
| Dengan tiga preset (`baca-saja`, `tes-dan-lint`, `edit-di-proyek`) | **8** (turun 60%) |

Yang tetap naik ke HP: keenam aksi berisiko, dan dua `npm test` yang dijalankan **setelah** agent mengedit berkas (celah skrip). Dua belas aksi lainnya diputuskan otomatis dan tercatat.

## Batas yang perlu diketahui
- **Keputusan otomatis bergantung pada perilaku Claude Code yang terdokumentasi** (PreToolUse `allow` tidak menimpa aturan deny/ask). Itu dari dokumentasi resmi, bukan dari uji pada versi Claude Code Anda; versi yang lebih lama bisa berbeda. Bila Anda memakai aturan deny atau ask di pengaturan Claude Code, coba satu kali dengan perintah yang kena aturannya untuk memastikan.
- **Mengubah aturan dari HP** (#038) butuh keputusan bertanda tangan (#034, belum ada); sampai itu, aturan hanya diubah di laptop.
- **Pola `*` mempercayai kata biasa.** `cat *` mengizinkan `cat src/a.ts`. Perintah yang menulis ke argumen posisional di luar daftar yang dilarang (di atas) tetap bisa lolos lewat `*`; jangan beri `*` pada perintah yang tidak Anda pahami argumennya.
- **Kerahasiaan bacaan lewat `*` bergantung pada daftar nama berkas rahasia milik penilai** (`.env`, `*.pem`, `.dev.vars`, `local.settings.json`, ...). Berkas rahasia bernama tak lazim (`passwords.txt`, `notes-prod.md`) **bisa terbaca otomatis** oleh `cat *`, `Get-Content *`, atau alat Read. Untuk perintah yang membaca isi, lebih aman memakai pola persis atau aturan `paths` yang menyebut folder tertentu. Revisi git (`HEAD~1`, sha, `main~2`) untuk `git show/diff/grep/cat-file/blame` tidak lewat `*` karena riwayat bisa memuat rahasia yang pernah di-commit; tulis pola persis bila perlu. Nama cabang polos (`git diff main`) tidak terdeteksi.
- **Tautan simbolik dan junction** diselesaikan (realpath) secara bawaan oleh mesin ini, jadi `src/lnk/x` yang menunjuk ke luar proyek ditanyakan. Penyambung (#037) dan CLI memakai bawaan itu; jangan menimpanya dengan fungsi yang tidak menyelesaikan tautan.
- **Pencarian folder** (Grep, Glob, LS) hanya diizinkan aturan yang menyebut `paths` (folder yang Anda pilih), karena isinya dibaca rekursif. `Grep.pattern` adalah regex isi, bukan jalur, dan tidak dicocokkan dengan aturan jalur.
- **Mengubah berkas lalu menjalankannya.** `edit-di-proyek` + `tes-dan-lint` digabung berarti agent boleh mengubah berkas tes dan kode lalu menjalankan `npm test` tanpa bertanya: itu **setara menjalankan kode bebas**. Daftar berkas skrip/build yang dikenali penilai (`package.json`, `vitest.config.*`, `Makefile`, `*.sh`, folder `scripts/`, ...) hanya menangkap sebagian; berkas tes dan kode biasa tidak ditandai. Penyambung (#037) sebaiknya menganggap `scriptsChanged` benar bila ADA tulisan apa pun ke proyek sejak awal sesi sebelum perintah yang menjalankan kode proyek. Jangan pakai kedua preset itu bersamaan kecuali Anda memahaminya.
- **Penilai risiko masih bocor di beberapa tempat** dan itu dicatat di issue terpisah (bukan dijadikan sandaran keselamatan di sini). Contoh yang terbukti di review: `sed 's|^|cmd|e'` dinilai rendah, `awk -f`, `git grep --open`, `sort -o`, `date -f`, `grep -d recurse`, pembacaan rekursif PowerShell lewat pipa, `cd` tanpa argumen. Karena lapisan di atas, semua itu ditanyakan oleh mesin kebijakan, tetapi **tampilan level risiko di HP bisa "rendah" untuk perintah semacam itu**: level hanyalah bantuan membaca.
- **Tiga putaran review keamanan (Opus)** menemukan serangan nyata dan semuanya jadi tes regresi (`\r` PowerShell, `$'..'`, kutip pintar, scriptblock, `{a,b}`, spasi Unicode, koma/array, drive `env:`, preset yang menulis `package.json`, "izinkan semua" yang meloloskan docker/publish, argumen `npm test` yang memuat program). Ini bukan jaminan tidak ada celah lain. Aturan izinkan menambah permukaan serangan: mulai dari preset kecil.
- **Berkas aturan dari proyek adalah masukan penyerang.** Dibaca tanpa mengikuti symlink, dibatasi 256 KiB, dan teks galatnya dibersihkan dari karakter kontrol sebelum dicetak.
- **Aturan tolak berdasarkan `paths` tidak berlaku untuk perintah shell** (`cat dir/a.txt`); itu hanya untuk alat berkas. Daftar tolak perintah juga mudah dilewati (`bash -c 'rm x'`, `cmd /c del`, `Remove-ItemProperty`): andalkan default tanya.
- **WebFetch, MCP, Task** tidak pernah di-allow (penilai memberi sedang). **Glob/Grep/LS tanpa `path`** tidak cocok dengan aturan `paths`.
- **Lexer PowerShell tidak persis sama dengan PowerShell** untuk escape backtick (`` a`tb `` menjadi tab di PowerShell). Perbedaannya selalu membuat argumen lebih literal, dan tidak ada cara ditemukan untuk memanfaatkannya agar `npm test` atau `git status` menjalankan hal lain, tetapi ini dicatat.
- **Penilai dan mesin memakai kunci jalur yang sama** (`filePathOf`); alat berkas dengan dua kunci jalur yang berbeda dianggap tidak sah.
- **`npm test` menjalankan kode proyek**, dan agent bisa mengubah skripnya lebih dulu. Itulah celah skrip (aturan 4); perlindungannya bergantung pada penyambung mengisi `scriptsChanged` dengan benar (#037).
- **Alat selain shell dan berkas** (WebFetch, MCP, ...) hanya cocok dengan aturan tanpa `commands`/`paths`, dan hanya bila masukannya objek yang sah. Penilai memberi alat yang tidak dikenal paling rendah "sedang".
- Aturan memakai nama alat apa adanya dari agent; aturan untuk Codex baru relevan setelah tahap 7.
