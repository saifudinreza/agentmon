import { DiffSummarySchema, type DiffHunk, type FileDiff } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { buildDiffSummary, languageOfPath } from "./diff-summary";

const format = { oldEol: "lf", newEol: "lf", oldFinalNewline: true, newFinalNewline: true } as const;
type L = ["add" | "remove" | "context", string];
const hunk = (lines: L[], id = "h1"): DiffHunk => ({
  id,
  oldStart: 1,
  oldLines: lines.filter(([t]) => t !== "add").length,
  newStart: 1,
  newLines: lines.filter(([t]) => t !== "remove").length,
  lines: lines.map(([type, text]) => ({ type, text })),
});
const textDiff = (path: string, hunks: DiffHunk[], isNew = false): FileDiff => ({
  path,
  toolName: "Edit",
  sensitive: [],
  change: {
    type: "text",
    isNew,
    hunks,
    added: hunks.flatMap((h) => h.lines).filter((l) => l.type === "add").length,
    removed: hunks.flatMap((h) => h.lines).filter((l) => l.type === "remove").length,
    format,
  },
});
const only = (diff: FileDiff) => buildDiffSummary([diff]).files[0]!;

describe("ringkasan dasar", () => {
  test("berkas, jumlah baris, dan jumlah hunk diambil langsung dari diff", () => {
    const summary = only(textDiff("src/a.ts", [hunk([["remove", "a"], ["add", "b"], ["add", "c"]]), hunk([["add", "d"]], "h2")]));
    expect(summary).toMatchObject({ path: "src/a.ts", change: "modified", added: 3, removed: 1, hunks: 2 });
  });

  test("berkas baru ditandai", () => {
    expect(only(textDiff("baru.ts", [hunk([["add", "x"]])], true))).toMatchObject({ change: "new", added: 1, removed: 0 });
  });

  test("bahasa yang tidak dikenali tetap menghasilkan ringkasan dasar, tanpa deklarasi dan tanpa tebakan", () => {
    const summary = only(textDiff("catatan.txt", [hunk([["add", "function bukanKode() {}"], ["add", "def juga_bukan():"]])]));
    expect(summary).toMatchObject({ path: "catatan.txt", change: "modified", added: 2, removed: 0, hunks: 1 });
    expect(summary.language).toBeUndefined();
    expect(summary.declarations).toBeUndefined();
  });

  test("jenis non-teks: biner, tidak berubah, hanya format, terlalu besar, tidak cocok", () => {
    const base = { path: "x", toolName: "Write", sensitive: [] };
    expect(only({ ...base, change: { type: "binary", isNew: false } })).toEqual({ path: "x", change: "binary" });
    expect(only({ ...base, change: { type: "unchanged", formatChanged: false, format } })).toEqual({ path: "x", change: "unchanged" });
    expect(only({ ...base, change: { type: "unchanged", formatChanged: true, format } })).toEqual({ path: "x", change: "format_only" });
    expect(only({ ...base, change: { type: "too_large", isNew: false, message: "m", added: 5, removed: 2 } })).toEqual({ path: "x", change: "too_large", added: 5, removed: 2 });
    expect(only({ ...base, change: { type: "mismatch", reason: "file_missing", message: "m" } })).toEqual({ path: "x", change: "mismatch" });
  });

  test("banyak berkas dibatasi 50 dan ditandai moreFiles; hasilnya selalu lolos skema bersama", () => {
    const diffs = Array.from({ length: 60 }, (_, i) => textDiff(`f${i}.ts`, [hunk([["add", "x"]])]));
    const summary = buildDiffSummary(diffs);
    expect(summary.files).toHaveLength(50);
    expect(summary.moreFiles).toBe(true);
    expect(DiffSummarySchema.safeParse(summary).success).toBe(true);
  });
});

describe("deteksi deklarasi: hanya dari baris yang BERUBAH", () => {
  test("fungsi ditambah, dihapus, dan diubah (nama sama di baris dihapus dan ditambah)", () => {
    const summary = only(
      textDiff("src/a.ts", [
        hunk([
          ["remove", "export function lama(a: number) {"],
          ["add", "export function baru(a: number) {"],
          ["remove", "function sama(x) {"],
          ["add", "function sama(x, y) {"],
          ["add", "export const panah = async (a) => a + 1;"],
        ]),
      ]),
    );
    expect(summary.language).toBe("javascript");
    expect(summary.declarations).toEqual(
      expect.arrayContaining([
        { name: "lama", kind: "function", status: "removed" },
        { name: "baru", kind: "function", status: "added" },
        { name: "sama", kind: "function", status: "changed" },
        { name: "panah", kind: "function", status: "added" },
      ]),
    );
    expect(summary.declarations).toHaveLength(4);
  });

  test("tidak ada klaim 'ganti nama': nama lama dan baru dicantumkan terpisah", () => {
    const summary = only(textDiff("a.ts", [hunk([["remove", "function a() {}"], ["add", "function b() {}"]])]));
    expect(summary.declarations).toEqual([
      { name: "a", kind: "function", status: "removed" },
      { name: "b", kind: "function", status: "added" },
    ]);
  });

  test("deklarasi di baris KONTEKS (tidak berubah) tidak dicantumkan, walau badannya berubah", () => {
    const summary = only(textDiff("a.ts", [hunk([["context", "function tidakBerubah() {"], ["remove", "  return 1;"], ["add", "  return 2;"], ["context", "}"]])]));
    expect(summary.declarations).toBeUndefined();
  });

  test("teks yang mirip deklarasi di dalam string atau komentar tidak dihitung", () => {
    const summary = only(textDiff("a.ts", [hunk([["add", '  const s = "function palsu() {}";'], ["add", "  // function komentar() {}"], ["add", "  x = { type: 'a' };"]])]));
    expect(summary.declarations).toBeUndefined();
  });

  test("kelas dan tipe; kelas bernama sama dengan fungsi tidak tercampur", () => {
    const summary = only(textDiff("a.ts", [hunk([["add", "export class Foo {"], ["add", "function Foo() {}"], ["add", "export interface Opsi {"], ["add", "type Hasil = string;"]])]));
    expect(summary.declarations).toEqual([
      { name: "Foo", kind: "class", status: "added" },
      { name: "Foo", kind: "function", status: "added" },
      { name: "Opsi", kind: "type", status: "added" },
      { name: "Hasil", kind: "type", status: "added" },
    ]);
  });

  test("Python, Go, dan Rust", () => {
    expect(only(textDiff("m.py", [hunk([["add", "async def ambil(x):"], ["add", "class Baru:"]])])).declarations).toEqual([
      { name: "ambil", kind: "function", status: "added" },
      { name: "Baru", kind: "class", status: "added" },
    ]);
    expect(only(textDiff("m.go", [hunk([["add", "func (s *Server) Jalan() error {"], ["add", "type Opsi struct {"]])])).declarations).toEqual([
      { name: "Jalan", kind: "function", status: "added" },
      { name: "Opsi", kind: "type", status: "added" },
    ]);
    expect(only(textDiff("m.rs", [hunk([["add", "pub async fn proses() {"], ["add", "pub struct Data {"]])])).declarations).toEqual([
      { name: "proses", kind: "function", status: "added" },
      { name: "Data", kind: "type", status: "added" },
    ]);
  });

  test("lebih dari 10 deklarasi: dipotong dan ditandai", () => {
    const lines: L[] = Array.from({ length: 14 }, (_, i) => ["add", `function f${i}() {}`]);
    const summary = only(textDiff("a.ts", [hunk(lines)]));
    expect(summary.declarations).toHaveLength(10);
    expect(summary.moreDeclarations).toBe(true);
  });

  test("baris sangat panjang diabaikan (minified) dan tidak membuat penyusun lambat", () => {
    const started = performance.now();
    const summary = only(textDiff("a.ts", [hunk([["add", "function x(){" + "a=1;".repeat(1000) + "}"]])]));
    expect(summary.declarations).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("nama dengan karakter berbahaya tidak lolos (hanya pengenal biasa)", () => {
    const summary = only(textDiff("a.ts", [hunk([["add", "function a\u202eb() {}"]])]));
    for (const d of summary.declarations ?? []) expect(d.name).toMatch(/^[A-Za-z_$][\w$]*$/);
  });
});

describe("languageOfPath", () => {
  test.each([
    ["a.ts", "javascript"],
    ["Komponen.TSX", "javascript"],
    ["x.py", "python"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    [String.raw`C:\p\a.py`, "python"],
  ])("%s -> %s", (path, name) => expect(languageOfPath(path)?.name).toBe(name));

  test("akhiran lain tidak dikenal", () => {
    for (const path of ["a.txt", "README", "a.java", "Makefile", "a.ts.bak"]) expect(languageOfPath(path)).toBeUndefined();
  });
});
