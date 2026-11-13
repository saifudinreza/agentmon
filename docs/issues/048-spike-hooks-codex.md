---
title: "Spike: hooks Codex CLI dan fixture"
stage: "7"
size: S
labels: [spike, codex]
depends_on: [006]
---

# #048 Spike: hooks Codex CLI dan fixture

**Tahap 7: Codex** · Ukuran S · Bergantung pada: [#006](006-pemetaan-event-claude-code.md)

## Tujuan
Membuktikan cara kerja hook Codex yang asli, karena perilakunya berbeda dari Claude Code.

## Tahapan
1. Baca tabel perbandingan di PRD §11.
2. Buat hook pencatat dan kumpulkan fixture dari Codex nyata.
3. Uji setiap jenis keputusan, cara kembali ke alur normal, timeout, dan jalur umpan balik.
4. Uji kemungkinan terima sebagian dan penyampaian alasan ke model.
5. Uji apakah update AgentMon memaksa trust ulang.
6. Tulis temuan di `docs/hooks-codex.md`.

## Selesai bila
- [ ] Ada tabel kesetaraan fitur berdasarkan hasil uji.
- [ ] Fitur yang tidak bisa disamakan terdaftar beserta pilar yang terdampak.
- [ ] Ada cara kembali ke alur normal yang terbukti tidak meloloskan aksi.

**Perhatian:** menurut dokumentasi, `ask` di `PreToolUse` Codex membuat aksi tetap berjalan.

**Catatan dari issue 006:** `HookInput` di `server.ts` menuntut `hook_event_name` dan memakai `tool_name` untuk log. Periksa apakah Codex memakai kolom yang sama. Bila tidak, jadikan `HookInput` lebih longgar dan pindahkan validasi bentuk ke adapter masing-masing.
