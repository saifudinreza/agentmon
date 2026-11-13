---
title: "Adapter Codex"
stage: "7"
size: M
labels: [feature, bridge, codex]
depends_on: [008, 048]
---

# #049 Adapter Codex

**Tahap 7: Codex** · Ukuran M · Bergantung pada: [#008](008-hook-menahan-keputusan.md), [#048](048-spike-hooks-codex.md)

## Tujuan
Membuat Codex CLI didukung dengan pola adapter yang sama seperti Claude Code.

## Tahapan
1. Buat adapter Codex memakai fixture dari [#048](048-spike-hooks-codex.md).
2. Terjemahkan keputusan ke format Codex.
3. Dukung format patch Codex untuk diff dan penilaian risiko.
4. Terapkan pilar lain sejauh terbukti di [#048](048-spike-hooks-codex.md).
5. Sembunyikan fitur yang tidak didukung di UI, dan tampilkan label agent di timeline.

## Selesai bila
- [ ] Skenario setuju, tolak, batas waktu, dan selesai lolos dengan Codex nyata.
- [ ] Test membuktikan adapter tidak pernah mengembalikan `ask` pada `PreToolUse`.
- [ ] Inti daemon tidak berubah, kecuali untuk perbedaan kemampuan.

**Rujukan:** PRD §11, FR-5.
