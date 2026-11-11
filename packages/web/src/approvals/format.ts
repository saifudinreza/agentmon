// =====================================================================================
// FILE INI: menampilkan isi permintaan izin = "KACA PEMBESAR" untuk apa yang akan disetujui pengguna.
// =====================================================================================
//
// PRINSIP: yang disetujui pengguna HARUS sama dengan yang dilihatnya. Karena itu karakter tak terlihat atau
// menyesatkan (kontrol, escape ANSI, pembalik arah tulisan) TIDAK dibuang diam-diam seperti di timeline;
// dibuang berarti pengguna menyetujui perintah yang tampak berbeda dari yang akan dijalankan. Di sini karakter
// itu diganti dengan kodenya yang terlihat (misalnya \u202e), sehingga ada yang mencolok mata.
import type { FileDiff } from "@agentmon/shared";

// Selain baris baru dan tab, semua karakter kontrol (C0, DEL, C1), pemisah baris Unicode, dan pembalik arah tulisan.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/gu;

/** Teks utuh dengan karakter berbahaya ditampilkan sebagai \uXXXX (baris baru dan tab dipertahankan). */
export function escapeUnsafe(text: string): string {
  return text.replace(UNSAFE, (ch) => {
    if (ch === "\n" || ch === "\t") return ch;
    return `\\u${ch.codePointAt(0)?.toString(16).padStart(4, "0")}`;
  });
}

export type InputField = {
  label: string;
  value: string;
  /** "shell" untuk perintah (ditonjolkan), "text" untuk teks biasa. */
  kind: "shell" | "text";
};

// Urutan tampil bidang yang dikenal; bidang lain menyusul menurut abjad.
const KNOWN_ORDER = ["command", "description", "file_path", "path", "notebook_path", "old_string", "new_string", "content", "pattern", "url", "query"];

const MAX_VALUE_CHARS = 20_000;

/** Isi permintaan sebagai daftar bidang yang bisa dibaca, perintah shell diutamakan dan ditampilkan UTUH. */
export function describeInput(toolName: string, toolInput: Record<string, unknown>): InputField[] {
  const keys = Object.keys(toolInput).sort((a, b) => {
    const ia = KNOWN_ORDER.indexOf(a);
    const ib = KNOWN_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((key) => {
    const raw = toolInput[key];
    const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) ?? String(raw);
    // Perintah shell (alat Bash) tidak dipotong sama sekali bila masih wajar: pengguna harus bisa membaca semuanya.
    const shown = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}\n…[${text.length - MAX_VALUE_CHARS} karakter lagi tidak ditampilkan]` : text;
    return { label: key, value: escapeUnsafe(shown), kind: key === "command" && /^bash$/i.test(toolName) ? "shell" : "text" };
  });
}

export type DiffView =
  | { kind: "text"; isNew: boolean; lines: string[]; hiddenLines: number }
  | { kind: "unchanged"; formatChanged: boolean }
  | { kind: "binary" }
  | { kind: "too_large"; message: string }
  | { kind: "mismatch"; message: string };

const MAX_DIFF_LINES = 1500;

/** Diff sebagai teks polos bergaya unified: "@@ -a,b +c,d @@" lalu baris berawalan +, -, atau spasi. */
export function formatDiff(diff: FileDiff): DiffView {
  const change = diff.change;
  switch (change.type) {
    case "text": {
      const lines: string[] = [];
      for (const hunk of change.hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        for (const line of hunk.lines) {
          const mark = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
          lines.push(`${mark}${escapeUnsafe(line.text)}`);
        }
      }
      return { kind: "text", isNew: change.isNew, lines: lines.slice(0, MAX_DIFF_LINES), hiddenLines: Math.max(0, lines.length - MAX_DIFF_LINES) };
    }
    case "unchanged":
      return { kind: "unchanged", formatChanged: change.formatChanged };
    case "binary":
      return { kind: "binary" };
    case "too_large":
      return { kind: "too_large", message: escapeUnsafe(change.message) };
    case "mismatch":
      return { kind: "mismatch", message: escapeUnsafe(change.message) };
  }
}
