// =====================================================================================
// FILE INI: penyusun ringkasan perubahan = "TUKANG RINGKAS" yang hanya menulis apa yang terbukti dari diff.
// =====================================================================================
//
// Masukan: hasil perhitungan diff (FileDiff). Keluaran: data ringkasan (shared/summary.ts) tanpa AI dan tanpa tebakan.
//
// ATURAN "TIDAK MENGKLAIM YANG TIDAK TERBUKTI":
//   - Angka (baris ditambah/dihapus, jumlah hunk) diambil langsung dari diff.
//   - Deklarasi dicantumkan HANYA bila BARIS deklarasinya sendiri ditambah atau dihapus. Fungsi yang badannya berubah
//     sementara baris deklarasinya tidak tersentuh TIDAK dicantumkan (butuh analisis ruang lingkup yang tidak bisa
//     dibuktikan dari baris diff), dan tidak ada tebakan "ganti nama": nama lama dan baru dicantumkan terpisah.
//   - Deteksi memakai pola per baris untuk beberapa bahasa. Bahasa lain, atau baris yang tidak cocok pola, tidak
//     menghasilkan deklarasi; ringkasan dasar (berkas dan angka) tetap ada.
import type { Declaration, DiffSummary, FileDiff, FileSummary } from "@agentmon/shared";

const MAX_FILES = 50;
const MAX_DECLARATIONS = 10;
const MAX_LINES_SCANNED = 20_000;

type Rule = { kind: Declaration["kind"]; re: RegExp };
type Language = { name: string; rules: Rule[] };

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const JS: Language = {
  name: "javascript",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(${IDENT})`) },
    { kind: "class", re: new RegExp(String.raw`^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(${IDENT})`) },
    // const nama = (...) => ... atau const nama = async x => ...
    { kind: "function", re: new RegExp(String.raw`^(?:export\s+)?(?:const|let|var)\s+(${IDENT})\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|${IDENT})\s*(?::[^=]+)?=>`) },
    { kind: "type", re: new RegExp(String.raw`^(?:export\s+)?(?:interface|type)\s+(${IDENT})\b`) },
  ],
};
const PYTHON: Language = {
  name: "python",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^(?:async\s+)?def\s+(${IDENT})`) },
    { kind: "class", re: new RegExp(String.raw`^class\s+(${IDENT})`) },
  ],
};
const GO: Language = {
  name: "go",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^func\s+(?:\([^)]*\)\s*)?(${IDENT})`) },
    { kind: "type", re: new RegExp(String.raw`^type\s+(${IDENT})\s+(?:struct|interface)\b`) },
  ],
};
const RUST: Language = {
  name: "rust",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(${IDENT})`) },
    { kind: "type", re: new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(${IDENT})`) },
  ],
};

const BY_EXTENSION: Record<string, Language> = {
  js: JS,
  jsx: JS,
  mjs: JS,
  cjs: JS,
  ts: JS,
  tsx: JS,
  mts: JS,
  cts: JS,
  py: PYTHON,
  go: GO,
  rs: RUST,
};

/** Bahasa yang dikenali dari akhiran nama berkas, atau undefined (ringkasan dasar saja). */
export function languageOfPath(path: string): Language | undefined {
  const name = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return BY_EXTENSION[ext];
}

// Nama deklarasi dari satu baris, atau undefined. Baris yang terlalu panjang diabaikan (mis. berkas minified).
function declarationOf(line: string, language: Language): { name: string; kind: Declaration["kind"] } | undefined {
  const text = line.trim();
  if (text.length === 0 || text.length > 400) return undefined;
  for (const rule of language.rules) {
    const m = rule.re.exec(text);
    if (m?.[1]) return { name: m[1].slice(0, 100), kind: rule.kind };
  }
  return undefined;
}

function summarizeFile(diff: FileDiff): FileSummary {
  const change = diff.change;
  const path = diff.path.slice(0, 1000);
  switch (change.type) {
    case "binary":
      return { path, change: "binary" };
    case "too_large":
      return { path, change: "too_large", ...(change.added !== undefined ? { added: change.added } : {}), ...(change.removed !== undefined ? { removed: change.removed } : {}) };
    case "mismatch":
      return { path, change: "mismatch" };
    case "unchanged":
      return { path, change: change.formatChanged ? "format_only" : "unchanged" };
    case "text": {
      const language = languageOfPath(diff.path);
      const summary: FileSummary = {
        path,
        change: change.isNew ? "new" : "modified",
        added: change.added,
        removed: change.removed,
        hunks: change.hunks.length,
        ...(language ? { language: language.name } : {}),
      };
      if (!language) return summary;

      // Nama -> di mana barisnya muncul. Kunci memuat jenis supaya "fungsi x" dan "kelas x" tidak tercampur.
      const seen = new Map<string, { name: string; kind: Declaration["kind"]; added: boolean; removed: boolean }>();
      let scanned = 0;
      scan: for (const hunk of change.hunks) {
        for (const line of hunk.lines) {
          if (line.type === "context") continue; // baris konteks tidak berubah: bukan bukti perubahan deklarasi
          if (++scanned > MAX_LINES_SCANNED) break scan;
          const found = declarationOf(line.text, language);
          if (!found) continue;
          const key = `${found.kind}:${found.name}`;
          const entry = seen.get(key) ?? { ...found, added: false, removed: false };
          if (line.type === "add") entry.added = true;
          else entry.removed = true;
          seen.set(key, entry);
        }
      }
      const all: Declaration[] = [...seen.values()].map((e) => ({ name: e.name, kind: e.kind, status: e.added && e.removed ? "changed" : e.added ? "added" : "removed" }));
      if (all.length > 0) summary.declarations = all.slice(0, MAX_DECLARATIONS);
      if (all.length > MAX_DECLARATIONS) summary.moreDeclarations = true;
      return summary;
    }
  }
}

/** Menyusun ringkasan dari satu atau beberapa diff. Tidak pernah melempar untuk diff yang sah. */
export function buildDiffSummary(diffs: FileDiff[]): DiffSummary {
  const files = diffs.slice(0, MAX_FILES).map(summarizeFile);
  return { files, ...(diffs.length > MAX_FILES ? { moreFiles: true } : {}) };
}
