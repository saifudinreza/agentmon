// =====================================================================================
// FILE INI: menghitung diff untuk SATU aksi agent (Write, Edit, atau MultiEdit).
// =====================================================================================
//
// Agent tidak mengirim "diff". Ia mengirim niatnya:
//   Write     -> "tulis isi ini ke berkas itu"        (isi LENGKAP yang baru)
//   Edit      -> "ganti teks X dengan Y di berkas itu" (old_string / new_string)
//   MultiEdit -> beberapa Edit berurutan pada satu berkas
// Supaya bisa ditampilkan dan direview, niat itu harus dibandingkan dengan isi berkas SEKARANG
// di laptop. Itulah tugas file ini:
//
//   1. baca isi berkas sekarang (dengan batas ukuran, dan tahan terhadap berkas aneh)
//   2. bayangkan hasil akhir bila aksi dijalankan (untuk Edit: terapkan penggantiannya)
//   3. bandingkan keduanya (text.ts)
//   4. tandai bila path-nya sensitif (sensitive.ts)
//
// Kasus sulit ditangani dengan hasil yang jelas, bukan error:
//   - berkas belum ada            -> berkas baru
//   - berkas biner / bukan UTF-8   -> "binary", isinya tidak ditampilkan
//   - berkas sangat besar          -> "too_large", hanya ringkasan; isinya TIDAK dibaca ke memori
//   - Edit yang tidak cocok        -> "mismatch" (teks yang dicari tidak ada, atau ada lebih dari satu)
//
// Fungsi ini tidak pernah melempar error dan tidak pernah mengubah apa pun di disk.
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FileChange, FileDiff } from "@agentmon/shared";
import { classifyPath } from "./sensitive";
import { diffText, splitLines, type TextDiffOptions } from "./text";

// Alat yang bisa dihitung diff-nya. Alat lain (Bash, PowerShell, NotebookEdit) tidak punya diff
// berkas yang bisa ditentukan dari inputnya, jadi hasilnya undefined.
const DIFFABLE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

// Batas ukuran berkas yang dibaca dan dibandingkan (1 MiB per sisi). Berkas yang lebih besar tidak
// pernah dibaca; hanya ukurannya yang dilaporkan.
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

// Berapa byte awal yang diperiksa untuk mencari tanda berkas biner (byte NUL).
const BINARY_SNIFF_BYTES = 8000;

export type ToolDiffInput = {
  toolName: string;
  toolInput: Record<string, unknown>;
  // Folder kerja agent: dasar untuk path relatif, dan batas "di dalam proyek".
  cwd?: string;
};

export type ToolDiffOptions = TextDiffOptions & { maxFileBytes?: number };

type Current =
  | { kind: "missing" }
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: number }
  | { kind: "too_large"; bytes: number }
  | { kind: "unreadable"; message: string };

const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// Membaca isi berkas sekarang, dengan semua penjagaan. Tidak pernah melempar error.
async function readCurrent(path: string, maxBytes: number): Promise<Current> {
  let size: number;
  try {
    const info = await stat(path);
    // Folder, pipa, dan perangkat khusus (misalnya /dev/zero) tidak boleh dibaca.
    if (!info.isFile()) return { kind: "unreadable", message: "Targetnya bukan berkas biasa." };
    size = info.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", message: code === "EACCES" || code === "EPERM" ? "Tidak punya izin membaca berkas." : "Berkas tidak bisa dibaca." };
  }
  // Periksa ukuran SEBELUM membaca, supaya berkas raksasa tidak pernah masuk memori.
  if (size > maxBytes) return { kind: "too_large", bytes: size };

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return { kind: "unreadable", message: "Berkas tidak bisa dibaca." };
  }
  // Berkas bisa membesar di antara pemeriksaan ukuran dan pembacaan; periksa lagi.
  if (buffer.length > maxBytes) return { kind: "too_large", bytes: buffer.length };

  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary", bytes: buffer.length };
  try {
    // fatal: true -> bukan UTF-8 yang sah berarti error, dan itu kita anggap biner.
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { kind: "binary", bytes: buffer.length };
  }
}

type EditStep = { oldString: string; newString: string; replaceAll: boolean };

// Mengambil daftar penggantian dari input alat. undefined bila bentuknya tidak dikenali.
function editsOf(toolName: string, input: Record<string, unknown>): EditStep[] | undefined {
  const one = (raw: unknown): EditStep | undefined => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const e = raw as Record<string, unknown>;
    const oldString = asText(e.old_string);
    const newString = asText(e.new_string);
    if (oldString === undefined || newString === undefined) return undefined;
    return { oldString, newString, replaceAll: e.replace_all === true };
  };
  if (toolName === "Edit") {
    const step = one(input);
    return step ? [step] : undefined;
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) return undefined;
  const steps = input.edits.map(one);
  return steps.every((s): s is EditStep => s !== undefined) ? (steps as EditStep[]) : undefined;
}

// Menghitung berapa kali `needle` muncul di `haystack` (tanpa tumpang tindih).
function countOccurrences(haystack: string, needle: string): number {
  // Teks kosong "ditemukan" di mana saja, dan pencarian berikutnya tidak pernah maju (loop tanpa
  // henti). Pemanggil sudah menangani old_string kosong, tetapi fungsi ini dijaga sendiri.
  if (needle === "") return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

type Applied = { ok: true; text: string } | { ok: false; change: Extract<FileChange, { type: "mismatch" }> };

/**
 * Menerapkan penggantian secara berurutan pada teks (akhir baris sudah diseragamkan ke LF).
 * Aturannya meniru Edit di Claude Code: teks yang dicari harus ada, dan harus tunggal kecuali
 * replace_all menyala.
 */
function applyEdits(text: string, steps: EditStep[], isNewFile: boolean): Applied {
  let current = text;
  for (const [index, step] of steps.entries()) {
    const editIndex = steps.length > 1 ? index : undefined;
    const fail = (reason: "old_string_not_found" | "old_string_ambiguous" | "old_string_empty", message: string): Applied => ({
      ok: false,
      change: { type: "mismatch", reason, message, ...(editIndex !== undefined ? { editIndex } : {}) },
    });

    if (step.oldString === "") {
      // old_string kosong hanya sah untuk MEMBUAT berkas baru (atau mengisi berkas kosong).
      if (isNewFile || current === "") {
        current = step.newString;
        continue;
      }
      return fail("old_string_empty", "Teks yang dicari kosong, tetapi berkasnya sudah berisi.");
    }
    const found = countOccurrences(current, step.oldString);
    if (found === 0) return fail("old_string_not_found", "Teks yang mau diganti tidak ditemukan di berkas ini.");
    if (found > 1 && !step.replaceAll) {
      return fail("old_string_ambiguous", `Teks yang mau diganti muncul ${found} kali, dan penggantian semua tidak diminta.`);
    }
    current = step.replaceAll ? current.split(step.oldString).join(step.newString) : current.replace(step.oldString, () => step.newString);
  }
  return { ok: true, text: current };
}

const toLf = (text: string) => text.replace(/\r\n/g, "\n");

/**
 * Menghitung diff untuk satu aksi agent. Mengembalikan undefined bila aksinya bukan perubahan
 * berkas yang bisa dihitung (alatnya bukan Write/Edit/MultiEdit, atau inputnya tidak lengkap).
 */
export async function computeToolDiff(input: ToolDiffInput, options: ToolDiffOptions = {}): Promise<FileDiff | undefined> {
  const { toolName, toolInput } = input;
  if (!DIFFABLE_TOOLS.has(toolName)) return undefined;
  const filePath = asText(toolInput.file_path);
  if (!filePath) return undefined;

  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const resolved = resolve(input.cwd ?? process.cwd(), filePath);
  const sensitive = classifyPath(resolved, input.cwd !== undefined ? { projectRoot: input.cwd } : {});
  const done = (change: FileChange): FileDiff => ({ path: filePath, toolName, sensitive, change });

  // --- Isi berkas sekarang ---
  const current = await readCurrent(resolved, maxBytes);
  if (current.kind === "unreadable") return done({ type: "mismatch", reason: "unreadable", message: current.message });
  if (current.kind === "binary") return done({ type: "binary", isNew: false, oldBytes: current.bytes });
  if (current.kind === "too_large") {
    return done({ type: "too_large", isNew: false, oldBytes: current.bytes, message: `Berkas lebih besar dari ${maxBytes} byte; isinya tidak dibandingkan.` });
  }
  const isNew = current.kind === "missing";
  const oldText = current.kind === "text" ? current.text : "";

  // --- Isi yang diusulkan ---
  let newText: string;
  if (toolName === "Write") {
    const content = asText(toolInput.content);
    if (content === undefined) return undefined;
    newText = content;
  } else {
    const steps = editsOf(toolName, toolInput);
    if (!steps) return undefined;
    // Edit pada berkas yang belum ada hanya sah bila ia membuat berkas (old_string kosong).
    if (isNew && !(steps.length === 1 && steps[0]?.oldString === "")) {
      return done({ type: "mismatch", reason: "file_missing", message: "Berkas yang mau diedit belum ada." });
    }
    // Edit dihitung pada teks dengan akhir baris seragam (LF): agent menulis teks pencarian dengan
    // LF, sedangkan berkas di Windows bisa CRLF.
    const applied = applyEdits(toLf(oldText), steps.map((s) => ({ ...s, oldString: toLf(s.oldString), newString: toLf(s.newString) })), isNew);
    if (!applied.ok) return done(applied.change);
    // Edit mempertahankan gaya akhir baris berkas yang ada.
    newText = splitLines(oldText).eol === "crlf" ? applied.text.replace(/\n/g, "\r\n") : applied.text;
  }

  const newBytes = Buffer.byteLength(newText);
  if (newBytes > maxBytes) {
    return done({ type: "too_large", isNew, ...(isNew ? {} : { oldBytes: Buffer.byteLength(oldText) }), newBytes, message: `Isi yang diusulkan lebih besar dari ${maxBytes} byte; tidak dibandingkan.` });
  }
  if (newText.includes("\0")) {
    return done({ type: "binary", isNew, ...(isNew ? {} : { oldBytes: Buffer.byteLength(oldText) }), newBytes });
  }

  // --- Perbandingan ---
  const result = diffText(oldText, newText, options);
  if (!result.ok) {
    return done({
      type: "too_large",
      isNew,
      oldLines: result.oldLines,
      newLines: result.newLines,
      added: result.added,
      removed: result.removed,
      message: "Terlalu banyak baris yang berbeda untuk dihitung rinci; hanya ringkasan.",
    });
  }
  const { format } = result;
  // Berkas baru selalu dilaporkan sebagai perubahan, termasuk berkas kosong tanpa hunk.
  if (result.hunks.length === 0 && !isNew) {
    const eolChanged = format.oldEol !== format.newEol && format.oldEol !== "none" && format.newEol !== "none";
    return done({ type: "unchanged", formatChanged: eolChanged || format.oldFinalNewline !== format.newFinalNewline, format });
  }
  return done({ type: "text", isNew, hunks: result.hunks, added: result.added, removed: result.removed, format });
}
