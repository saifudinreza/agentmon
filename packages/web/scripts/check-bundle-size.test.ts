import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { formatReport, initialScripts, INITIAL_JS_LIMIT_BYTES, measureInitialJs } from "./check-bundle-size";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// Membuat folder "dist" tiruan: index.html dan berkas JS dengan isi yang ditentukan.
function makeDist(html: string, files: Record<string, string | Buffer>) {
  dir = mkdtempSync(join(tmpdir(), "agentmon-dist-"));
  writeFileSync(join(dir, "index.html"), html);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir as string;
}

describe("initialScripts", () => {
  test("mengambil skrip dan modulepreload, bukan stylesheet maupun skrip inline", () => {
    const html = `
      <script>inline()</script>
      <link rel="stylesheet" href="/assets/a.css">
      <script type="module" crossorigin src="/assets/index-1.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/vendor-2.js">
      <link href="/assets/lain-3.js" rel="modulepreload">`;
    expect(initialScripts(html)).toEqual(["/assets/index-1.js", "/assets/vendor-2.js", "/assets/lain-3.js"]);
  });

  test("berkas yang sama disebut dua kali dihitung sekali", () => {
    const html = '<script src="/a.js"></script><link rel="modulepreload" href="/a.js">';
    expect(initialScripts(html)).toEqual(["/a.js"]);
  });

  test("skrip dengan query string dikenali sebagai JS", () => {
    expect(initialScripts('<script src="/a.js?v=1"></script>')).toEqual(["/a.js?v=1"]);
  });

  test("yang bukan JS diabaikan", () => {
    expect(initialScripts('<script src="/data.json"></script>')).toEqual([]);
  });
});

describe("measureInitialJs", () => {
  test("di bawah batas: ok, dan ukurannya dihitung SETELAH gzip", () => {
    const code = "console.log('halo');\n".repeat(5000); // 100 KB mentah, sangat mudah dimampatkan
    const report = measureInitialJs(makeDist('<script type="module" src="/assets/app.js"></script>', { "assets/app.js": code }));
    expect(report.ok).toBe(true);
    expect(report.totalGzipBytes).toBeLessThan(2000); // jauh lebih kecil dari ukuran mentahnya
    expect(report.files).toHaveLength(1);
  });

  test("melebihi batas: tidak ok", () => {
    // Data acak tidak bisa dimampatkan, jadi ukuran gzip kira-kira sama dengan mentah.
    const report = measureInitialJs(makeDist('<script type="module" src="/assets/app.js"></script>', { "assets/app.js": randomBytes(300_000) }));
    expect(report.totalGzipBytes).toBeGreaterThan(INITIAL_JS_LIMIT_BYTES);
    expect(report.ok).toBe(false);
  });

  test("beberapa berkas awal dijumlahkan", () => {
    const html = '<script type="module" src="/a.js"></script><link rel="modulepreload" href="/b.js">';
    const report = measureInitialJs(makeDist(html, { "a.js": randomBytes(120_000), "b.js": randomBytes(120_000) }));
    expect(report.files).toHaveLength(2);
    expect(report.totalGzipBytes).toBeGreaterThan(200_000);
    expect(report.ok).toBe(false); // masing-masing 120 KB, tetapi jumlahnya melebihi batas
  });

  test("berkas lazy (tidak dirujuk index.html) TIDAK dihitung", () => {
    const report = measureInitialJs(makeDist('<script type="module" src="/a.js"></script>', { "a.js": "x", "assets/diff-viewer.js": randomBytes(500_000) }));
    expect(report.ok).toBe(true);
    expect(report.files.map((f) => f.file)).toEqual(["/a.js"]);
  });

  test("tepat di batas dianggap tidak ok (batasnya 'kurang dari')", () => {
    const report = measureInitialJs(makeDist('<script type="module" src="/a.js"></script>', { "a.js": "x" }), 1);
    expect(report.totalGzipBytes).toBeGreaterThanOrEqual(1);
    expect(report.ok).toBe(false);
  });

  test("build belum dijalankan: galat yang menjelaskan", () => {
    const empty = mkdtempSync(join(tmpdir(), "agentmon-dist-"));
    dir = empty;
    expect(() => measureInitialJs(empty)).toThrow(/Jalankan build/);
  });

  test("index.html tanpa skrip: galat, bukan lolos diam-diam dengan 0 byte", () => {
    expect(() => measureInitialJs(makeDist("<html></html>", {}))).toThrow(/tidak memuat skrip/);
  });

  test("skrip yang dirujuk tetapi tidak ada: galat", () => {
    expect(() => measureInitialJs(makeDist('<script type="module" src="/hilang.js"></script>', {}))).toThrow(/tidak ada/);
  });

  test("batas bawaan sesuai PRD: 200 KB", () => {
    expect(INITIAL_JS_LIMIT_BYTES).toBe(200_000);
  });
});

describe("formatReport", () => {
  test("memuat ukuran, batas, dan kesimpulan", () => {
    const ok = formatReport({ files: [{ file: "/a.js", gzipBytes: 70_500 }], totalGzipBytes: 70_500, limitBytes: 200_000, ok: true });
    expect(ok).toContain("70.5 KB");
    expect(ok).toContain("200.0 KB");
    expect(ok).toContain("OK");
    const bad = formatReport({ files: [], totalGzipBytes: 250_000, limitBytes: 200_000, ok: false });
    expect(bad).toContain("GAGAL");
  });
});
