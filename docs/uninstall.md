# Perintah `uninstall`

`agentmon uninstall` membersihkan semua yang dipasang AgentMon di laptop. Tiap langkah dicoba walau langkah lain gagal; kode keluar `1` bila ada langkah yang GAGAL, `2` bila argumen salah. Menjalankannya dua kali aman.

## Yang dikerjakan (berurutan)

1. **Hook Claude Code.** Hanya entri hook AgentMon di `settings.json` yang dibuang. Hook dan pengaturan milik Anda, termasuk yang ditambahkan SETELAH setup, tetap utuh. Perintah ini membuang entri secara semantik, bukan memulihkan cadangan lama (yang akan menghapus perubahan Anda). Bila `settings.json` tidak berisi apa pun lagi, berkas itu (dibuat oleh setup) dihapus setelah dicadangkan. Tautan simbolik tidak dihapus, hanya isinya dikosongkan. Bila berkas berubah selagi berjalan, tidak ada yang diubah.
2. **Autostart dan daemon.** Autostart per OS dicopot, lalu daemon yang berjalan dihentikan lewat `POST /stop`.
3. **Relay.** Laptop mencabut dirinya lewat `DELETE /machine`. Bila relay lama belum mendukungnya atau tidak terjangkau, langkah ditandai MANUAL/GAGAL dan `relay.json` dipertahankan agar bisa diulang.
4. **Data lokal dan checkpoint** (hanya bila diminta).

## Opsi

| Opsi | Fungsi |
|---|---|
| `--dry-run` | hanya menampilkan apa yang akan dikerjakan |
| `--purge-data` | hapus berkas data AgentMon yang dikenal di `~/.agentmon` (token, relay.json, log, dll.); folder dihapus hanya bila kosong |
| `--purge-policy` | ikut hapus `policy.json` (butuh `--purge-data`) |
| `--purge-checkpoints` | hapus ref `refs/agentmon/checkpoints/*` di repo saat ini; ref lain tidak disentuh |
| `--skip-relay` | lewati pencabutan di relay |
| `--claude-dir <path>` | folder pengaturan Claude Code (absolut) |

Token tidak pernah dicetak.
