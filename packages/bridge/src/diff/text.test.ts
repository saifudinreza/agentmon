import { DiffHunkSchema, type DiffHunk } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { diffText, splitLines } from "./text";

// Menerapkan hunk ke baris lama untuk membangun baris baru. Kalau diff benar, hasilnya HARUS
// sama persis dengan teks baru. Ini ukuran kebenaran terkuat, tidak bergantung pada bentuk hunk.
function apply(oldLines: string[], hunks: DiffHunk[]): string[] {
  const out: string[] = [];
  let cursor = 0; // indeks berikutnya di oldLines yang belum diproses
  for (const hunk of hunks) {
    const from = hunk.oldLines > 0 ? hunk.oldStart - 1 : hunk.oldStart; // indeks dari 0
    while (cursor < from) out.push(oldLines[cursor++] as string);
    for (const line of hunk.lines) {
      if (line.type === "context") {
        expect(oldLines[cursor]).toBe(line.text); // konteks harus benar-benar ada di teks lama
        out.push(oldLines[cursor++] as string);
      } else if (line.type === "remove") {
        expect(oldLines[cursor]).toBe(line.text);
        cursor++;
      } else {
        out.push(line.text);
      }
    }
  }
  while (cursor < oldLines.length) out.push(oldLines[cursor++] as string);
  return out;
}

// Setiap baris diakhiri enter, supaya baris kosong (termasuk yang terakhir) tidak hilang saat teks
// dipecah lagi. Dengan lines.join, elemen terakhir "" akan lenyap.
const toText = (lines: string[]) => lines.map((line) => `${line}\n`).join("");
const diff = (a: string[], b: string[], options = {}) => diffText(toText(a), toText(b), options);

function ok(result: ReturnType<typeof diffText>) {
  if (!result.ok) throw new Error("seharusnya ok");
  return result;
}

describe("splitLines", () => {
  test("memecah baris dan mencatat gaya akhir baris", () => {
    expect(splitLines("a\nb\n")).toEqual({ lines: ["a", "b"], eol: "lf", finalNewline: true });
    expect(splitLines("a\r\nb\r\n")).toEqual({ lines: ["a", "b"], eol: "crlf", finalNewline: true });
    expect(splitLines("a\r\nb\nc")).toEqual({ lines: ["a", "b", "c"], eol: "mixed", finalNewline: false });
    expect(splitLines("satu baris")).toEqual({ lines: ["satu baris"], eol: "none", finalNewline: false });
  });

  test("teks kosong tidak punya baris, dan baris kosong di tengah dipertahankan", () => {
    expect(splitLines("")).toEqual({ lines: [], eol: "none", finalNewline: false });
    expect(splitLines("a\n\nb").lines).toEqual(["a", "", "b"]);
    expect(splitLines("\n").lines).toEqual([""]); // satu baris kosong
  });
});

describe("diffText: bentuk hunk", () => {
  test("satu baris berubah: satu hunk dengan konteks 3 baris di sekitarnya", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const b = [...a];
    b[4] = "LIMA";
    const result = ok(diff(a, b));
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ id: "h1", oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(result.hunks[0]?.lines.map((l) => `${l.type[0]}:${l.text}`)).toEqual([
      "c:2", "c:3", "c:4", "r:5", "a:LIMA", "c:6", "c:7", "c:8",
    ]);
  });

  test("nomor baris pada tiap baris benar", () => {
    const result = ok(diff(["a", "b", "c"], ["a", "B", "c"], { contextLines: 1 }));
    expect(result.hunks[0]?.lines).toEqual([
      { type: "context", text: "a", oldLine: 1, newLine: 1 },
      { type: "remove", text: "b", oldLine: 2 },
      { type: "add", text: "B", newLine: 2 },
      { type: "context", text: "c", oldLine: 3, newLine: 3 },
    ]);
  });

  test("perubahan berjauhan menjadi beberapa hunk dengan id berurutan", () => {
    const a = Array.from({ length: 40 }, (_, i) => `baris ${i + 1}`);
    const b = [...a];
    b[2] = "UBAH 3";
    b[20] = "UBAH 21";
    b[37] = "UBAH 38";
    const result = ok(diff(a, b));
    expect(result.hunks.map((h) => h.id)).toEqual(["h1", "h2", "h3"]);
    expect(result).toMatchObject({ added: 3, removed: 3 });
  });

  test("perubahan yang berdekatan (jarak ≤ 2 × konteks) digabung menjadi satu hunk", () => {
    const a = Array.from({ length: 20 }, (_, i) => `x${i}`);
    const b = [...a];
    b[5] = "A";
    b[10] = "B"; // jarak 4 baris tidak berubah di antaranya, ≤ 6
    expect(ok(diff(a, b)).hunks).toHaveLength(1);
    const far = [...a];
    far[2] = "A";
    far[15] = "B";
    expect(ok(diff(a, far)).hunks).toHaveLength(2);
  });

  test("hanya menambah baris: oldLines dihitung benar, hanya baris 'add'", () => {
    const result = ok(diff(["a", "b"], ["a", "baru", "b"], { contextLines: 1 }));
    expect(result).toMatchObject({ added: 1, removed: 0 });
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 });
  });

  test("seluruh isi baru (berkas lama kosong): satu hunk, oldStart 0 dan oldLines 0", () => {
    const result = ok(diffText("", "satu\ndua\n"));
    expect(result).toMatchObject({ added: 2, removed: 0 });
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    expect(result.hunks[0]?.lines.every((l) => l.type === "add")).toBe(true);
  });

  test("seluruh isi dihapus: newStart 0 dan newLines 0", () => {
    const result = ok(diffText("satu\ndua\n", ""));
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
  });

  test("setiap hunk lolos validasi kontrak di paket shared", () => {
    const a = Array.from({ length: 30 }, (_, i) => `b${i}`);
    const b = [...a];
    b[3] = "X";
    b[25] = "Y";
    for (const hunk of ok(diff(a, b)).hunks) expect(DiffHunkSchema.safeParse(hunk).success).toBe(true);
  });
});

describe("diffText: akhir baris", () => {
  test("akhir baris Windows (CRLF) di kedua sisi: hanya baris yang benar-benar berubah yang muncul", () => {
    const result = ok(diffText("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n", { contextLines: 1 }));
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(result.hunks[0]?.lines.map((l) => l.text)).toEqual(["a", "b", "B", "c"]); // tanpa \r
    expect(result.format).toEqual({ oldEol: "crlf", newEol: "crlf", oldFinalNewline: true, newFinalNewline: true });
  });

  test("berkas CRLF yang diusulkan dengan LF: isi sama -> tidak ada hunk, perbedaan hanya di format", () => {
    const result = ok(diffText("a\r\nb\r\n", "a\nb\n"));
    expect(result.hunks).toEqual([]);
    expect(result.format).toMatchObject({ oldEol: "crlf", newEol: "lf" });
  });

  test("perbedaan enter di akhir berkas tercatat di format, bukan sebagai hunk", () => {
    const result = ok(diffText("a\nb", "a\nb\n"));
    expect(result.hunks).toEqual([]);
    expect(result.format).toMatchObject({ oldFinalNewline: false, newFinalNewline: true });
  });

  test("baris yang berbeda hanya karena spasi di ujung tetap dianggap berbeda", () => {
    const result = ok(diffText("a \n", "a\n"));
    expect(result).toMatchObject({ added: 1, removed: 1 });
  });
});

describe("diffText: isi sama atau kasus tepi", () => {
  test("teks identik: tanpa hunk", () => {
    expect(ok(diffText("a\nb\n", "a\nb\n"))).toMatchObject({ hunks: [], added: 0, removed: 0 });
    expect(ok(diffText("", ""))).toMatchObject({ hunks: [], added: 0, removed: 0 });
  });

  test("baris kosong ikut dihitung", () => {
    const result = ok(diffText("a\n\nb\n", "a\nb\n"));
    expect(result).toMatchObject({ added: 0, removed: 1 });
    expect(result.hunks[0]?.lines.find((l) => l.type === "remove")?.text).toBe("");
  });

  test("baris yang sangat panjang dan karakter khusus dipertahankan apa adanya", () => {
    const long = "x".repeat(50_000);
    const result = ok(diffText(`${long}\n`, `${long}y\nbaris ✓ 日本語\n`));
    expect(result.hunks[0]?.lines.find((l) => l.type === "add")?.text).toBe(`${long}y`);
    expect(result.hunks[0]?.lines.some((l) => l.text === "baris ✓ 日本語")).toBe(true);
  });
});

// ---- Uji properti ----------------------------------------------------------------------

// Pembangkit angka acak yang hasilnya selalu sama untuk seed yang sama (mulberry32), supaya
// kegagalan bisa diulang persis.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Panjang LCS (urutan bersama terpanjang) dengan pemrograman dinamis. Jumlah edit minimal
// = n + m - 2 × LCS. Dipakai sebagai kunci jawaban untuk memeriksa Myers menghasilkan yang minimal.
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

describe("uji properti pada ratusan pasangan teks acak", () => {
  test("menerapkan diff ke teks lama selalu menghasilkan teks baru, dengan jumlah edit minimal", () => {
    const random = rng(20261110);
    for (let round = 0; round < 400; round++) {
      // Alfabet kecil supaya banyak baris berulang (kasus yang paling sulit bagi algoritma diff).
      const alphabet = ["a", "b", "c", "d", ""].slice(0, 2 + Math.floor(random() * 4));
      const pick = () => alphabet[Math.floor(random() * alphabet.length)] as string;
      const a = Array.from({ length: Math.floor(random() * 30) }, pick);
      const b = Array.from({ length: Math.floor(random() * 30) }, pick);
      const context = Math.floor(random() * 4);

      const result = ok(diff(a, b, { contextLines: context }));
      expect(apply(a, result.hunks), `putaran ${round}: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`).toEqual(b);
      expect(result.added + result.removed, `putaran ${round} minimal`).toBe(a.length + b.length - 2 * lcs(a, b));
      // Jumlah yang dilaporkan sama dengan jumlah baris add/remove di hunk.
      const lines = result.hunks.flatMap((h) => h.lines);
      expect(lines.filter((l) => l.type === "add")).toHaveLength(result.added);
      expect(lines.filter((l) => l.type === "remove")).toHaveLength(result.removed);
      // Setiap hunk konsisten dengan hitungan barisnya sendiri.
      for (const hunk of result.hunks) {
        expect(hunk.oldLines).toBe(hunk.lines.filter((l) => l.type !== "add").length);
        expect(hunk.newLines).toBe(hunk.lines.filter((l) => l.type !== "remove").length);
      }
    }
  });

  test("mengubah berkas besar sedikit saja tetap cepat dan menghasilkan satu hunk kecil", () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `baris nomor ${i}`);
    const b = [...a];
    b[25_000] = "diubah";
    const started = performance.now();
    const result = ok(diff(a, b));
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.lines).toHaveLength(8); // 3 konteks + hapus + tambah + 3 konteks
  });
});

describe("batas memori dan waktu", () => {
  test("terlalu banyak baris berbeda -> ringkasan, bukan diff penuh", () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `lama ${i}`);
    const b = Array.from({ length: 30_000 }, (_, i) => `baru ${i}`);
    const result = diff(a, b);
    expect(result).toMatchObject({ ok: false, oldLines: 30_000, newLines: 30_000, added: 30_000, removed: 30_000 });
  });

  test("jarak edit melebihi batas -> ringkasan, dan hasilnya cepat", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 4000 }, (_, i) => `b${i}`);
    const started = performance.now();
    const result = diff(a, b, { maxEditDistance: 200 });
    expect(result.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("batas yang dilonggarkan memberi diff penuh pada kasus yang sama", () => {
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 300 }, (_, i) => `b${i}`);
    expect(diff(a, b, { maxEditDistance: 200 }).ok).toBe(false);
    expect(ok(diff(a, b, { maxEditDistance: 1000 })).hunks).toHaveLength(1);
  });

  test("awal dan akhir yang sama tidak dihitung dalam batas (hanya bagian tengah)", () => {
    const common = Array.from({ length: 100_000 }, (_, i) => `sama ${i}`);
    const a = [...common, "lama", ...common];
    const b = [...common, "baru", ...common];
    const result = ok(diff(a, b));
    expect(result).toMatchObject({ added: 1, removed: 1 });
  });
});
