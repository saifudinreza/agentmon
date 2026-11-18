# Autostart daemon dan perintah `status`

Daemon yang berhenti membuat HP melihat laptop **Offline** dan sesi Claude Code tidak terdeteksi. `autostart` menyalakannya sendiri saat Anda masuk ke laptop, dan menyalakannya lagi bila berhenti. Kodenya di `packages/bridge/src/autostart.ts`. Rujukan: PRD FR-52.

```bash
pnpm --filter @agentmon/bridge cli autostart install          # pasang, dan nyalakan sekarang
pnpm --filter @agentmon/bridge cli autostart install --hold   # pasang dengan penahanan izin untuk HP (AGENTMON_HOLD=1)
pnpm --filter @agentmon/bridge cli autostart status           # sudah terpasang? daemon menjawab?
pnpm --filter @agentmon/bridge cli autostart remove           # copot dan hentikan
```
Semuanya **per pengguna dan tanpa hak admin**. Aman dijalankan berulang (memasang ulang menggantikan yang lama, tidak menumpuk).

## Mekanisme per sistem operasi
| Sistem | Mekanisme | Restart setelah berhenti | Berkas |
|---|---|---|---|
| **Windows** | Kunci `Run` milik pengguna (HKCU) yang menjalankan skrip VBS lewat `wscript //B` | Skrip menunggu daemon berhenti lalu mengulang: jeda 3 detik, atau 30 detik bila daemon berhenti kurang dari 20 detik setelah mulai (galat atau sudah ada yang berjalan) | `<folder data>\autostart\agentmon-daemon.vbs` |
| **macOS** | LaunchAgent (`~/Library/LaunchAgents/dev.agentmon.daemon.plist`), dimuat dengan `launchctl bootstrap gui/<uid>` | `KeepAlive` hanya bila berhenti karena galat (keluar normal berarti sengaja berhenti), jeda minimal 10 detik | plist di atas |
| **Linux** | Unit **systemd pengguna** (`~/.config/systemd/user/agentmon.service`), diaktifkan dengan `systemctl --user enable --now` | `Restart=on-failure`, `RestartSec=5` | unit di atas |

- **Windows tanpa jendela.** Skrip memakai gaya jendela 0, jadi tidak ada jendela terminal yang muncul. Penjadwal Tugas dengan "saat masuk" sengaja tidak dipakai karena butuh hak admin. Skrip disimpan sebagai UTF-16 dengan BOM supaya path berhuruf non-ASCII (mis. nama pengguna `Müller`) terbaca.
- **Linux dan boot.** Layanan pengguna menyala saat Anda **masuk**, bukan saat laptop baru hidup. Untuk menyala saat boot tanpa login, jalankan sekali `loginctl enable-linger $USER`. Perintah ini hanya memberi tahu; tidak mengubahnya otomatis. Tanpa systemd pengguna, pemasangan berhenti dengan pesan jelas.
- **Berhenti dengan sengaja.** `autostart remove` menghentikan daemon yang dinyalakan autostart (di Windows seluruh pohon prosesnya). Daemon yang Anda jalankan sendiri di terminal tidak disentuh.
- **Menjalankan daemon dua kali** tidak merusak apa pun: yang kedua langsung keluar dengan pesan (kode 0), jadi tidak memicu restart cepat.

## Apa yang ditulis
Hanya perintah (node, `tsx`, dan titik masuk daemon, semuanya path absolut), folder kerja, dan variabel **non-rahasia**: `AGENTMON_HOME` dan `AGENTMON_PORT` bila Anda mengisinya saat memasang, serta `AGENTMON_HOLD=1` bila memakai `--hold`. **Token daemon, token relay, dan alamat relay tidak pernah ditulis**; daemon membacanya dari folder data (`~/.agentmon`). Path atau nilai yang memuat tanda kutip atau baris baru ditolak sejak awal, supaya tidak bisa merusak berkasnya.

`--hold` penting: tanpa itu daemon tidak menahan aksi agent, jadi izin tidak muncul di HP (agent berjalan seperti tanpa AgentMon). Dengan `--hold`, aksi ditahan **hanya bila ada HP yang online**; bila tidak, agent berjalan normal.

## Perintah `status`
```
pnpm --filter @agentmon/bridge cli status
```
Melaporkan: ringkasan keadaan daemon (aktif, dijeda, izin yang menunggu), **Daemon** (alamat), **Relay** (tersambung, menyambung, terputus, atau tidak dipakai, dan apakah ada HP yang online), **Perangkat** (jumlah HP yang terpasang, dihitung dari relay; "tidak diketahui" bila relay tidak terjangkau atau laptop belum terdaftar), dan **Mulai otomatis** (aktif atau belum dipasang). Tidak ada token atau alamat relay yang dicetak. Bila daemon tidak berjalan, `status` menjelaskan cara menyalakannya (atau `autostart install`).

## Yang perlu diketahui
- Daemon dijalankan dari **salinan kode ini** (node + tsx + `src/main.ts`). Bila folder proyek dipindah atau `pnpm install` mengubah versi `tsx`, jalankan `autostart install` lagi. Autostart untuk paket yang dibangun dan dipasang global (tanpa tsx) menyusul bersama rilis (issue #047).
- Uji otomatis memverifikasi isi berkas dan urutan perintah sistem dengan `exec` palsu. **Pemasangan sungguhan di macOS dan Linux belum dicoba di perangkat nyata**; di Windows, peluncur sudah dibuktikan menyalakan daemon tanpa jendela, menyalakannya lagi setelah dimatikan paksa, dan bisa dihentikan (uji manual pada folder dan port sementara).
- Kunci `Run` Windows dijalankan saat masuk; sesi Claude Code yang sudah terbuka tetap perlu dimulai ulang agar memuat hook (lihat `docs/setup.md`).
