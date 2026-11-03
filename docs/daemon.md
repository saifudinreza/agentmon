# Daemon AgentMon

Proses background di laptop yang menjadi pusat kerja AgentMon. Pada tahap ini ia menerima hook dari Claude Code, memeriksa siapa pengirimnya, dan mencatat event ke log. Keputusan approval ditambahkan di issue berikutnya.

## Menjalankan
```bash
pnpm --filter @agentmon/bridge daemon
```
Daemon membuka `http://127.0.0.1:47821`. Variabel yang bisa diatur:

| Variabel | Fungsi | Bawaan |
|---|---|---|
| `AGENTMON_PORT` | Port daemon | `47821` |
| `AGENTMON_HOME` | Folder data | `~/.agentmon` |

Port dibuat tetap karena alamatnya tertulis di pengaturan hook Claude Code. Menjalankan daemon kedua tidak merusak yang pertama: ia mendeteksi daemon yang berjalan, mencetak pesan, lalu keluar dengan kode 0.

## Data di `~/.agentmon`
| Berkas | Isi |
|---|---|
| `token` | Rahasia untuk autentikasi (64 karakter heksadesimal). Dibuat sekali, izin `0600` di macOS dan Linux |
| `daemon.json` | PID, port, dan waktu mulai. Dihapus saat daemon berhenti baik-baik. Yang tertinggal setelah daemon mati mendadak tidak menghalangi start berikutnya |
| `daemon.log` | Log, berputar ke `daemon.log.1` saat melewati 1 MB |

Log hanya berisi nama event, nama alat, dan hasilnya. Isi pesan (kode, perintah) tidak pernah dicatat.

## Keamanan
Daemon hanya mendengarkan di `127.0.0.1`, jadi tidak terjangkau dari jaringan. Karena situs web di browser juga bisa menembak `127.0.0.1`, setiap request melewati tiga pemeriksaan:

1. **Host** harus `127.0.0.1:<port>` atau `localhost:<port>` (menolak DNS rebinding). Jika tidak: 403.
2. **Bukan dari browser:** request dengan `Origin` atau `Sec-Fetch-*` ditolak walau tokennya benar. Jika tidak: 403.
3. **Token** di header `Authorization: Bearer <token>`. Jika tidak: 401. Token di query string tidak diterima.

Daemon tidak mengirim header CORS, jadi browser tidak bisa membaca jawabannya.

## Menghubungkan Claude Code (hook `http`)
Claude Code mengirim input hook sebagai `POST` JSON ke `/hook`. Contoh pengaturan (isi `<token>` dengan isi berkas `token`):

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{
        "type": "http",
        "url": "http://127.0.0.1:47821/hook",
        "headers": { "Authorization": "Bearer <token>" },
        "timeout": 600
      }] }
    ]
  }
}
```
Daftarkan hal yang sama untuk event lain yang dibutuhkan. Jangan memakai `onFailure: "block"`, karena itu membuat agent berhenti saat daemon mati.

Tulis alamatnya sebagai `127.0.0.1`, **bukan** `localhost`. Daemon hanya mendengarkan di IPv4, sedangkan di sebagian komputer `localhost` diarahkan ke `::1` (IPv6) lebih dulu. Koneksinya akan ditolak, dan hook gagal diam-diam (aman, tetapi tidak berfungsi). Daemon menerima `Host: localhost`, tetapi itu tidak menjamin koneksinya sampai.

Token juga bisa dibaca dari variabel lingkungan: `"Authorization": "Bearer $AGENTMON_TOKEN"` bersama `"allowedEnvVars": ["AGENTMON_TOKEN"]`. Variabel itu harus ada di lingkungan proses Claude Code, jadi pemasang otomatis (issue setup) lebih baik menuliskan tokennya langsung di pengaturan tingkat pengguna.

**Konfigurasi ini memuat token.** Siapa pun yang bisa membaca berkas pengaturannya bisa memanggil daemon. Karena itu pemasang (issue setup) harus: mempertahankan izin berkas pengaturan yang sudah ada dan tidak membuatnya lebih longgar (di macOS dan Linux, berkas baru dibuat `0600`), tidak pernah menuliskan isi konfigurasi atau token ke log, dan tidak menaruhnya di dalam repo proyek. Pembuat konfigurasi sendiri tidak memasukkan token ke pesan error.

Jawaban daemon selalu objek JSON. `{}` berarti tanpa keputusan, sehingga alur izin normal berjalan.

Konfigurasi di atas dihasilkan oleh `buildClaudeHookSettings` (`packages/bridge/src/hook-config.ts`), bukan ditulis tangan, supaya persis sama dengan yang nanti dipasang oleh perintah setup. Fungsi itu mendaftarkan enam event (`PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`), memakai `127.0.0.1`, dan tidak pernah memuat `onFailure`. Batas tunggu hook dibedakan: 600 detik hanya untuk `PreToolUse` dan `PermissionRequest` (menunggu keputusan dari HP), 10 detik untuk empat event pengamatan, supaya daemon yang membeku tidak menahan agent lama pada event yang tidak menunggu siapa pun. `UserPromptSubmit` sengaja tidak didaftarkan karena isinya adalah teks perintah pengguna dan tidak dipakai kontrak pesan. `SessionStart` juga tidak didaftarkan: event itu hanya mendukung hook `command`, bukan `http`, sehingga event `session.started` tidak datang dari hook ini.

## Adapter Claude Code (pemetaan ke kontrak)
Input hook mentah dari Claude Code diubah menjadi event baku (paket `shared`) oleh adapter di `packages/bridge/src/adapters/`. Inti daemon (`daemon.ts`, `server.ts`, dan lainnya) tidak mengenal istilah Claude Code; ada test yang menjaganya.

| Input hook | Hasil |
|---|---|
| `PreToolUse` | event `tool.requested` |
| `PostToolUse` | event `tool.completed` (`ok` bernilai `false` bila perintah dihentikan di tengah jalan) |
| `Stop` | event `agent.stopped` |
| `Notification` | event `agent.notification` (belum pernah teramati, bentuknya dari dokumentasi) |
| `SessionStart` | event `session.started` (dipetakan, tetapi tidak datang lewat hook `http`, lihat di bawah) |
| `PermissionRequest` | permintaan izin netral untuk approval engine. Bukan event, karena `approval.requested` butuh nomor persetujuan dan batas waktu |
| `SessionEnd` | penanda sesi berakhir. Kontrak tidak punya event ini, dan `session.recap` dihitung dari catatan sesi |
| `UserPromptSubmit` | diabaikan (isinya teks perintahmu) |
| nama lain | dicatat sebagai tidak dikenal, lalu diabaikan |
| kolom wajib hilang | dicatat sebagai tidak sah, lalu diabaikan |

Setiap event diberi `id` unik, `machineId` (UUID acak di `~/.agentmon/machine-id`), waktu, dan `seq` yang naik per sesi mulai dari 0. Nomor urut hanya terpakai oleh event yang benar-benar dikirim, jadi tidak ada celah. Data yang tidak dikenal atau rusak hanya dicatat (nama event, tanpa isinya) dan agent tidak terganggu.

Event dikirim ke penerima (`EventSink`) di belakang layar, sedangkan jawaban ke Claude Code langsung `{}`. Penerima yang lambat, macet, atau error tidak menahan agent. Sementara ini penerimanya hanya mencatat jenis event ke log. Relay dan timeline menggantikannya di issue berikutnya.

**Keterbatasan yang perlu diingat:**
- `SessionStart` hanya mendukung hook `command`, jadi daemon tidak menerima awal sesi. Penanda awal sesi harus diturunkan dari event pertama sebuah sesi. Ini perlu diputuskan sebelum daftar sesi dibuat.
- `seq` hanya hidup selama daemon berjalan. Bila daemon dimulai ulang di tengah sesi, urutan sesi itu mulai lagi dari 0; penerima menyaring duplikat lewat `id`.

## Endpoint
| Endpoint | Fungsi |
|---|---|
| `GET /health` | `status`, `version`, `pid`, `startedAt`, `uptimeMs` |
| `POST /hook` | Menerima input hook (`Content-Type: application/json`, maksimum 10 MiB). Jawaban `200` |

Kode lain: `400` (JSON atau bentuk tidak valid), `404`, `405`, `413` (terlalu besar), `415` (bukan JSON).

## Perilaku saat gagal
Penangan hook yang error tetap dijawab `200` dengan `{}` dan dicatat, bukan `500` dan bukan persetujuan. Daemon mati atau menolak request tidak menghentikan agent: Claude Code menganggapnya kesalahan tanpa pemblokiran dan meneruskan alur izin normal. Buktinya ada di [hooks-claude-code.md](hooks-claude-code.md), bagian 8b: jawaban teks biasa, JSON terpotong, nilai keputusan yang tidak dikenal, status 500, token salah, port salah, daemon mati, dan daemon yang terlalu lambat semuanya diperlakukan seperti tanpa keputusan.

**Daemon tidak boleh memblokir event loop-nya.** Hook menunggu jawaban sampai batas waktunya (bawaan 600 detik), jadi daemon yang membeku sama dengan agent yang berhenti. Pekerjaan berat di dalam penangan hook, misalnya menghitung diff besar atau menjalankan git, harus asinkron.
