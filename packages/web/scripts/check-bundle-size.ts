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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Penanda yang hanya ada di kode penampil diff (data-diff-viewer="agentmon"). */
export const DIFF_VIEWER_MARKER = 'data-diff-viewer';

/**
 * Memastikan penampil diff benar-benar dimuat belakangan: penandanya TIDAK boleh ada di JS awal, tetapi harus ada di
 * salah satu berkas JS lain hasil build (kalau tidak ada di mana pun, pemeriksaan ini tidak berarti dan harus gagal).
 * Mengembalikan daftar masalah (kosong = baik).
 */
export function checkDiffViewerIsLazy(distDir: string, initialFiles: string[]): string[] {
  return checkMarkerIsLazy(distDir, initialFiles, DIFF_VIEWER_MARKER, "Penampil diff");
}

/** Penanda yang hanya ada di libsodium (nama fungsi kripto yang dipakai pustaka E2E). Harus dimuat belakangan: pengguna tanpa pairing E2E tidak mengunduhnya. */
export const CRYPTO_MARKER = "crypto_secretstream_xchacha20poly1305_init_push"; // ada di libsodium, TIDAK dipakai kode AgentMon (nama yang dipakai kode kita ikut di JS awal)

/** Seperti `checkDiffViewerIsLazy`, untuk libsodium (issue #033, docs/security-e2e.md bagian 7). */
export function checkCryptoIsLazy(distDir: string, initialFiles: string[]): string[] {
  return checkMarkerIsLazy(distDir, initialFiles, CRYPTO_MARKER, "Pustaka kripto (libsodium)");
}

function checkMarkerIsLazy(distDir: string, initialFiles: string[], marker: string, label: string): string[] {
  const assets = join(distDir, "assets");
  const initial = new Set(initialFiles.map((src) => join(distDir, src.replace(/^\/+/, "").split("?")[0] ?? "")));
  const problems: string[] = [];
  let foundLazy = false;
  const scan = (dir: string) => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.m?js$/.test(entry.name) && readFileSync(path, "utf8").includes(marker)) {
        if (initial.has(path)) problems.push(`${label} ikut di JS awal (${entry.name}); seharusnya dimuat belakangan.`);
        else foundLazy = true;
      }
    }
  };
  scan(assets);
  if (!foundLazy && problems.length === 0) problems.push(`${label} tidak ditemukan di berkas JS mana pun; periksa penanda dan pemisahan kode.`);
  return problems;
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
    const initialFiles = report.files.map((f) => f.file);
    const problems = [...checkDiffViewerIsLazy(dist, initialFiles), ...checkCryptoIsLazy(dist, initialFiles)];
    for (const problem of problems) console.error(`GAGAL: ${problem}`);
    if (problems.length === 0) console.log("OK: penampil diff dimuat belakangan (tidak ada di JS awal).");
    process.exitCode = report.ok && problems.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
