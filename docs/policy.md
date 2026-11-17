# Policy engine

Mesin aturan di laptop yang memutuskan satu permintaan izin: **izinkan otomatis**, **tanya** (naik ke HP), atau **tolak otomatis**. Kodenya di `packages/bridge/src/policy/`. Rujukan: PRD §9 (delapan aturan keselamatan), FR-80 sampai FR-84.

> **Belum tersambung ke hook.** Issue ini hanya membuat mesinnya dan perintah untuk mengujinya. Penyambungan ke alur izin ada di issue #037, dan tampilannya di HP di #038. Sampai itu, tidak ada aksi yang diizinkan otomatis oleh mesin ini.

## Tiga hasil
| Hasil | Arti |
|---|---|
| `allow` | Jalan tanpa bertanya. Hanya bila **setiap bagian** permintaan diizinkan aturan milik **pengguna**, penilai risiko menilainya **rendah** (atau sedang yang satu-satunya alasannya "menjalankan kode proyek", seperti `npm test`), dan tidak ada alasan ragu |
| `ask` | Naik ke HP. **Ini bawaan.** Semua keraguan berujung di sini |
| `deny` | Ditolak otomatis oleh aturan tolak |

Urutan keputusan: **tolak > tanya > batas risiko > aturan izinkan > bawaan (tanya)**. Urutan penulisan aturan tidak memengaruhi hasil.

**Risiko sedang selain "menjalankan kode proyek" tidak pernah di-allow**, termasuk oleh aturan "izinkan semua": perintah tidak dikenal, tidak bisa diurai, mengubah berkas lewat shell (`git log --output=...`), menjalankan perintah di dalam perintah (`find -exec`, `xargs`, `env`, `time`), kode inline, atau di luar proyek. Penilai berkata "tidak yakin", dan ragu berarti tanya.

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
| 3 | **Ragu berarti tanya.** Rantai (`&&` `;` `\|\|` `&` baris baru), pipa, substitusi, subshell, redirect ke berkas, heredoc, variabel (`$X`), ekspansi `{a,b}`, scriptblock PowerShell `{ }`, `\r` yang berdiri sendiri, awalan variabel lingkungan, kutip tidak tertutup: **setiap bagian harus diizinkan**, dan yang tidak bisa dianalisis tidak pernah `allow`. Hanya `> /dev/null` (di bash) dan `2>&1` yang dianggap tidak berefek. Aturan tolak dan tanya melihat sampai ke dalam substitusi | `shellParts` di `evaluate.ts`, dan `risk/shell.ts` |
| 4 | **Celah skrip.** Bila `package.json`, Makefile, atau konfigurasi sejenis berubah di sesi ini, aturan izinkan untuk **shell** ditangguhkan (`scriptsChanged`). Penyambung (#037) yang mengisinya | `PolicyContext.scriptsChanged` |
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

## Batas yang perlu diketahui
- **Pola `*` mempercayai semua argumen.** `sed *`, `awk *`, `find *`, atau `rg *` mengizinkan argumen yang bisa menjalankan perintah. Penilai menangkap sebagian besar (hasilnya sedang, sehingga tetap ditanyakan) tetapi **tidak ada jaminan**. Untuk perintah yang bisa menjalankan program lain, tulis pola persis atau jangan buat aturan izinkan.
- **Ulasan keamanan (Opus) menemukan celah nyata di versi pertama** (`\r` di PowerShell, `$'..'`, kutip pintar, scriptblock, ekspansi `{a,b}`, preset yang bisa menulis `package.json` lewat `git log --output`). Semuanya sudah diperbaiki dan jadi tes regresi; ini bukan jaminan tidak ada celah lain. Aturan izinkan menambah permukaan serangan: mulai dari preset kecil.
- **Penilai dan mesin memakai kunci jalur yang sama** (`filePathOf`); alat berkas dengan dua kunci jalur yang berbeda dianggap tidak sah.
- **`npm test` menjalankan kode proyek**, dan agent bisa mengubah skripnya lebih dulu. Itulah celah skrip (aturan 4); perlindungannya bergantung pada penyambung mengisi `scriptsChanged` dengan benar (#037).
- **Alat selain shell dan berkas** (WebFetch, MCP, ...) hanya cocok dengan aturan tanpa `commands`/`paths`, dan hanya bila masukannya objek yang sah. Penilai memberi alat yang tidak dikenal paling rendah "sedang".
- Aturan memakai nama alat apa adanya dari agent; aturan untuk Codex baru relevan setelah tahap 7.
