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
| `verify-fail-open.sh` | Menjalankan 11 skenario kegagalan hook `http` dengan Claude Code sungguhan dan menilai hasilnya (sekitar 1 menit) |
| `fake-daemon.mjs` | Daemon palsu yang menjawab salah (lambat, teks biasa, JSON rusak, status 500, `allow`) |
| `judge.mjs` | Menilai satu eksperimen: sesi selesai, tidak ada aksi yang disetujui, alur izin normal teramati |
| `print-config.ts` | Mencetak konfigurasi hook dari pembuat konfigurasi yang sebenarnya |
| `verify-hold.ts` | Menjalankan 5 skenario penahanan aksi dengan Claude Code sungguhan (disetujui, ditolak dengan komentar, tanpa jawaban, dijeda, hanya membaca). Daemon sungguhan berjalan di proses yang sama dengan penjawab otomatis |
| `verify-dev-ui.ts` | Membuktikan halaman web lokal dengan browser (Edge tanpa tampilan, dikendalikan lewat CDP) dan Claude Code sungguhan: isi hostile tampil sebagai teks, lalu klik Setujui dan Tolak di halaman menentukan nasib sesi Claude. Butuh Edge (atur `EDGE_PATH` bila lokasinya berbeda) |
| `measure-overhead.ts` | Mengukur waktu tambahan hook `http` dengan daemon sebenarnya (satu sesi, 15 pembacaan berkas) |

## Cara menjalankan
Butuh Node.js, Claude Code, dan Git Bash (di Windows). Eksperimen memakai model `haiku` dan memakai sedikit kuota langgananmu.

```bash
SPIKE_OUT=/tmp/spike tools/hook-spike/run.sh 03-allow-pretooluse \
  tools/hook-spike/scenarios/pretooluse-allow-write.json \
  "Buat file notes.txt berisi teks 'catatan'. Setelah itu berhenti."
```

Hook dipasang hanya lewat `--settings` untuk satu sesi percobaan, jadi pengaturan Claude Code globalmu tidak disentuh. Variabel lain: `SPIKE_TIMEOUT` (detik), `SPIKE_MODEL`, `SPIKE_TURNS`, `SPIKE_EVENTS` (daftar event, dipisah koma), dan `SPIKE_HTTP_URL` (memakai hook bertipe `http`).

Pembuktian anti-macet dan pengukuran overhead memakai konfigurasi dari kode produk, bukan pengaturan tulisan tangan:

```bash
SPIKE_OUT=/tmp/spike tools/hook-spike/verify-fail-open.sh
cd packages/bridge && SPIKE_OUT=/tmp/spike node --import tsx ../../tools/hook-spike/measure-overhead.ts
cd packages/bridge && SPIKE_OUT=/tmp/spike node --import tsx ../../tools/hook-spike/verify-hold.ts
cd packages/bridge && SPIKE_OUT=/tmp/spike node --import tsx ../../tools/hook-spike/verify-dev-ui.ts
```

Keduanya membutuhkan `pnpm install` lebih dulu, karena memakai `tsx` dari paket `bridge`. Variabel tambahan untuk `run.sh`: `SPIKE_SETTINGS` (berkas pengaturan siap pakai) dan `SPIKE_SEED` (isi folder proyek).

Hasil tiap eksperimen (`events.jsonl`, `stream.jsonl`) berisi path dan isi pengaturan laptopmu, jadi folder `out/` tidak ikut git. Gunakan `make-fixtures.mjs` untuk membuat data yang aman dibagikan.
