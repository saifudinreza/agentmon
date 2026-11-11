// =====================================================================================
// FILE INI: pemeriksa ukuran bundle = "TIMBANGAN" untuk JavaScript awal aplikasi.
// =====================================================================================
//
// Target PRD §14: JavaScript awal kurang dari 200 KB setelah dikompres (gzip). Itu yang harus
// diunduh HP sebelum aplikasi tampil, jadi ukurannya menentukan seberapa cepat aplikasi terbuka di
// jaringan lambat. Skrip ini dijalankan di CI setelah build dan GAGAL bila batas terlampaui,
// supaya pembengkakan ketahuan di PR yang menyebabkannya, bukan berbulan-bulan kemudian.
//
// Yang dihitung hanya JS AWAL: skrip yang dimuat langsung oleh index.html (script dan modulepreload).
// Bagian yang dimuat belakangan (lazy), seperti penampil diff nanti, tidak ikut dihitung.
// Service worker (sw.js) dan pustaka workbox bukan bagian muatan awal, jadi juga tidak dihitung.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Batas JS awal setelah gzip, dalam byte. PRD §14: "JS awal < 200 KB gzip". */
export const INITIAL_JS_LIMIT_BYTES = 200 * 1000;

export type BundleReport = {
  files: Array<{ file: string; gzipBytes: number }>;
  totalGzipBytes: number;
  limitBytes: number;
  ok: boolean;
};

// Alamat berkas JS yang dimuat langsung oleh index.html.
export function initialScripts(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) found.add(match[1] as string);
  for (const match of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)) found.add(match[1] as string);
  for (const match of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="modulepreload"/g)) found.add(match[1] as string);
  return [...found].filter((src) => /\.m?js$/.test(src.split("?")[0] ?? ""));
}

/** Mengukur JS awal di folder hasil build (dist). Melempar galat bila build belum ada atau tidak punya JS awal. */
export function measureInitialJs(distDir: string, limitBytes = INITIAL_JS_LIMIT_BYTES): BundleReport {
  const indexFile = join(distDir, "index.html");
  if (!existsSync(indexFile)) throw new Error(`Tidak ada ${indexFile}. Jalankan build dulu.`);

  const scripts = initialScripts(readFileSync(indexFile, "utf8"));
  if (scripts.length === 0) throw new Error("index.html tidak memuat skrip apa pun; pemeriksaan ukuran tidak berarti.");

  const files = scripts.map((src) => {
    const path = join(distDir, src.replace(/^\/+/, "").split("?")[0] ?? "");
    if (!existsSync(path)) throw new Error(`Skrip ${src} dirujuk index.html tetapi tidak ada di ${distDir}.`);
    return { file: src, gzipBytes: gzipSync(readFileSync(path), { level: 9 }).length };
  });
  const totalGzipBytes = files.reduce((sum, f) => sum + f.gzipBytes, 0);
  return { files, totalGzipBytes, limitBytes, ok: totalGzipBytes < limitBytes };
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

export function formatReport(report: BundleReport): string {
  const lines = report.files.map((f) => `  ${f.file}  ${kb(f.gzipBytes)}`);
  lines.push(`JS awal (gzip): ${kb(report.totalGzipBytes)} dari batas ${kb(report.limitBytes)}`);
  lines.push(report.ok ? "OK: di bawah batas." : "GAGAL: melebihi batas. Pindahkan bagian besar ke muatan lazy atau kurangi dependensi.");
  return lines.join("\n");
}

// Dijalankan langsung dari terminal atau CI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
    const report = measureInitialJs(dist);
    console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
