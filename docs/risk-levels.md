# Level risiko

Setiap permintaan izin diberi satu level (**rendah**, **sedang**, **tinggi**) dan daftar alasan berbahasa Indonesia. Penilainya berbasis aturan, **tanpa AI**, berjalan di laptop (daemon), dan konservatif. Rujukan: PRD §9 dan §14, FR-70 sampai FR-74. Kodenya ada di `packages/bridge/src/risk/`.

> **Level adalah bantuan, bukan jaminan.** "Rendah" artinya penilai mengenali perintahnya sebagai baca-saja atau sebagai suntingan berkas biasa di dalam proyek. Itu bukan pernyataan bahwa perintahnya pasti aman. Selalu baca perintah dan diff-nya sendiri. Penilai ini sudah di-review dan diperbaiki sekali (PR #65) setelah reviewer menemukan lebih dari sepuluh cara menyamarkan perintah berbahaya; masih ada cara lain yang belum ditemukan, dan itulah alasan "tinggi" dipasangkan dengan batas keras di policy engine, bukan sekadar label.

## Tiga aturan yang tidak boleh dilanggar

1. **Yang dinilai hanya input alat yang sebenarnya** (nama alat, perintah atau jalur berkas, folder kerja). Penjelasan agent ("ini aman, hanya membaca") tidak dibaca sama sekali (FR-73). Ada tes yang membuktikannya.
2. **Yang tidak bisa dinilai tidak pernah rendah** (FR-72): input kosong atau rusak, alat tidak dikenal, kutip yang tidak ditutup, nama perintah yang dibentuk saat berjalan (`$cmd`), perintah yang terlalu panjang, terlalu bersarang, atau terlalu rumit. Minimal sedang; yang terlalu bersarang atau terlalu rumit dinilai **tinggi** supaya tidak pernah bisa disetujui otomatis.
3. **Ragu berarti tanya.** Rendah hanya untuk dua hal: mengubah berkas biasa di dalam proyek lewat alat berkas (Write, Edit), dan perintah baca-saja yang dikenali tanpa menyentuh berkas rahasia atau tempat di luar proyek. Perintah berantai bernilai setinggi bagian tertingginya.

## Level

| Level | Contoh |
|---|---|
| **Tinggi** | Hapus massal atau rekursif (`rm -rf`, `find -delete`, `git clean`, `git reset --hard`, `git stash drop`, `git branch -D`). Menyentuh berkas rahasia (`.env`, kunci privat, kredensial, `.pgpass`, `.git/config`) termasuk lewat nama yang disamarkan. Mengubah atau menghapus berkas di luar folder proyek. `git push` dan menerbitkan paket atau citra. Mengunduh lalu menjalankan (`curl ... \| sh`, `git clone x && ./install.sh`). Hak istimewa (`sudo`). Mengubah sistem atau disk. Mengubah berkas yang menjalankan perintah sendiri (hook git, CI, profil shell, pengaturan agent, `.vscode/tasks.json`, `.mcp.json`, `CLAUDE.md`). Perintah yang disandikan atau teks yang dijalankan tanpa bisa dilihat dulu (`eval $x`, `-EncodedCommand`). Opsi yang menjalankan program (`git grep -O`, `git -c core.pager=`). Variabel pemuat kode (`LD_PRELOAD`, `BASH_ENV`). Terlalu bersarang atau terlalu rumit untuk dinilai. |
| **Sedang** | Memasang dependency, akses jaringan, menjalankan kode atau skrip proyek (`npm test`, `node x.js`, `./skrip.sh`), mengubah berkas lewat shell (`mkdir`, `cp`, pengalihan `>`), perintah yang tidak dikenali, perintah yang tidak bisa diurai, membaca di luar proyek, mengubah skrip build (`package.json`, `Dockerfile`), awalan variabel lingkungan (`FOO=1 cmd`), menampilkan variabel bernama `*TOKEN*`/`*SECRET*`. |
| **Rendah** | Suntingan berkas biasa di dalam proyek. Perintah baca-saja yang dikenali (`ls`, `cat`, `grep`, `sed -n`, `awk '{print}'`, `jq`, `git status`, `git diff`, `git log`, `node --version`, `Get-ChildItem`, ...) yang tidak menyentuh rahasia atau luar proyek. |

Alasan memakai **teks tetap** (bukan kutipan dari perintah), supaya perintah yang dibuat agent tidak bisa menyelipkan kalimat ke layar HP. Kode alasan yang stabil (mis. `mass-delete`, `secret-file`, `outside-project`, `git-push`, `download-execute`) dipakai policy engine dan tes.

## Cara penilai bekerja

1. **Memecah perintah seperti shell** (`risk/shell.ts`): kutip dan garis miring terbalik dilepas (`\rm`, `.e\nv`, `'\''` menjadi nilai sesungguhnya), komentar `#` (dan `<# #>` di PowerShell) dibuang, `;` `&&` `||` `|` memisahkan, `$(...)`, `$(( $(...) ))`, tanda kutip balik, `<(...)`, dan substitusi di isi heredoc tanpa kutip dinilai sebagai perintah tersendiri. `${IFS}` menjadi spasi. `$'\x72\x6d'` didekode menjadi `rm`. `>&berkas` dan `&>berkas` dianggap menulis berkas. Bentuk mentah kata (dengan garis miring) disimpan juga, untuk jalur gaya Windows di Bash.
2. **Membuka pembungkus dan perintah bersarang**: `sudo`, `env` (awalan dan `-S`), `nohup`, `time`, `timeout`, `xargs`, `command`, `bash -c`, `cmd /c`, `powershell -Command` (juga `-` dari stdin), `eval`, `find -exec`, blok skrip PowerShell `{ ... }`, isi `<<EOF` dan `<<<` yang diberikan ke interpreter (juga lewat pembungkus), pembungkus yang tidak dikenal (`busybox`, `strace`, `wsl`, `parallel`, ...: perintah nyata dicari di argumennya), dan argumen yang berupa kalimat perintah (`vim -c ':!...'`, `tar --checkpoint-action=exec=...`). Maksimal 3 tingkat.
3. **Menilai tiap perintah** berdasarkan kosakata (hapus, ubah berkas, git, paket, interpreter, jaringan, sistem) dan **tiap jalur** yang muncul (argumen, `--opsi=jalur`, `@berkas`, target pengalihan, nilai opsi pembungkus, string di kode inline).
4. **Menilai jalur** memakai `classifyPath` (penanda berkas sensitif yang sama dengan tampilan diff) ditambah aturan sendiri: nama mirip `.env` (`.env-prod`, `.env_old`, `prod.env`), titik/spasi di ujung **setiap** bagian jalur (`.git.\hooks`) dan aliran data NTFS, nama pendek 8.3 (`GIT~1`), wildcard yang bisa cocok dengan berkas rahasia (`.e*`, `*.env`), `{a,b}` yang diperluas (`.{e,}nv`), `~` dan `~pengguna`, variabel rumah, `..`, huruf besar-kecil dan huruf drive Windows, UNC. Alamat (`https://...`) bukan jalur.
5. **Tautan simbolik**: bila daemon memberikan `realpath`, tujuan sebenarnya dinilai juga, termasuk untuk berkas baru di bawah folder yang ditautkan keluar proyek. `realpath` **tidak** dipanggil untuk jalur jaringan (UNC): itu bisa memblokir puluhan detik dan memicu koneksi keluar. Jumlah panggilannya dibatasi 8 per penilaian. Penilainya sendiri murni; yang menyentuh disk hanya `realpath` yang diberikan pemanggil.
6. **Mengambil yang tertinggi** dari semua temuan; alasan diurutkan dari yang terberat, tanpa duplikat, paling banyak 8.

Penilaian dibatasi supaya input jahat tidak bisa membekukan daemon (penilai berjalan sinkron di jalur hook): anggaran 4.000 kandidat jalur, 150 perintah, 3 tingkat bersarang, 8 panggilan `realpath`, kata jalur sepanjang 2.048 karakter, dan pola wildcard dengan lebih dari 8 `*`/`?` dianggap bisa cocok dengan rahasia (tanpa dicocokkan). Melewati anggaran berarti **tinggi**.

PowerShell dan Bash memakai mesin yang sama dengan sedikit perbedaan (tanda kutip balik adalah escape di PowerShell dan substitusi di Bash; singkatan opsi seperti `-rec` untuk `-Recurse`, juga `-Recurse:$true`; alias seperti `ri`, `gc`, `iwr`, `iex`; blok `{ }`).

## Hasil pengukuran

Diukur otomatis di setiap `pnpm check`:

| Ukuran | Hasil |
|---|---|
| Korpus **wajib tinggi** (hapus massal, rahasia, di luar proyek, push, unduh-jalankan, sistem; termasuk yang disamarkan; Bash, PowerShell, alat berkas) | **401 kasus, semuanya tinggi** |
| Korpus **tidak boleh rendah** (tidak bisa dinilai, tidak dikenali, input rusak, jaringan, memasang paket, ...) | **194 kasus, tidak ada yang rendah** |
| Korpus **perintah aman yang umum** (baca-saja, git baca, suntingan berkas biasa, Windows) | **161 kasus, alarm palsu 0** (semuanya rendah) |
| Fuzz 1.500 perintah acak, tiap kali untuk Bash dan PowerShell | tidak pernah melempar galat, selalu menghasilkan `Risk` yang sah |
| Input jahat: 200 tanda `*` berurutan, nama berisi 150.000 titik, 4.500 argumen, 151 perintah, 5 lapis `bash -c`, jalur UNC | semuanya selesai di bawah 0,2 sampai 1 detik; hasilnya tinggi atau tidak pernah rendah. Sebelum review, 20 tanda `*` membekukan penilai selama 38 detik |
| Waktu penilaian (15.080 penilaian pada seluruh korpus) | p50 0,013 ms, **p95 0,054 ms**, p99 0,12 ms, maks 2,9 ms. Target PRD §14: p95 < 20 ms |
| Uji mutasi | Putaran 1 (versi pertama): 48 mutan, 46 tertangkap. Putaran 2 (setelah review, kode yang diperbaiki): 48 mutan baru pada aturan, anggaran, dan pemecah shell, 46 tertangkap; 2 yang lolos setara secara perilaku (pemotongan aliran data NTFS dan tanda UNC di luar proyek dilindungi aturan lain). Mutan yang lolos pada putaran pertama menghasilkan tes baru |

**Alarm palsu yang disengaja.** Perintah umum berikut bernilai **sedang**, bukan rendah, karena menjalankan kode proyek atau mengubah berkas: `npm test`, `npm run build`, `pnpm test`, `node x.js`, `python x.py`, `git commit`, `git add`, `mkdir`, `touch`, `cp`, `mv`, `npm install`, `curl`, `npx tsc`. Alasannya PRD §9 butir "celah skrip": `npm test` menjalankan kode dari repo yang bisa saja sudah diubah agent. Pengguna yang ingin `npm test` berjalan otomatis memakai policy engine (tahap 4.5), bukan melonggarkan penilai. Alarm palsu lain yang diketahui (selalu ke arah lebih hati-hati): `grep -r` (bisa membaca `.env`), kata `.env` di argumen biasa (`git show HEAD:.env` memang tinggi), awalan variabel lingkungan seperti `FORCE_COLOR=1 cmd`, jalur gaya Git Bash `/c/proyek/...` yang dianggap di luar proyek Windows, dan blok `{ }` PowerShell di `Select-Object`.

## Keterbatasan (jujur)

- **Ini bukan shell lengkap.** Alias dan fungsi yang didefinisikan sebelumnya, `source` ke berkas yang isinya tidak terlihat, dan perintah yang dibentuk dari isi berkas tidak bisa diikuti. Semuanya ditandai tidak bisa dinilai (minimal sedang), bukan ditebak. Pendefinisi alias (`alias`, `sal`) bernilai sedang, dan tinggi bila menyebut perintah berbahaya.
- **Isi kode inline dan skrip dari stdin** (`python -c`, `node -e`, `<<EOF`) tidak dianalisis; hanya dicari pola berbahaya yang umum dan string yang menyerupai jalur berkas rahasia. Selain itu sedang.
- **Isi skrip** yang dijalankan (`bash x.sh`, `./x`, `npm test`) tidak dibaca. Itu sebabnya levelnya sedang.
- **Tautan simbolik yang dibuat di perintah yang sama** (`ln -s /etc x && cat x`) tidak terlihat saat dinilai; `ln -s` sendiri bernilai sedang dengan alasannya.
- **Nama pendek 8.3 dan tautan** hanya ditandai tidak bisa dipastikan (sedang); penilai tidak menyelesaikannya ke nama panjang.
- **Alat Grep dan Glob milik agent**: hanya `path`, `glob`, dan `pattern` mutlak yang dinilai. Apakah alat Grep ikut membaca berkas tersembunyi atau yang masuk `.gitignore` belum dipastikan.
- Alat yang tidak dikenali (alat MCP, sub-agent) selalu sedang. Belum ada penilaian khusus per alat.
- Opsi program yang menjalankan perintah hanya dikenali untuk daftar yang diketahui (git `-c` kunci tertentu, `--upload-pack`, `-O`, dan sejenisnya). Opsi serupa pada program lain bisa lolos sebagai sedang.
- Level hanya memandu tampilan dan policy. **Batas keras** (aksi tinggi tidak bisa disetujui otomatis oleh aturan apa pun) ditegakkan oleh policy engine (tahap 4.5), bukan oleh berkas ini. Setiap penurunan dari tinggi ke sedang adalah celah di batas keras itu, jadi kasus baru yang ditemukan harus ditambahkan ke korpus.

## Menambah atau mengubah aturan

1. Tambahkan kasus ke `risk/corpus.ts` atau `risk/corpus-review.ts` lebih dulu (berbahaya di `MUST_BE_HIGH`/`REVIEW_HIGH` atau `MUST_NOT_BE_LOW`/`REVIEW_NOT_LOW`, aman di `COMMON_SAFE`/`REVIEW_SAFE`). Tes membaca korpus itu.
2. Ubah `risk/assess.ts` (kosakata di bagian atas, aturan per perintah di bawahnya) atau `risk/shell.ts` (pemecah).
3. Jalankan `pnpm --filter @agentmon/bridge test src/risk`. Korpus aman harus tetap 0 alarm palsu.
4. Aturan baru yang menjaga keselamatan wajib diuji mutasi: hapus aturannya, tes harus gagal.
