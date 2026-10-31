# Alur, Tech Stack, Instalasi, dan Persiapan

Nama sementara: AgentMon. Status: perencanaan, belum ada kode. Dokumen ini melengkapi `rencana-agent-monitor.md` dan `diferensiasi-kompetitor.md`.

## 1. Alur pengguna dan apa yang terjadi di baliknya

| Langkah pengguna | Yang terjadi secara teknis |
|---|---|
| 1. Kerja di VS Code / Antigravity / editor lain, Claude Code atau Codex jalan di terminal atau extension | Hooks agent sudah terpasang (sekali saat setup). Daemon AgentMon jalan di background laptop. |
| 2. Minta agent membuat fitur, lalu menunggu | Tiap aksi agent memicu hook. Hook mengirim event ke daemon lokal, daemon meneruskan ke relay server. HP menampilkan timeline secara real-time. |
| 3. Review kode di HP sebelum accept | Untuk Edit/Write, hook menahan eksekusi. Daemon menghitung diff (file sekarang vs usulan agent) dan mengirimnya ke HP. Kamu Approve, Deny + komentar, atau terima sebagian. |
| 4. Notifikasi saat butuh izin atau selesai | Permintaan izin dan event selesai (Stop di Claude Code, agent-turn-complete di Codex) memicu Web Push ke HP. |

### Poin penting yang sudah diverifikasi
- **Claude Code**: hook `PreToolUse` dan `PermissionRequest` bisa mengembalikan allow, deny, atau ask. Saat deny, pesan alasan dibaca Claude, jadi komentarmu jadi umpan balik. Ada juga `updatedInput` untuk mengubah input tool sebelum dijalankan, artinya **terima sebagian perubahan secara teknis memungkinkan** (input Edit diganti versi yang sudah kamu saring).
- **Codex CLI**: hooks stabil sejak v0.124 (April 2026), mendukung `PreToolUse` dan `PermissionRequest`, konfigurasi di `~/.codex/hooks.json`. Hook baru harus di-trust sekali lewat perintah `/hooks` di Codex. Notifikasi selesai lewat `notify`.
- **Antigravity**: memakai Open VSX sebagai marketplace extension. Claude Code/Codex yang dijalankan di terminal Antigravity tetap terpantau karena hooks melekat di agent, bukan di editor. Agent bawaan Antigravity (Gemini) belum diketahui punya hooks, jadi ditunda.

### Desain anti-macet
- Hook tidak bicara langsung ke internet. Hook bicara ke daemon di `localhost`. Kalau daemon mati, hook langsung lolos (perilaku normal agent), tidak menahan apa pun.
- Kalau HP tidak menjawab sampai batas waktu, hook mengembalikan "ask" sehingga prompt izin muncul seperti biasa di terminal. Agent tidak pernah macet karena AgentMon.
- Timeout hook diatur cukup panjang di konfigurasi (misal 10 menit) supaya ada waktu review.

## 2. Pengalaman instalasi untuk pengguna (target: 2 menit)

Pembeda: **tidak ada perintah pengganti**. Beberapa kompetitor mengharuskan menjalankan perintah mereka sebagai ganti `claude` atau `codex`. AgentMon memasang hooks, jadi kamu tetap mengetik `claude` atau `codex` seperti biasa.

### Di laptop (Windows, macOS, Linux)
1. Pastikan Node.js sudah terpasang.
2. Jalankan satu perintah setup (contoh: `npx agentmon setup`). Perintah ini:
   - mendeteksi Claude Code dan Codex yang terpasang,
   - menambahkan hooks ke konfigurasi masing-masing (dengan backup file lama),
   - menyalakan daemon di background dan mendaftarkannya agar jalan saat laptop menyala,
   - menampilkan QR code untuk pairing.
3. Khusus Codex: buka Codex, jalankan `/hooks`, trust hook AgentMon (sekali saja).
4. Alternatif tanpa terminal: install extension AgentMon dari VS Code Marketplace atau Open VSX (untuk Antigravity, Cursor, Windsurf), lalu klik "Pair device".

### Di Android
1. Scan QR dari laptop dengan kamera, link terbuka di Chrome.
2. Ketuk "Install app" (atau menu titik tiga, lalu "Add to Home screen").
3. Buka app dari home screen, izinkan notifikasi. Selesai.

### Di iPhone / iPad
1. Scan QR, link terbuka di Safari.
2. Ketuk tombol Share, pilih "Add to Home Screen".
3. **Buka app dari ikon di home screen** (bukan dari Safari), lalu izinkan notifikasi. Push notification PWA di iOS hanya jalan dari app yang sudah ditambahkan ke home screen (iOS 16.4 ke atas).

App akan menampilkan panduan ini secara otomatis sesuai perangkat yang terdeteksi, supaya orang awam tidak bingung.

### Cara mencabut
- Dari HP: Pengaturan, Perangkat, Cabut.
- Dari laptop: `npx agentmon uninstall` mengembalikan konfigurasi hooks ke kondisi semula.

## 3. Tech stack yang direkomendasikan

Prinsip: satu bahasa (TypeScript) di semua bagian, ringan, gratis untuk MVP.

| Bagian | Pilihan | Alasan |
|---|---|---|
| Monorepo | pnpm workspaces | Sederhana, cepat, satu repo untuk semua bagian. |
| Kontrak pesan | Paket `shared` + Zod | Satu sumber kebenaran bentuk event, divalidasi di semua sisi. |
| Hook + daemon + CLI | Node.js (LTS) + TypeScript, dipublikasi ke npm | Bisa dijalankan dengan `npx`, lintas OS. |
| Checkpoint | git (lewat CLI git) | Snapshot sebelum aksi, rollback satu ketukan. |
| Relay server | Node.js + Hono + WebSocket | Hono ringan dan bisa dipindah ke Cloudflare Workers nanti tanpa tulis ulang besar. |
| Database | PostgreSQL (Neon, free tier) + Drizzle ORM | Riwayat sesi, perangkat, langganan push. |
| Push notification | Web Push standar (VAPID) | Gratis, jalan di Android dan iOS untuk PWA, tanpa Firebase. |
| App mobile | **PWA: Vite + React + TypeScript** | Ringan, tanpa app store, satu codebase untuk Android dan iOS. |
| UI | Tailwind CSS + komponen shadcn/ui | Cepat dibangun, tampilan rapi, mudah dark mode. |
| Data real-time di app | TanStack Query + WebSocket | Cache dan sinkronisasi yang rapi. |
| PWA tooling | vite-plugin-pwa | Service worker, manifest, offline. |
| Diff viewer | diff2html atau react-diff-view, highlight dimuat belakangan (lazy) | Tidak membuat bundle awal berat. |
| Enkripsi E2E (tahap 4) | libsodium | Server hanya meneruskan data terenkripsi. |
| Extension editor (tahap 8) | VS Code Extension API | Satu extension untuk VS Code, Antigravity, Cursor, Windsurf. |
| Hosting app | Cloudflare Pages atau Vercel (static) | Gratis, CDN cepat. |
| Hosting server | Render | Mudah. Catatan: free tier tidur saat idle, jadi untuk pemakaian serius pakai paket berbayar kecil, atau pindah ke Cloudflare Workers + Durable Objects. |

### Perubahan dari rencana awal
- App mobile memakai **Vite + React**, bukan Next.js. Alasannya: app ini sepenuhnya di sisi klien (tidak perlu SEO atau server rendering), jadi Vite menghasilkan app yang lebih ringan dan lebih sederhana.

### Kenapa PWA, bukan APK native, untuk sekarang
- Pasang lewat link, tanpa Play Store atau App Store.
- Ukuran kecil, update otomatis.
- Kalau nanti butuh masuk store, bungkus dengan Capacitor. Biaya store: Google Play sekali bayar, Apple Developer berlangganan tahunan.

## 4. Yang perlu kamu install dan siapkan sebelum mulai

### Software di laptop
- [ ] Node.js versi LTS terbaru
- [ ] pnpm
- [ ] Git
- [ ] VS Code dan Antigravity
- [ ] Claude Code versi terbaru (dan langganan yang aktif)
- [ ] Codex CLI v0.124 ke atas (opsional, untuk tahap 7)
- [ ] cloudflared (Cloudflare Tunnel) untuk membuka server lokal ke HP lewat HTTPS saat testing. Service worker dan push wajib HTTPS kalau bukan localhost.
- [ ] Google Chrome di laptop untuk debug PWA (DevTools, tab Application)

### Perangkat untuk testing
- [ ] HP Android dengan Chrome
- [ ] iPhone dengan iOS 16.4 ke atas, kalau ada (pinjam juga boleh, untuk tes push di iOS)

### Akun (semua ada free tier)
- [ ] GitHub (repo)
- [ ] Neon (PostgreSQL)
- [ ] Render (server)
- [ ] Cloudflare (Pages dan Tunnel) atau Vercel
- [ ] npm (untuk publish CLI)
- [ ] Nanti: publisher di VS Code Marketplace dan Open VSX
- [ ] Opsional: domain sendiri

### Ilmu yang perlu dipelajari dulu (urut)
1. TypeScript dasar sampai generics sederhana
2. Node.js: proses, stdin/stdout, membaca JSON dari stdin (cara hook bekerja)
3. Dokumentasi hooks Claude Code (PreToolUse, PermissionRequest, Stop, Notification)
4. WebSocket: koneksi, reconnect, heartbeat
5. Git dasar sampai stash dan commit sementara
6. Service Worker dan Web Push (VAPID)
7. PWA: manifest, install prompt, perilaku di iOS
8. Dasar keamanan: token, hashing, HTTPS

## 5. Urutan kerja pertama setelah persiapan selesai

1. Buat repo monorepo kosong dengan 4 folder (bridge, server, web, shared).
2. Tulis kontrak event di `shared`.
3. Hook Claude Code sederhana yang mencatat event ke file, untuk memahami bentuk data hook.
4. Daemon lokal yang menerima event dari hook dan menampilkannya di halaman web lokal.
5. Approve/deny dari halaman web yang benar-benar menahan hook.

Setiap langkah dikerjakan bersama dengan penjelasan konsep.
