# Spike hook Claude Code

Alat untuk riset issue "Spike: hook logger Claude Code dan fixture". Bukan kode produksi, jangan dipakai sebagai dasar daemon. Temuannya ada di [docs/hooks-claude-code.md](../../docs/hooks-claude-code.md).

## Isi
| Berkas | Fungsi |
|---|---|
| `log-hook.mjs` | Hook pencatat. Mencatat input hook ke `SPIKE_LOG`, lalu mengembalikan keputusan sesuai skenario |
| `http-sink.mjs` | Penerima untuk hook bertipe `http`, dengan skenario yang sama |
| `make-settings.mjs` | Membuat file settings berisi hook untuk semua event |
| `run.sh` | Menjalankan satu eksperimen dengan Claude Code sungguhan di folder sementara |
| `summarize.mjs` | Meringkas hasil satu eksperimen |
| `make-fixtures.mjs` | Membuat fixture bersih di `packages/bridge/fixtures/claude-code` |
| `scenarios/` | Aturan keputusan per eksperimen (tolak, izinkan, ubah input, timeout, dan lainnya) |
| `seed/` | Isi folder proyek percobaan |

## Cara menjalankan
Butuh Node.js, Claude Code, dan Git Bash (di Windows). Eksperimen memakai model `haiku` dan memakai sedikit kuota langgananmu.

```bash
SPIKE_OUT=/tmp/spike tools/hook-spike/run.sh 03-allow-pretooluse \
  tools/hook-spike/scenarios/pretooluse-allow-write.json \
  "Buat file notes.txt berisi teks 'catatan'. Setelah itu berhenti."
```

Hook dipasang hanya lewat `--settings` untuk satu sesi percobaan, jadi pengaturan Claude Code globalmu tidak disentuh. Variabel lain: `SPIKE_TIMEOUT` (detik), `SPIKE_MODEL`, `SPIKE_TURNS`, `SPIKE_EVENTS` (daftar event, dipisah koma), dan `SPIKE_HTTP_URL` (memakai hook bertipe `http`).

Hasil tiap eksperimen (`events.jsonl`, `stream.jsonl`) berisi path dan isi pengaturan laptopmu, jadi folder `out/` tidak ikut git. Gunakan `make-fixtures.mjs` untuk membuat data yang aman dibagikan.
