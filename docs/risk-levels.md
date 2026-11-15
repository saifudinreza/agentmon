# Level risiko

Setiap permintaan izin diberi satu level (**rendah**, **sedang**, **tinggi**) dan daftar alasan berbahasa Indonesia. Penilainya berbasis aturan, **tanpa AI**, berjalan di laptop (daemon), dan konservatif. Rujukan: PRD §9 dan §14, FR-70 sampai FR-74. Kodenya ada di `packages/bridge/src/risk/`.

> **Level adalah bantuan, bukan jaminan.** "Rendah" artinya penilai mengenali perintahnya sebagai baca-saja atau sebagai suntingan berkas biasa di dalam proyek. Itu bukan pernyataan bahwa perintahnya pasti aman. Selalu baca perintah dan diff-nya sendiri.

## Tiga aturan yang tidak boleh dilanggar

1. **Yang dinilai hanya input alat yang sebenarnya** (nama alat, perintah atau jalur berkas, folder kerja). Penjelasan agent ("ini aman, hanya membaca") tidak dibaca sama sekali (FR-73). Ada tes yang membuktikannya.
2. **Yang tidak bisa dinilai tidak pernah rendah** (FR-72): input kosong atau rusak, alat tidak dikenal, kutip yang tidak ditutup, nama perintah yang dibentuk saat berjalan (`$cmd`), perintah yang terlalu panjang atau terlalu bersarang. Minimal sedang, dan bahaya yang terlihat tetap tinggi.
3. **Ragu berarti tanya.** Rendah hanya untuk dua hal: mengubah berkas biasa di dalam proyek lewat alat berkas (Write, Edit), dan perintah baca-saja yang dikenali tanpa menyentuh berkas rahasia atau tempat di luar proyek. Perintah berantai bernilai setinggi bagian tertingginya.

## Level

| Level | Contoh |
|---|---|
| **Tinggi** | Hapus massal atau rekursif (`rm -rf`, `find -delete`, `git clean`, `git reset --hard`). Menyentuh berkas rahasia (`.env`, kunci privat, kredensial) termasuk lewat nama yang disamarkan. Mengubah atau menghapus berkas di luar folder proyek. `git push` dan menerbitkan paket atau citra. Mengunduh lalu menjalankan (`curl ... \| sh`). Hak istimewa (`sudo`). Mengubah sistem atau disk. Mengubah berkas yang menjalankan perintah sendiri (hook git, CI, profil shell, pengaturan agent). Perintah yang disandikan atau teks yang dijalankan tanpa bisa dilihat dulu (`eval $x`, `-EncodedCommand`). |
| **Sedang** | Memasang dependency, akses jaringan, menjalankan kode atau skrip proyek (`npm test`, `node x.js`), mengubah berkas lewat shell (`mkdir`, `cp`, pengalihan `>`), perintah yang tidak dikenali, perintah yang tidak bisa diurai, membaca di luar proyek, mengubah skrip build (`package.json`, `Dockerfile`). |
| **Rendah** | Suntingan berkas biasa di dalam proyek. Perintah baca-saja yang dikenali (`ls`, `cat`, `grep`, `git status`, `git diff`, `git log`, `Get-ChildItem`, ...) yang tidak menyentuh rahasia atau luar proyek. |

Alasan memakai **teks tetap** (bukan kutipan dari perintah), supaya perintah yang dibuat agent tidak bisa menyelipkan kalimat ke layar HP. Kode alasan yang stabil (mis. `mass-delete`, `secret-file`, `outside-project`, `git-push`, `download-execute`) dipakai policy engine dan tes.

## Cara penilai bekerja

1. **Memecah perintah seperti shell** (`risk/shell.ts`): kutip dan garis miring terbalik dilepas, `;` `&&` `||` `|` memisahkan, `$(...)`, tanda kutip balik, dan `<(...)` dinilai sebagai perintah tersendiri. `${IFS}` menjadi spasi. `$'\x72\x6d'` didekode menjadi `rm`. Isi `<<EOF` yang diberikan ke interpreter ikut dinilai. Perintah di dalam `bash -c`, `cmd /c`, `powershell -Command`, `eval`, `find -exec`, `xargs`, `sudo`, `env`, dan sejenisnya dibuka dan dinilai juga (sampai 3 tingkat).
2. **Menilai tiap perintah** berdasarkan kosakata (hapus, ubah berkas, git, paket, interpreter, jaringan, sistem) dan **tiap jalur** yang muncul (argumen, `--opsi=jalur`, `@berkas`, target pengalihan).
3. **Menilai jalur** memakai `classifyPath` (yang sama dengan penanda berkas sensitif di tampilan diff) ditambah aturan sendiri: nama mirip `.env` (`.env-prod`, `.env_old`, `prod.env`), titik/spasi/aliran data di ujung nama (`.env.`, `.env::$DATA`), wildcard yang bisa cocok dengan berkas rahasia (`.e*`, `*.env`), `~` dan variabel rumah, naik lewat `..`, huruf besar-kecil dan huruf drive di Windows, UNC, dan nama pendek Windows (`PROGRA~1`).
4. **Tautan simbolik**: bila daemon memberikan `realpath`, tujuan sebenarnya dinilai juga, termasuk untuk berkas baru di bawah folder yang ditautkan keluar proyek. Penilainya sendiri murni dan tidak menyentuh disk.
5. **Mengambil yang tertinggi** dari semua temuan; alasan diurutkan dari yang terberat, tanpa duplikat, paling banyak 8.

PowerShell dan Bash memakai mesin yang sama dengan sedikit perbedaan (tanda kutip balik adalah escape di PowerShell dan substitusi di Bash; singkatan opsi seperti `-rec` untuk `-Recurse`; alias seperti `ri`, `gc`, `iwr`, `iex`).

## Hasil pengukuran

Diukur otomatis di setiap `pnpm check`:

| Ukuran | Hasil |
|---|---|
| Korpus **wajib tinggi** (hapus massal, rahasia, di luar proyek, push, unduh-jalankan, sistem; termasuk yang disamarkan; Bash, PowerShell, alat berkas) | **276 kasus, semuanya tinggi** |
| Korpus **tidak boleh rendah** (tidak bisa dinilai, tidak dikenali, input rusak, jaringan, memasang paket, ...) | **176 kasus, tidak ada yang rendah** |
| Korpus **perintah aman yang umum** (baca-saja, git baca, suntingan berkas biasa, Windows) | **143 kasus, alarm palsu 0** (semuanya rendah) |
| Fuzz 1.500 perintah acak, tiap kali untuk Bash dan PowerShell | tidak pernah melempar galat, selalu menghasilkan `Risk` yang sah |
| Waktu penilaian (11.900 penilaian) | p50 0,011 ms, **p95 0,042 ms**, p99 0,12 ms, maks 2,5 ms. Target PRD §14: p95 < 20 ms |
| Uji mutasi (48 mutan: hapus satu pola, ubah nilai bawaan menjadi rendah, matikan pemecah) | 46 tertangkap pada putaran terakhir. 2 yang lolos setara secara perilaku (`find -name` dan pemotongan aliran data NTFS dilindungi aturan lain). Putaran pertama meloloskan 7 mutan: 5 ditutup dengan tes baru, 2 dijelaskan setara |

**Alarm palsu yang disengaja.** Perintah umum berikut bernilai **sedang**, bukan rendah, karena menjalankan kode proyek atau mengubah berkas: `npm test`, `npm run build`, `pnpm test`, `node x.js`, `python x.py`, `git commit`, `git add`, `mkdir`, `touch`, `cp`, `mv`, `npm install`, `curl`. Alasannya PRD §9 butir "celah skrip": `npm test` menjalankan kode dari repo yang bisa saja sudah diubah agent. Pengguna yang ingin `npm test` berjalan otomatis memakai policy engine (tahap 4.5), bukan melonggarkan penilai. Alarm palsu pada kasus lain yang diketahui (selalu ke arah lebih hati-hati): `grep -r` (bisa membaca `.env`), kata `.env` di argumen biasa (mis. `git show HEAD:.env` memang tinggi), jalur gaya Git Bash `/c/proyek/...` yang dianggap di luar proyek Windows.

## Keterbatasan (jujur)

- **Ini bukan shell lengkap.** Ekspansi variabel, alias, fungsi shell, `source` ke berkas yang isinya tidak terlihat, dan perintah yang dibentuk dari isi berkas tidak bisa diikuti. Semuanya ditandai tidak bisa dinilai (minimal sedang), bukan ditebak.
- **Isi kode inline** (`python -c`, `node -e`) tidak dianalisis; hanya dicari pola berbahaya yang umum dan nama berkas rahasia. Selain itu sedang.
- **Isi skrip** yang dijalankan (`bash x.sh`, `npm test`) tidak dibaca. Itu sebabnya levelnya sedang.
- **Tautan simbolik yang dibuat di perintah yang sama** (`ln -s /etc x && cat x`) tidak terlihat saat dinilai; `ln -s` sendiri sudah bernilai sedang dan mencantumkan alasannya. Dan tautan hanya terbaca bila daemon memberi `realpath` (daemon memberikannya).
- Alat yang tidak dikenali (alat MCP, sub-agent) selalu sedang. Belum ada penilaian khusus per alat.
- Level hanya memandu tampilan dan policy. **Batas keras** (aksi tinggi tidak bisa disetujui otomatis oleh aturan apa pun) ditegakkan oleh policy engine (tahap 4.5), bukan oleh berkas ini.

## Menambah atau mengubah aturan

1. Tambahkan kasus ke `risk/corpus.ts` lebih dulu (berbahaya di `MUST_BE_HIGH` atau `MUST_NOT_BE_LOW`, aman di `COMMON_SAFE`). Tes membaca korpus itu.
2. Ubah `risk/assess.ts` (kosakata di bagian atas, aturan per perintah di bawahnya).
3. Jalankan `pnpm --filter @agentmon/bridge test src/risk`. Korpus aman harus tetap 0 alarm palsu.
4. Aturan baru yang menjaga keselamatan wajib diuji mutasi: hapus aturannya, tes harus gagal.
