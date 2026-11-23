# Daftar Issue AgentMon

Rincian kerja dari [PRD](../../PRD.md). Kerjakan berurutan per tahap. Sebuah issue siap dikerjakan bila semua dependensinya selesai.

**Cara memakai:** setiap issue berisi tujuan, tahapan, dan kriteria selesai secara high-level. Pelaksana (programmer junior atau model AI) menentukan detail implementasinya sendiri, dengan PRD sebagai rujukan. Bagian **Perhatian** wajib dipatuhi.

**Test:** setiap issue yang menambah kode menyertakan test, dan `pnpm check` harus lolos di CI. Issue yang menyangkut keamanan atau keputusan approval (007, 008, 022, 023, 030, 033, 034, 036, 037) punya bagian **Test wajib** yang tidak boleh dilewati. *Uji mutasi* berarti merusak kode dengan sengaja untuk memastikan test-nya benar-benar gagal, lalu mengembalikannya.

**Ukuran:** S = kecil, M = sedang, L = besar. Ini ukuran relatif, bukan estimasi waktu.

**Label pembeda:** `pilar-1` risiko dan kebijakan, `pilar-2` review ramah HP, `pilar-3` checkpoint dan rollback.

## Tahap 0: Fondasi

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 001 | [Inisialisasi monorepo pnpm](001-inisialisasi-monorepo.md) | S | - |
| 002 | [Kontrak event di paket shared](002-kontrak-event-shared.md) | S | 001 |
| 003 | [Spike: hook logger Claude Code dan fixture](003-spike-hook-logger-claude-code.md) | S | 001 |

## Tahap 1: Loop lokal

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 004 | [Daemon lokal dasar](004-daemon-lokal-dasar.md) | M | 002 |
| 005 | [Hook http ke daemon dengan perilaku anti-macet](005-hook-runner-fail-open.md) | S | 003, 004 |
| 006 | [Pemetaan event Claude Code ke kontrak](006-pemetaan-event-claude-code.md) | S | 005 |
| 007 | [Approval engine di daemon](007-approval-engine.md) | M | 004 |
| 008 | [Hook menahan eksekusi dan mengembalikan keputusan](008-hook-menahan-keputusan.md) | M | 005, 006, 007 |
| 009 | [Kalkulator diff di daemon](009-kalkulator-diff.md) | M | 006 |
| 010 | [Halaman web lokal untuk timeline dan approve/deny](010-web-lokal-approve-deny.md) | S | 008, 009 |

## Tahap 2: Relay & PWA

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 011 | [Relay server dasar (Hono + WebSocket)](011-relay-server-dasar.md) | M | 002 |
| 012 | [Skema database dan migrasi](012-skema-database.md) | S | 011 |
| 013 | [Pairing laptop dan HP lewat QR](013-pairing-qr.md) | M | 012 |
| 014 | [Klien relay di daemon](014-klien-relay-daemon.md) | M | 008, 011, 013 |
| 015 | [PWA shell](015-pwa-shell.md) | S | 001 |
| 016 | [Layar pairing di PWA](016-layar-pairing-pwa.md) | S | 013, 015 |
| 017 | [Daftar sesi dan timeline real-time](017-timeline-realtime.md) | M | 012, 014, 016 |
| 018 | [Approve dan deny dari HP](018-approve-deny-remote.md) | M | 017 |
| 019 | [Status online perangkat dan langsung ke alur normal](019-presence-perangkat.md) | S | 018 |
| 020 | [Daftar dan cabut perangkat](020-cabut-perangkat.md) | S | 016 |
| 021 | [Deploy staging relay dan PWA](021-deploy-staging.md) | S | 012, 015 |

## Tahap 2.5: Checkpoint (Pilar 3)

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 022 | [Checkpoint git otomatis](022-checkpoint-git.md) | M | 008 |
| 023 | [Rollback dari HP](023-rollback-dari-hp.md) | M | 018, 022 |

## Tahap 3: Diff & push

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 024 | [Diff viewer untuk layar HP](024-diff-viewer-mobile.md) | M | 018 |
| 025 | [Ringkasan deterministik di atas diff](025-ringkasan-deterministik.md) | S | 009, 024 |
| 026 | [Backend Web Push (VAPID)](026-web-push-backend.md) | S | 012 |
| 027 | [Service worker dan izin notifikasi](027-service-worker-notifikasi.md) | M | 015, 016, 026 |
| 028 | [Pemicu notifikasi izin dan selesai](028-pemicu-notifikasi.md) | S | 018, 027 |
| 029 | [Uji perangkat nyata tahap 3](029-uji-perangkat-nyata.md) | S | 024, 028 |

## Tahap 3.5: Risiko (Pilar 1)

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 030 | [Penilai risiko berbasis aturan](030-penilai-risiko.md) | M | 009, 018 |
| 031 | [Tampilkan risiko di HP dan urutkan antrean](031-risiko-di-hp.md) | S | 028, 030 |

## Tahap 4: E2E

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 032 | [Desain E2E dan threat model](032-desain-e2e-threat-model.md) | M | 018 |
| 033 | [Enkripsi payload daemon dan PWA](033-enkripsi-payload.md) | L | 032 |
| 034 | [Tanda tangan keputusan dan perlindungan replay](034-keputusan-ditandatangani.md) | M | 033 |
| 035 | [Minimasi data di relay](035-minimasi-data-server.md) | S | 033 |

## Tahap 4.5: Policy (Pilar 1)

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 036 | [Policy engine](036-policy-engine.md) | M | 030 |
| 037 | [Sambungkan policy ke alur hook](037-integrasi-policy-hook.md) | M | 022, 034, 036 |
| 038 | [Lihat aturan dan saran aturan di HP](038-policy-di-hp.md) | S | 037 |

## Tahap 5: Review per hunk (Pilar 2)

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 039 | [Terima sebagian dan umpan balik ke agent](039-terima-sebagian-umpan-balik.md) | L | 009, 034 |
| 040 | [Mode swipe per hunk](040-swipe-review.md) | M | 024, 031, 039 |
| 041 | [Rekap sesi dan review per giliran](041-rekap-dan-review-giliran.md) | M | 023, 037, 040 |
| 042 | [Ringkasan dan pengelompokan per maksud berbasis AI](042-ringkasan-ai-lokal.md) | M | 041 |

## Tahap 6: Instalasi & rilis

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 043 | [Perintah agentmon setup](043-perintah-setup.md) | L | 008, 013 |
| 044 | [Autostart daemon lintas OS](044-autostart-daemon.md) | M | 043 |
| 045 | [Perintah agentmon uninstall](045-perintah-uninstall.md) | S | 043, 044 |
| 046 | [Panduan install otomatis per perangkat](046-onboarding-per-perangkat.md) | S | 027 |
| 047 | [Rilis beta publik](047-rilis-beta-publik.md) | M | 023, 031, 035, 038, 040, 041, 045, 046 |

## Tahap 7: Codex

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 048 | [Spike: hooks Codex CLI dan fixture](048-spike-hooks-codex.md) | S | 006 |
| 049 | [Adapter Codex](049-adapter-codex.md) | M | 008, 048 |
| 050 | [Setup dan uninstall Codex](050-setup-codex.md) | S | 045, 049 |

## Tahap 8: Extension

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 051 | [Extension editor](051-extension-editor.md) | M | 047 |
| 052 | [Publikasi extension ke Marketplace dan Open VSX](052-publikasi-extension.md) | S | 051 |

## Backlog: Pembeda tambahan

| # | Issue | Ukuran | Bergantung pada |
|---|---|---|---|
| 053 | [Backlog: approval lewat Telegram, Discord, WhatsApp](053-approval-lewat-chat.md) | L | 047 |
| 054 | [Backlog: hemat data dan antrean keputusan](054-hemat-data.md) | M | 047 |
| 055 | [Backlog: self-host relay dengan satu perintah](055-self-host.md) | M | 047 |
| 056 | [Backlog: second opinion dari agent kedua](056-second-opinion.md) | M | 042, 047 |
