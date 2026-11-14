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
//   - BATAS YANG DISADARI: pola per baris tidak tahu apakah sebuah baris berada di dalam template literal, komentar
//     blok, docstring, atau teks JSX yang berbaris-baris; baris di sana yang menyerupai deklarasi bisa tercantum.
//     Sebaliknya, bentuk yang tidak dikenali pola (method kelas, fungsi anonim yang ditugaskan, dan sebagainya) tidak
//     tercantum. Karena itu tampilan menyebut daftar ini "yang dikenali" dan memberi catatan, dan daftar kosong BUKAN
//     bukti tidak ada deklarasi yang berubah.
import type { Declaration, DiffSummary, FileDiff, FileSummary } from "@agentmon/shared";

const MAX_FILES = 50;
const MAX_DECLARATIONS = 10;
const MAX_LINES_SCANNED = 20_000;

// `name` = nomor grup nama; `scope` = nomor grup lingkup (mis. receiver Go) yang ikut menjadi kunci, supaya
// `(a *A) Run` dan `(b *B) Run` tidak dianggap fungsi yang sama.
type Rule = { kind: Declaration["kind"]; re: RegExp; name?: number; scope?: number };
type Language = { name: string; rules: Rule[] };

// Nama diikuti batas: bukan karakter pengenal dan bukan karakter non-ASCII. Tanpa ini, "café" terbaca "caf".
const IDENT = String.raw`([A-Za-z_$][\w$]*)(?![\w$]|[^\x00-\x7F])`;
const JS: Language = {
  name: "javascript",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*\s*|\s+)${IDENT}`) },
    { kind: "class", re: new RegExp(String.raw`^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+${IDENT}`) },
    // const nama = (...) => ... atau const nama = async x => ...
    { kind: "function", re: new RegExp(String.raw`^(?:export\s+)?(?:const|let|var)\s+${IDENT}\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|${IDENT})\s*(?::[^=]+)?=>`) },
    { kind: "type", re: new RegExp(String.raw`^(?:export\s+)?(?:interface|type)\s+${IDENT}\b`) },
  ],
};
const PYTHON: Language = {
  name: "python",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^(?:async\s+)?def\s+${IDENT}`) },
    { kind: "class", re: new RegExp(String.raw`^class\s+${IDENT}`) },
  ],
};
const GO: Language = {
  name: "go",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^func\s+(?:\(([^)]*)\)\s*)?${IDENT}`), name: 2, scope: 1 },
    { kind: "type", re: new RegExp(String.raw`^type\s+${IDENT}\s+(?:struct|interface)\b`) },
  ],
};
const RUST: Language = {
  name: "rust",
  rules: [
    { kind: "function", re: new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+${IDENT}`) },
    { kind: "type", re: new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+${IDENT}`) },
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
function declarationOf(line: string, language: Language): { name: string; kind: Declaration["kind"]; scope: string } | undefined {
  const text = line.trim();
  if (text.length === 0 || text.length > 400) return undefined;
  for (const rule of language.rules) {
    const m = rule.re.exec(text);
    const name = m?.[rule.name ?? 1];
    if (m && name) return { name: name.slice(0, 100), kind: rule.kind, scope: ((rule.scope ? m[rule.scope] : "") ?? "").replace(/\s+/g, " ").trim() };
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
      const seen = new Map<string, { name: string; kind: Declaration["kind"]; added: boolean; removed: boolean; addedTexts: Set<string>; removedTexts: Set<string> }>();
      let scanned = 0;
      scan: for (const hunk of change.hunks) {
        for (const line of hunk.lines) {
          if (line.type === "context") continue; // baris konteks tidak berubah: bukan bukti perubahan deklarasi
          if (++scanned > MAX_LINES_SCANNED) break scan;
          const found = declarationOf(line.text, language);
          if (!found) continue;
          const key = `${found.kind}:${found.scope}:${found.name}`;
          const entry = seen.get(key) ?? { name: found.name, kind: found.kind, added: false, removed: false, addedTexts: new Set<string>(), removedTexts: new Set<string>() };
          const normalized = line.text.replace(/\s+/g, " ").trim();
          if (line.type === "add") {
            entry.added = true;
            entry.addedTexts.add(normalized);
          } else {
            entry.removed = true;
            entry.removedTexts.add(normalized);
          }
          seen.set(key, entry);
        }
      }
      // Baris deklarasi yang sama persis di sisi dihapus dan ditambah (hanya pindah tempat atau indentasi) tidak
      // membuktikan deklarasinya berubah, jadi tidak dicantumkan.
      const sameText = (e: { addedTexts: Set<string>; removedTexts: Set<string> }) => e.addedTexts.size === e.removedTexts.size && [...e.addedTexts].every((t) => e.removedTexts.has(t));
      const all: Declaration[] = [...seen.values()]
        .filter((e) => !(e.added && e.removed && sameText(e)))
        .map((e) => ({ name: e.name, kind: e.kind, status: e.added && e.removed ? "changed" : e.added ? "added" : "removed" }));
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
