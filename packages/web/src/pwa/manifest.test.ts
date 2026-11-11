import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { THEME_COLORS } from "../theme/theme";
import { BACKGROUND_COLOR, manifest, THEME_COLOR } from "./manifest";

const root = join(__dirname, "..", "..");
const publicFile = (src: string) => join(root, "public", src.replace(/^\//, ""));

// Membaca lebar dan tinggi dari kepala berkas PNG (byte 16-23).
function pngSize(file: string): { width: number; height: number; signature: boolean } {
  const bytes = readFileSync(file);
  return {
    signature: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe("manifest: syarat agar bisa dipasang", () => {
  test("punya nama, alamat awal, dan mode layar penuh (standalone)", () => {
    expect(manifest.name).toBe("AgentMon");
    expect(manifest.short_name).toBe("AgentMon");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  test("nama pendek cukup pendek agar tidak terpotong di bawah ikon (maks 12 karakter)", () => {
    expect((manifest.short_name ?? "").length).toBeLessThanOrEqual(12);
  });

  test("bahasa Indonesia", () => {
    expect(manifest.lang).toBe("id");
  });

  test("ikon 192 dan 512 ada (syarat Chrome Android), dan ada satu yang maskable", () => {
    const icons = manifest.icons ?? [];
    expect(icons.some((i) => i.sizes === "192x192" && (i.purpose ?? "any") === "any")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && (i.purpose ?? "any") === "any")).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  test("tiap ikon yang dijanjikan benar-benar ada, berupa PNG, dengan ukuran yang tertulis", () => {
    for (const icon of manifest.icons ?? []) {
      const file = publicFile(icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const { signature, width, height } = pngSize(file);
      expect(signature, icon.src).toBe(true);
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
      expect(icon.type).toBe("image/png");
    }
  });

  test("warna tema dan latar sama dengan tema gelap aplikasi, supaya layar pembuka tidak berkedip", () => {
    expect(manifest.theme_color).toBe(THEME_COLOR);
    expect(manifest.background_color).toBe(BACKGROUND_COLOR);
    expect(THEME_COLOR).toBe(THEME_COLORS.dark);
  });
});

describe("index.html: syarat untuk iOS dan HP", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");

  test("viewport memenuhi layar sampai ke tepi (notch) tanpa mematikan zoom", () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).not.toContain("user-scalable=no"); // aksesibilitas: pengguna boleh memperbesar
    expect(viewport).not.toContain("maximum-scale");
  });

  test("ikon sentuh iOS dan mode aplikasi ada, dan file-nya ada", () => {
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(existsSync(publicFile("/icons/apple-touch-icon.png"))).toBe(true);
    expect(pngSize(publicFile("/icons/apple-touch-icon.png"))).toMatchObject({ width: 180, height: 180 });
  });

  test("bahasa halaman Indonesia dan meta theme-color ada", () => {
    expect(html).toContain('<html lang="id"');
    expect(html).toContain('name="theme-color"');
  });
});
