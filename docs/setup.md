# Perintah `setup`

Satu perintah untuk menyambungkan Claude Code ke daemon AgentMon. Kodenya di `packages/bridge/src/setup.ts`. Rujukan: PRD FR-50 sampai FR-53 dan FR-58.

```bash
pnpm --filter @agentmon/bridge cli setup                # pasang hook, lalu tampilkan QR pairing
pnpm --filter @agentmon/bridge cli setup --dry-run      # hanya melaporkan, tidak menulis apa pun
pnpm --filter @agentmon/bridge cli setup --no-pair      # pasang hook saja
pnpm --filter @agentmon/bridge cli setup --claude-dir "D:\folder claude"   # folder pengaturan Claude Code lain
```
Aman dijalankan berulang. Folder bawaan: `CLAUDE_CONFIG_DIR` bila diisi, atau `~/.claude`. Port mengikuti `AGENTMON_PORT` (bawaan 47821).

## Yang dikerjakan
1. **Deteksi.** Mencari program `claude` di PATH dan folder pengaturannya. Claude Code tidak ditemukan: pesan jelas dan kode keluar 1, tanpa mengubah apa pun. Codex hanya dilaporkan (jalurnya tahap 7).
2. **Hook.** Menulis hook `http` (enam event, lihat `docs/daemon.md`) ke `settings.json` **tingkat pengguna**, berisi alamat `127.0.0.1`, port, dan token daemon. Token dibuat bila daemon belum pernah dijalankan (daemon memakainya ulang). Tidak pernah ditulis ke dalam folder proyek.
3. **Penggabungan dan cadangan.** Hook dan pengaturan milik Anda tetap utuh. Hook AgentMon dikenali dari bentuknya (hook `http` ke `http://127.0.0.1:<port>/hook`) dan **diganti**, bukan ditambah, sehingga mengganti port atau token tidak meninggalkan hook lama. Sebelum menulis, berkas lama disalin ke `settings.json.agentmon-backup-<tanggal-jam>`.
4. **Idempoten (FR-58).** Dijalankan lagi tanpa perubahan: tidak menulis apa pun dan tidak membuat cadangan baru ("sudah terpasang dan mutakhir").
5. **Ringkasan dan pairing.** Melaporkan apakah daemon berjalan, lalu bila laptop sudah terdaftar ke relay dan `AGENTMON_APP_URL` diisi, menampilkan QR (sama dengan perintah `pair`). Bila belum, memberi tahu langkah berikutnya (`register`, lalu `pair`); pemasangan hook tetap dianggap berhasil.

## Keamanan berkas pengaturan
Berkas itu memuat **token daemon**: siapa pun yang bisa membacanya bisa memanggil daemon.
- Izin berkas yang sudah ada **dipertahankan**, tidak dilonggarkan. Berkas baru dibuat `0600` (macOS dan Linux; di Windows izin folder profil berlaku).
- Penulisan **atomik**: ke berkas sementara di folder yang sama, lalu diganti, jadi tidak pernah setengah tertulis.
- Isi hook dan token **tidak pernah dicetak atau dicatat**; pesan galat membuang rangkaian heksadesimal panjang.
- Gaya berkas Anda dipertahankan (indentasi spasi atau tab, akhir baris CRLF atau LF, BOM, ada tidaknya baris akhir).
- Berkas yang bukan JSON sah, atau berbentuk tak dikenal (`hooks` bukan objek, event bukan daftar), **tidak diubah sama sekali**: setup berhenti dengan pesan, supaya pengaturan Anda tidak rusak.
- Cadangan lama berisi isi sebelum setup, jadi bisa memuat token dari pemasangan sebelumnya. Hapus cadangan yang tidak dipakai.

## Yang perlu diketahui
- **Hook berlaku untuk SEMUA sesi Claude Code**, bukan hanya satu proyek. Bila daemon tidak berjalan, hook gagal dengan tenang (tidak pernah memblokir) dan Claude Code berjalan seperti biasa.
- **Sesi yang sudah terbuka** tidak memuat hook baru; mulai ulang sesinya (termasuk di VS Code).
- **Daemon tidak dinyalakan oleh setup.** Jalankan `pnpm --filter @agentmon/bridge daemon` (dengan `AGENTMON_HOLD=1` agar izin bisa dijawab dari HP). Menyala otomatis saat laptop hidup adalah issue #044; mencopot hook adalah #045 (fungsi `removeAgentmonHooks` sudah ada untuk itu).
- **Hook milik Anda ke `127.0.0.1:<port>/hook`** (alamat dan jalur persis seperti milik AgentMon) akan dianggap milik AgentMon dan diganti. Pakai jalur lain bila perlu.
- **Salinan stabil program** (agar daemon tetap jalan walau repo dipindah) belum dibuat; hook `http` tidak butuh program apa pun, jadi hanya daemon yang kelak membutuhkannya.
- Kode keluar: `0` berhasil, `1` gagal atau prasyarat kurang, `2` argumen salah. Bila pairing dijalankan, kode keluarnya mengikuti `pair`.
