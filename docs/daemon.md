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

Jawaban daemon selalu objek JSON. `{}` berarti tanpa keputusan, sehingga alur izin normal berjalan.

## Endpoint
| Endpoint | Fungsi |
|---|---|
| `GET /health` | `status`, `version`, `pid`, `startedAt`, `uptimeMs` |
| `POST /hook` | Menerima input hook (`Content-Type: application/json`, maksimum 10 MiB). Jawaban `200` |

Kode lain: `400` (JSON atau bentuk tidak valid), `404`, `405`, `413` (terlalu besar), `415` (bukan JSON).

## Perilaku saat gagal
Penangan hook yang error tetap dijawab `200` dengan `{}` dan dicatat, bukan `500` dan bukan persetujuan. Daemon mati atau menolak request tidak menghentikan agent: Claude Code menganggapnya kesalahan tanpa pemblokiran dan meneruskan alur izin normal. Buktinya ada di [hooks-claude-code.md](hooks-claude-code.md).
