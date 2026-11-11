// @vitest-environment node
// Test ini MEMBANGUN aplikasi sungguhan (seperti `pnpm build`) ke folder sementara, lalu memeriksa hasilnya.
// Inilah yang membuktikan hal-hal yang tidak terlihat dari kode saja: manifest benar-benar dihasilkan dan
// ditautkan, service worker ada, dan kerangka aplikasi masuk daftar yang disimpan untuk offline.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "vite";
import { measureInitialJs } from "../scripts/check-bundle-size";
import { manifest } from "./pwa/manifest";

const root = join(__dirname, "..");
let out: string;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "agentmon-build-"));
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

const read = (file: string) => readFileSync(join(out, file), "utf8");

describe("hasil build", () => {
  test("berkas utama ada: index.html, manifest, service worker, dan ikon", () => {
    for (const file of ["index.html", "manifest.webmanifest", "sw.js", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
  });

  test("index.html menautkan manifest dan memuat aplikasi", () => {
    const html = read("index.html");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toMatch(/<script type="module"[^>]+src="\/assets\/index-[\w-]+\.js"/);
    expect(html).toContain('<div id="root"></div>');
  });

  test("manifest hasil build sama dengan yang didefinisikan, dan bisa dibaca sebagai JSON", () => {
    const built = JSON.parse(read("manifest.webmanifest")) as Record<string, unknown>;
    expect(built).toMatchObject({
      name: manifest.name,
      short_name: manifest.short_name,
      start_url: manifest.start_url,
      scope: manifest.scope,
      display: "standalone",
      lang: "id",
      theme_color: manifest.theme_color,
      background_color: manifest.background_color,
    });
    expect(built.icons).toEqual(manifest.icons);
  });

  test("service worker menyimpan kerangka aplikasi untuk offline: halaman, JS, CSS, dan ikon", () => {
    const sw = read("sw.js");
    // Daftar berkas yang disimpan (precache) ditulis di sw.js atau berkas workbox yang dimuatnya.
    const workbox = readdirSync(out).filter((f) => /^workbox-.*\.js$/.test(f)).map(read).join("\n");
    const code = `${sw}\n${workbox}`;
    expect(code).toMatch(/precacheAndRoute/);
    // Penulisannya berbeda antar mode build (diminifikasi atau tidak): pola ini longgar soal spasi dan tanda kutip.
    const precached = (pathPattern: string) => new RegExp(`["']?url["']?\\s*:\\s*["']${pathPattern}["']`).test(sw);
    expect(precached("index\\.html")).toBe(true);
    expect(precached("assets/index-[\\w-]+\\.js")).toBe(true);
    expect(precached("assets/index-[\\w-]+\\.css")).toBe(true);
    expect(precached("icons/icon-192\\.png")).toBe(true);
    expect(precached("manifest\\.webmanifest")).toBe(true);
  });

  test("navigasi ke alamat mana pun dijawab kerangka aplikasi saat offline (navigateFallback ke index.html)", () => {
    expect(read("sw.js")).toMatch(/NavigationRoute/);
    expect(read("sw.js")).toMatch(/createHandlerBoundToURL\("\/index\.html"\)/);
  });

  test("versi lama di HP dibersihkan dan versi baru langsung mengambil alih", () => {
    const sw = read("sw.js");
    expect(sw).toMatch(/cleanupOutdatedCaches/);
    expect(sw).toMatch(/skipWaiting|clientsClaim/);
  });

  test("tidak ada sourcemap yang ikut terbit", () => {
    expect(readdirSync(join(out, "assets")).filter((f) => f.endsWith(".map"))).toEqual([]);
  });

  test("JS awal di bawah 200 KB gzip (PRD §14)", () => {
    const report = measureInitialJs(out);
    expect(report.ok, `JS awal ${report.totalGzipBytes} byte`).toBe(true);
    expect(report.totalGzipBytes).toBeGreaterThan(10_000); // memang ada React di dalamnya, bukan build kosong
  });

  test("CSS ikut diproses Tailwind: kelas yang dipakai komponen ada dan tema gelap terdefinisi", () => {
    const css = readFileSync(join(out, "assets", readdirSync(join(out, "assets")).find((f) => f.endsWith(".css")) as string), "utf8");
    expect(css).toContain('[data-theme=dark]');
    expect(css).toContain("--c-bg");
    expect(css).toMatch(/\.min-h-11\s*\{\s*min-height:\s*calc\(var\(--spacing\)\s*\*\s*11\)/); // kelas min-h-11 pada tombol tema
  });
});
