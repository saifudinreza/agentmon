import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileDiffSchema, type DiffHunk, type FileChange, type FileDiff } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { computeToolDiff } from "./tool";

// readFile dibungkus supaya test bisa membuktikan berkas raksasa TIDAK PERNAH dibaca ke memori.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentmon-diff-"));
  vi.mocked(readFile).mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (name: string, content: string | Buffer) => {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const read = (name: string) => readFileSync(join(dir, name), "utf8");

// Menjalankan kalkulator dan memastikan hasilnya selalu sesuai kontrak di paket shared.
async function diffOf(toolName: string, toolInput: Record<string, unknown>, options = {}) {
  const result = await computeToolDiff({ toolName, toolInput, cwd: dir }, options);
  if (result) expect(FileDiffSchema.safeParse(result).success, JSON.stringify(result).slice(0, 300)).toBe(true);
  return result;
}
const changeOf = (diff: FileDiff | undefined): FileChange => {
  if (!diff) throw new Error("seharusnya ada diff");
  return diff.change;
};
const textChange = (diff: FileDiff | undefined) => {
  const change = changeOf(diff);
  if (change.type !== "text") throw new Error(`seharusnya text, bukan ${change.type}`);
  return change;
};

// Menerapkan hunk ke teks lama: harus menghasilkan teks usulan. Pembuktian kebenaran yang
// tidak bergantung pada bentuk hunk.
function applyHunks(oldText: string, hunks: DiffHunk[]): string {
  const old = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const from = hunk.oldLines > 0 ? hunk.oldStart - 1 : hunk.oldStart;
    while (cursor < from) out.push(old[cursor++] as string);
    for (const line of hunk.lines) {
      if (line.type === "context") out.push(old[cursor++] as string);
      else if (line.type === "remove") cursor++;
      else out.push(line.text);
    }
  }
  while (cursor < old.length) out.push(old[cursor++] as string);
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

describe("Write", () => {
  test("berkas baru: semua baris ditambah, ditandai isNew", async () => {
    const change = textChange(await diffOf("Write", { file_path: "baru.txt", content: "satu\ndua\ntiga\n" }));
    expect(change).toMatchObject({ isNew: true, added: 3, removed: 0 });
    expect(change.hunks).toHaveLength(1);
    expect(change.hunks[0]?.lines.every((l) => l.type === "add")).toBe(true);
  });

  test("berkas baru yang kosong tetap dilaporkan sebagai perubahan (tanpa hunk)", async () => {
    expect(textChange(await diffOf("Write", { file_path: "kosong.txt", content: "" }))).toMatchObject({ isNew: true, hunks: [], added: 0 });
  });

  test("menimpa berkas yang ada dengan banyak hunk: menerapkan hunk ke isi lama menghasilkan isi baru", async () => {
    const oldLines = Array.from({ length: 60 }, (_, i) => `baris ${i + 1}`);
    const newLines = [...oldLines];
    newLines[4] = "LIMA";
    newLines[30] = "TIGA PULUH SATU";
    newLines.splice(50, 2); // hapus dua baris
    newLines.push("baris tambahan");
    const oldText = `${oldLines.join("\n")}\n`;
    const newText = `${newLines.join("\n")}\n`;
    put("a.txt", oldText);

    const change = textChange(await diffOf("Write", { file_path: "a.txt", content: newText }));
    expect(change.hunks.length).toBeGreaterThanOrEqual(3);
    expect(change.isNew).toBe(false);
    expect(applyHunks(oldText, change.hunks)).toBe(newText);
  });

  test("isi sama: unchanged", async () => {
    put("a.txt", "sama\n");
    expect(changeOf(await diffOf("Write", { file_path: "a.txt", content: "sama\n" }))).toMatchObject({ type: "unchanged", formatChanged: false });
  });

  test("tidak mengubah apa pun di disk", async () => {
    put("a.txt", "asli\n");
    await diffOf("Write", { file_path: "a.txt", content: "ubah\n" });
    await diffOf("Write", { file_path: "baru.txt", content: "x\n" });
    expect(read("a.txt")).toBe("asli\n");
    expect(() => read("baru.txt")).toThrow(); // berkas baru tidak dibuat
  });

  test("path relatif diselesaikan terhadap cwd, path absolut dipakai apa adanya", async () => {
    const path = put("sub/a.txt", "lama\n");
    const viaRelative = textChange(await diffOf("Write", { file_path: "sub/a.txt", content: "baru\n" }));
    const viaAbsolute = textChange(await diffOf("Write", { file_path: path, content: "baru\n" }));
    expect(viaRelative).toMatchObject({ isNew: false, added: 1, removed: 1 });
    expect(viaAbsolute).toMatchObject({ isNew: false, added: 1, removed: 1 });
  });

  test("folder induk belum ada: tetap berkas baru", async () => {
    expect(textChange(await diffOf("Write", { file_path: "belum/ada/a.txt", content: "x\n" }))).toMatchObject({ isNew: true });
  });
});

describe("Edit", () => {
  test("fixture asli Edit pada berkas seed: satu hunk, satu baris diganti", async () => {
    const seed = fileURLToPath(new URL("../../../../tools/hook-spike/seed/app.ts", import.meta.url));
    put("app.ts", readFileSync(seed));
    const fixture = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../fixtures/claude-code/PreToolUse.Edit.json", import.meta.url)), "utf8"),
    ) as { tool_input: Record<string, unknown> };

    const change = textChange(await diffOf("Edit", { ...fixture.tool_input, file_path: "app.ts" }));
    expect(change).toMatchObject({ isNew: false, added: 1, removed: 1 });
    expect(change.hunks).toHaveLength(1);
    const lines = change.hunks[0]?.lines ?? [];
    expect(lines.find((l) => l.type === "remove")?.text).toContain("Halo");
    expect(lines.find((l) => l.type === "add")?.text).toContain("Hai");
  });

  test("hasilnya sama dengan menerapkan penggantian secara manual", async () => {
    const oldText = "a\nb\nc\nd\ne\n";
    put("a.txt", oldText);
    const change = textChange(await diffOf("Edit", { file_path: "a.txt", old_string: "c", new_string: "C1\nC2" }));
    expect(applyHunks(oldText, change.hunks)).toBe("a\nb\nC1\nC2\nd\ne\n");
    expect(change).toMatchObject({ added: 2, removed: 1 });
  });

  test("teks yang dicari tidak ada -> mismatch", async () => {
    put("a.txt", "isi\n");
    expect(changeOf(await diffOf("Edit", { file_path: "a.txt", old_string: "tidak ada", new_string: "x" }))).toMatchObject({
      type: "mismatch",
      reason: "old_string_not_found",
    });
  });

  test("teks yang dicari muncul beberapa kali tanpa replace_all -> mismatch ambigu, dengan replace_all -> semua diganti", async () => {
    put("a.txt", "x\ny\nx\n");
    const ambiguous = changeOf(await diffOf("Edit", { file_path: "a.txt", old_string: "x", new_string: "z" }));
    expect(ambiguous).toMatchObject({ type: "mismatch", reason: "old_string_ambiguous" });
    expect((ambiguous as { message: string }).message).toContain("2 kali");

    const all = textChange(await diffOf("Edit", { file_path: "a.txt", old_string: "x", new_string: "z", replace_all: true }));
    expect(all).toMatchObject({ added: 2, removed: 2 });
  });

  test("old_string kosong pada berkas yang sudah berisi -> mismatch; pada berkas yang belum ada -> membuat berkas", async () => {
    put("a.txt", "isi\n");
    expect(changeOf(await diffOf("Edit", { file_path: "a.txt", old_string: "", new_string: "x" }))).toMatchObject({
      type: "mismatch",
      reason: "old_string_empty",
    });
    expect(textChange(await diffOf("Edit", { file_path: "baru.txt", old_string: "", new_string: "halo\n" }))).toMatchObject({ isNew: true, added: 1 });
  });

  test("Edit pada berkas yang belum ada -> mismatch file_missing", async () => {
    expect(changeOf(await diffOf("Edit", { file_path: "tidak-ada.txt", old_string: "a", new_string: "b" }))).toMatchObject({
      type: "mismatch",
      reason: "file_missing",
    });
  });

  test("karakter khusus pada teks pengganti ($&, $1) dipakai apa adanya", async () => {
    put("a.txt", "harga: X\n");
    const change = textChange(await diffOf("Edit", { file_path: "a.txt", old_string: "X", new_string: "$& dan $1 dan $$" }));
    expect(change.hunks[0]?.lines.find((l) => l.type === "add")?.text).toBe("harga: $& dan $1 dan $$");
  });

  test("tidak mengubah berkas di disk", async () => {
    put("a.txt", "lama\n");
    await diffOf("Edit", { file_path: "a.txt", old_string: "lama", new_string: "baru" });
    expect(read("a.txt")).toBe("lama\n");
  });
});

describe("MultiEdit", () => {
  test("penggantian berurutan: yang kedua boleh bergantung pada hasil yang pertama", async () => {
    const oldText = "satu\ndua\n";
    put("a.txt", oldText);
    const change = textChange(
      await diffOf("MultiEdit", {
        file_path: "a.txt",
        edits: [
          { old_string: "satu", new_string: "SATU" },
          { old_string: "SATU", new_string: "Satu!" }, // hanya ada setelah edit pertama
        ],
      }),
    );
    expect(applyHunks(oldText, change.hunks)).toBe("Satu!\ndua\n");
  });

  test("edit yang gagal melaporkan nomor edit-nya", async () => {
    put("a.txt", "satu\ndua\n");
    const change = changeOf(
      await diffOf("MultiEdit", {
        file_path: "a.txt",
        edits: [
          { old_string: "satu", new_string: "1" },
          { old_string: "tiga", new_string: "3" },
        ],
      }),
    );
    expect(change).toMatchObject({ type: "mismatch", reason: "old_string_not_found", editIndex: 1 });
  });
});

describe("akhir baris Windows", () => {
  test("Edit pada berkas CRLF dengan teks pencarian LF cocok, dan hanya baris yang berubah yang muncul", async () => {
    put("w.txt", "satu\r\ndua\r\ntiga\r\n");
    const change = textChange(await diffOf("Edit", { file_path: "w.txt", old_string: "dua", new_string: "DUA" }));
    expect(change).toMatchObject({ added: 1, removed: 1 });
    expect(change.hunks[0]?.lines.map((l) => l.text)).toEqual(["satu", "dua", "DUA", "tiga"]); // tanpa \r
    expect(change.format).toMatchObject({ oldEol: "crlf", newEol: "crlf" }); // gaya akhir baris dipertahankan
  });

  test("teks pencarian yang melintasi baris (LF) cocok pada berkas CRLF", async () => {
    put("w.txt", "satu\r\ndua\r\ntiga\r\n");
    const change = textChange(await diffOf("Edit", { file_path: "w.txt", old_string: "satu\ndua", new_string: "SD" }));
    expect(change).toMatchObject({ added: 1, removed: 2 });
  });

  test("Write dengan LF pada berkas CRLF: hunk hanya untuk baris yang berbeda, format dicatat", async () => {
    put("w.txt", "satu\r\ndua\r\ntiga\r\n");
    const change = textChange(await diffOf("Write", { file_path: "w.txt", content: "satu\nDUA\ntiga\n" }));
    expect(change).toMatchObject({ added: 1, removed: 1 });
    expect(change.format).toMatchObject({ oldEol: "crlf", newEol: "lf" });
  });

  test("isi sama tetapi akhir baris beda: unchanged dengan formatChanged", async () => {
    put("w.txt", "satu\r\ndua\r\n");
    expect(changeOf(await diffOf("Write", { file_path: "w.txt", content: "satu\ndua\n" }))).toMatchObject({
      type: "unchanged",
      formatChanged: true,
      format: { oldEol: "crlf", newEol: "lf" },
    });
  });

  test("enter di akhir berkas yang hilang atau bertambah tercatat sebagai perubahan format", async () => {
    put("w.txt", "satu\ndua");
    expect(changeOf(await diffOf("Write", { file_path: "w.txt", content: "satu\ndua\n" }))).toMatchObject({
      type: "unchanged",
      formatChanged: true,
    });
  });
});

describe("kasus sulit: biner, besar, tidak terbaca", () => {
  test("berkas dengan byte NUL dianggap biner, isinya tidak ditampilkan", async () => {
    put("b.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const change = changeOf(await diffOf("Write", { file_path: "b.bin", content: "teks" }));
    expect(change).toEqual({ type: "binary", isNew: false, oldBytes: 7 });
  });

  test("berkas yang bukan UTF-8 yang sah dianggap biner", async () => {
    put("l.txt", Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f])); // "héllo" dalam Latin-1
    expect(changeOf(await diffOf("Edit", { file_path: "l.txt", old_string: "h", new_string: "H" }))).toMatchObject({ type: "binary" });
  });

  test("isi usulan yang mengandung byte NUL dianggap biner", async () => {
    expect(changeOf(await diffOf("Write", { file_path: "baru.bin", content: "a\0b" }))).toMatchObject({ type: "binary", isNew: true });
  });

  test("berkas lebih besar dari batas: ringkasan, dan isinya TIDAK PERNAH dibaca ke memori", async () => {
    const path = put("besar.txt", Buffer.alloc(3 * 1024 * 1024, "a"));
    vi.mocked(readFile).mockClear();
    const change = changeOf(await diffOf("Write", { file_path: path, content: "kecil\n" }));
    expect(change).toMatchObject({ type: "too_large", isNew: false, oldBytes: 3 * 1024 * 1024 });
    expect(vi.mocked(readFile)).not.toHaveBeenCalled(); // inilah jaminan memorinya
    // Menulis berkas 3 MB ke disk bisa lambat saat mesin sibuk (antivirus, test paket lain berjalan bersamaan).
  }, 30_000);

  test("batas ukuran bisa diatur", async () => {
    put("a.txt", "x".repeat(200));
    expect(changeOf(await diffOf("Write", { file_path: "a.txt", content: "y" }, { maxFileBytes: 100 }))).toMatchObject({ type: "too_large" });
    expect(changeOf(await diffOf("Write", { file_path: "a.txt", content: "y" }, { maxFileBytes: 1000 }))).toMatchObject({ type: "text" });
  });

  test("isi usulan yang sangat besar -> ringkasan dengan ukurannya", async () => {
    put("a.txt", "kecil\n");
    const change = changeOf(await diffOf("Write", { file_path: "a.txt", content: "x".repeat(5000) }, { maxFileBytes: 1000 }));
    expect(change).toMatchObject({ type: "too_large", newBytes: 5000 });
  });

  test("file besar dengan sangat banyak baris berubah -> ringkasan jumlah baris, cepat, tanpa diff penuh", async () => {
    const oldText = Array.from({ length: 30_000 }, (_, i) => `lama ${i}`).join("\n");
    const newText = Array.from({ length: 30_000 }, (_, i) => `baru ${i}`).join("\n");
    put("a.txt", oldText);
    const started = performance.now();
    const change = changeOf(await diffOf("Write", { file_path: "a.txt", content: newText }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(change).toMatchObject({ type: "too_large", oldLines: 30_000, newLines: 30_000, added: 30_000, removed: 30_000 });
  });

  test("berkas besar dengan perubahan kecil tetap menghasilkan diff penuh yang kecil", async () => {
    const lines = Array.from({ length: 40_000 }, (_, i) => `baris ${i}`); // sekitar 400 KB
    put("a.txt", `${lines.join("\n")}\n`);
    const edited = [...lines];
    edited[20_000] = "DIUBAH";
    const change = textChange(await diffOf("Write", { file_path: "a.txt", content: `${edited.join("\n")}\n` }));
    expect(change).toMatchObject({ added: 1, removed: 1 });
    expect(change.hunks).toHaveLength(1);
  });

  test("target berupa folder -> mismatch 'unreadable', bukan error", async () => {
    mkdirSync(join(dir, "folder"));
    expect(changeOf(await diffOf("Write", { file_path: "folder", content: "x" }))).toMatchObject({ type: "mismatch", reason: "unreadable" });
  });
});

describe("path sensitif", () => {
  test("berkas .env ditandai, lengkap dengan alasan", async () => {
    put(".env", "RAHASIA=1\n");
    const diff = await diffOf("Write", { file_path: ".env", content: "RAHASIA=2\n" });
    expect(diff?.sensitive.map((r) => r.code)).toContain("env_file");
  });

  test("berkas di luar folder proyek ditandai outside_project", async () => {
    const outside = mkdtempSync(join(tmpdir(), "agentmon-outside-"));
    try {
      const diff = await diffOf("Write", { file_path: join(outside, "a.txt"), content: "x\n" });
      expect(diff?.sensitive.map((r) => r.code)).toContain("outside_project");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("path yang memakai .. untuk keluar dari proyek tetap ditandai", async () => {
    const diff = await diffOf("Write", { file_path: "../di-luar/a.txt", content: "x\n" });
    expect(diff?.sensitive.map((r) => r.code)).toContain("outside_project");
  });

  test("berkas biasa di dalam proyek tidak ditandai", async () => {
    put("src/app.ts", "x\n");
    expect((await diffOf("Write", { file_path: "src/app.ts", content: "y\n" }))?.sensitive).toEqual([]);
  });

  test("tanda sensitif tetap ada walau diff-nya ringkasan atau biner", async () => {
    put(".env", Buffer.from([0, 1, 2]));
    expect((await diffOf("Write", { file_path: ".env", content: "x" }))?.sensitive.map((r) => r.code)).toContain("env_file");
  });
});

describe("masukan yang tidak bisa dihitung", () => {
  test.each([
    ["Bash", { command: "ls" }],
    ["PowerShell", { command: "dir" }],
    ["NotebookEdit", { file_path: "a.ipynb" }],
    ["Read", { file_path: "a.txt" }],
  ])("alat %s tidak punya diff berkas -> undefined", async (toolName, toolInput) => {
    expect(await computeToolDiff({ toolName, toolInput, cwd: dir })).toBeUndefined();
  });

  test.each([
    ["tanpa file_path", "Write", { content: "x" }],
    ["file_path bukan teks", "Write", { file_path: 42, content: "x" }],
    ["file_path kosong", "Write", { file_path: "", content: "x" }],
    ["Write tanpa content", "Write", { file_path: "a.txt" }],
    ["content bukan teks", "Write", { file_path: "a.txt", content: ["x"] }],
    ["Edit tanpa old_string", "Edit", { file_path: "a.txt", new_string: "x" }],
    ["Edit dengan new_string bukan teks", "Edit", { file_path: "a.txt", old_string: "a", new_string: 1 }],
    ["MultiEdit tanpa edits", "MultiEdit", { file_path: "a.txt" }],
    ["MultiEdit dengan edits kosong", "MultiEdit", { file_path: "a.txt", edits: [] }],
    ["MultiEdit dengan edit rusak", "MultiEdit", { file_path: "a.txt", edits: [{ old_string: "a" }] }],
  ])("%s -> undefined, tanpa melempar error", async (_name, toolName, toolInput) => {
    put("a.txt", "isi\n");
    expect(await computeToolDiff({ toolName, toolInput, cwd: dir })).toBeUndefined();
  });

  test("path dengan karakter aneh tidak melempar error", async () => {
    await expect(computeToolDiff({ toolName: "Write", toolInput: { file_path: "a\0b.txt", content: "x" }, cwd: dir })).resolves.toBeDefined();
  });
});
