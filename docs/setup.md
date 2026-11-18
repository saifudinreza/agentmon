# Perintah `setup`

Satu perintah untuk menyambungkan Claude Code ke daemon AgentMon. Kodenya di `packages/bridge/src/setup.ts`. Rujukan: PRD FR-50 sampai FR-53 dan FR-58.

```bash
pnpm --filter @agentmon/bridge cli setup                # pasang hook, lalu tampilkan QR pairing
pnpm --filter @agentmon/bridge cli setup --dry-run      # hanya melaporkan, tidak menulis apa pun
pnpm --filter @agentmon/bridge cli setup --no-pair      # pasang hook saja
pnpm --filter @agentmon/bridge cli setup --claude-dir "D:\folder claude"   # folder pengaturan Claude Code lain
```
Aman dijalankan berulang. Folder bawaan: `CLAUDE_CONFIG_DIR` bila diisi (nilai kosong dianggap tidak diisi), atau `~/.claude`. **Folder harus path absolut** (tanpa `~` dan tanpa path relatif): berkas ini memuat token, dan path relatif akan jatuh ke folder kerja yang bisa berada di dalam repo proyek. Port mengikuti `AGENTMON_PORT` (bawaan 47821).

## Yang dikerjakan
1. **Deteksi.** Mencari program `claude` di PATH dan folder pengaturannya. Claude Code tidak ditemukan: pesan jelas dan kode keluar 1, tanpa mengubah apa pun. Codex hanya dilaporkan (jalurnya tahap 7).
2. **Hook.** Menulis hook `http` (enam event, lihat `docs/daemon.md`) ke `settings.json` **tingkat pengguna**, berisi alamat `127.0.0.1`, port, dan token daemon. Token dibuat bila daemon belum pernah dijalankan (daemon memakainya ulang). Tidak pernah ditulis ke dalam folder proyek.
3. **Penggabungan dan cadangan.** Hook dan pengaturan milik Anda tetap utuh. Hook AgentMon dikenali dari bentuknya: hook `http` ke `127.0.0.1` atau `localhost`, jalur `/hook`, **dengan header `Authorization: Bearer <64 heksadesimal>`**. Hook dikenali ini **diganti**, bukan ditambah, sehingga mengganti port atau token tidak meninggalkan hook lama (jumlah yang diganti dilaporkan). Hook alat lain ke alamat yang mirip tidak disentuh. Berkas lama disalin ke `settings.json.agentmon-backup-<tanggal-jam>` (dengan akhiran `-2`, `-3` bila bentrok) dan **hanya 5 cadangan terbaru disimpan**, karena cadangan lama bisa memuat token dari pemasangan sebelumnya.
4. **Idempoten (FR-58).** Bila tiap event sudah memuat tepat satu hook AgentMon yang sama persis, tidak ada yang ditulis dan tidak ada cadangan baru ("sudah terpasang dan mutakhir"), walau Anda menambah hook sendiri sesudahnya.
5. **Ringkasan dan pairing.** Melaporkan apakah daemon berjalan, lalu bila laptop sudah terdaftar ke relay dan `AGENTMON_APP_URL` diisi, menampilkan QR (sama dengan perintah `pair`). Bila belum, memberi tahu langkah berikutnya (`register`, lalu `pair`); pemasangan hook tetap dianggap berhasil.

## Keamanan berkas pengaturan
Berkas itu memuat **token daemon**: siapa pun yang bisa membacanya bisa memanggil daemon.
- Izin berkas yang sudah ada **dipertahankan**, tidak dilonggarkan. Berkas baru dibuat `0600` (macOS dan Linux; di Windows izin folder profil berlaku).
- Penulisan **atomik**: ke berkas sementara (nama acak) di folder yang sama, lalu diganti, jadi tidak pernah setengah tertulis. Cadangan dibuat setelah berkas sementara siap dan **dihapus lagi bila penggantian gagal**, jadi kegagalan tidak meninggalkan cadangan berisi token. Berkas sedang dipakai atau hanya-baca (EPERM, EBUSY, EACCES): pesan jelas, tidak ada yang diubah.
- Bila `settings.json` adalah **tautan simbolik** (mis. dari repo dotfiles), tautannya tetap dan berkas tujuannya yang diperbarui. **Hardlink tidak ditangani**: penggantian berkas memutusnya.
- Isi dibaca ulang tepat sebelum diganti. Bila berubah selagi setup berjalan (mis. Claude Code menulisnya), setup **batal** tanpa menimpa perubahan itu.
- `--dry-run` **tidak membuat apa pun**, termasuk folder data dan berkas token.
- Isi hook dan token **tidak pernah dicetak atau dicatat**; pesan galat membuang rangkaian heksadesimal panjang.
- Gaya berkas Anda dipertahankan (indentasi spasi atau tab, akhir baris CRLF atau LF, BOM, ada tidaknya baris akhir).
- Isi JSON **dinormalisasi** saat ditulis ulang (kunci ganda tinggal satu, angka sangat besar bisa kehilangan presisi, `1.0` menjadi `1`, berkas yang dipadatkan dicetak ulang); komentar tidak didukung karena Claude Code memakai JSON biasa. Cadangan menyimpan teks aslinya.
- Berkas yang bukan JSON sah, atau berbentuk tak dikenal (`hooks` bukan objek, event bukan daftar), **tidak diubah sama sekali**: setup berhenti dengan pesan, supaya pengaturan Anda tidak rusak.
- Cadangan lama berisi isi sebelum setup, jadi bisa memuat token dari pemasangan sebelumnya. Hapus cadangan yang tidak dipakai.

## Yang perlu diketahui
- **Token dapat dibaca oleh agent yang diawasi** (berkas pengaturannya ada di folder yang bisa dibaca Claude Code). Token yang sama dipakai API kendali lokal daemon, sehingga agent yang berniat jahat bisa mencoba memutuskan izinnya sendiri. Ini batas yang dibawa rancangan token tunggal sejak awal, bukan akibat `setup`; perbaikannya (token khusus hook yang tidak boleh memutuskan) dilacak di issue terpisah. Sampai itu, jangan mengandalkan `setup` untuk mengawasi agent yang tidak Anda percaya.
- **Hook berlaku untuk SEMUA sesi Claude Code**, bukan hanya satu proyek. Bila daemon tidak berjalan, hook gagal dengan tenang (tidak pernah memblokir) dan Claude Code berjalan seperti biasa.
- **Sesi yang sudah terbuka** tidak memuat hook baru; mulai ulang sesinya (termasuk di VS Code).
- **Daemon tidak dinyalakan oleh setup.** Jalankan `pnpm --filter @agentmon/bridge daemon` (dengan `AGENTMON_HOLD=1` agar izin bisa dijawab dari HP). Menyala otomatis saat masuk ke laptop dilakukan oleh `autostart install` (lihat `docs/autostart.md`); mencopot hook adalah #045 (fungsi `removeAgentmonHooks` sudah ada untuk itu).
- **Hook milik Anda ke `127.0.0.1:<port>/hook`** (alamat dan jalur persis seperti milik AgentMon) akan dianggap milik AgentMon dan diganti. Pakai jalur lain bila perlu.
- **Salinan stabil program** (agar daemon tetap jalan walau repo dipindah) belum dibuat; hook `http` tidak butuh program apa pun, jadi hanya daemon yang kelak membutuhkannya.
- Kode keluar: `0` berhasil, `1` gagal atau prasyarat kurang, `2` argumen salah. Bila pairing dijalankan, kode keluarnya mengikuti `pair`; pengaturan relay yang rusak hanya memberi peringatan "Pairing dilewati" (hook sudah terpasang, kode 0). Bila pengaturan Anda memuat `"disableAllHooks": true`, setup memperingatkan bahwa semua hook diabaikan.
