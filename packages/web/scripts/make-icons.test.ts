import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { encodePng, ICONS, renderIconPixels, writeIcons } from "./make-icons";

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) => {
  const o = (Math.floor(y) * size + Math.floor(x)) * 4;
  return { r: rgba[o] as number, g: rgba[o + 1] as number, b: rgba[o + 2] as number, a: rgba[o + 3] as number };
};

describe("renderIconPixels", () => {
  const size = 128;

  test("ikon biasa: sudut transparan, tengah-tepi berlatar teal", () => {
    const rgba = renderIconPixels(size, { cornerRadius: 0.22, glyphScale: 1, opaqueCorners: false });
    expect(pixel(rgba, size, 0, 0).a).toBe(0); // sudut terpotong
    expect(pixel(rgba, size, size - 1, size - 1).a).toBe(0);
    const edge = pixel(rgba, size, 64, 4);
    expect(edge).toMatchObject({ r: 0x0f, g: 0x76, b: 0x6e, a: 255 });
  });

  test("ikon maskable dan iOS: memenuhi seluruh kotak, tidak ada piksel transparan", () => {
    for (const options of [
      { cornerRadius: 0, glyphScale: 0.66, opaqueCorners: true },
      { cornerRadius: 0, glyphScale: 0.84, opaqueCorners: true },
    ]) {
      const rgba = renderIconPixels(size, options);
      for (let i = 3; i < rgba.length; i += 4) expect(rgba[i]).toBe(255);
    }
  });

  test("logo putih tergambar di bagian tengah", () => {
    const rgba = renderIconPixels(size, { cornerRadius: 0.22, glyphScale: 1, opaqueCorners: false });
    // Titik di tengah garis datar kiri logo (0.17..0.35, 0.55).
    expect(pixel(rgba, size, 0.26 * size, 0.55 * size)).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
  });

  test("ikon maskable: seluruh logo berada di zona aman (lingkaran 80% dari tengah)", () => {
    const rgba = renderIconPixels(size, { cornerRadius: 0, glyphScale: 0.66, opaqueCorners: true });
    const safeRadius = 0.4 * size; // Android menjamin lingkaran berdiameter 80% tidak terpotong
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = pixel(rgba, size, x, y);
        const isGlyph = p.r > 200 && p.g > 200 && p.b > 200;
        if (isGlyph) expect(Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2), `(${x},${y})`).toBeLessThanOrEqual(safeRadius);
      }
    }
  });

  test("tepi dihaluskan: ada piksel peralihan, bukan hanya dua warna", () => {
    const rgba = renderIconPixels(size, { cornerRadius: 0.22, glyphScale: 1, opaqueCorners: false });
    const colors = new Set<string>();
    for (let i = 0; i < rgba.length; i += 4) colors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]}`);
    expect(colors.size).toBeGreaterThan(10);
  });

  test("hasilnya sama setiap kali dijalankan (deterministik)", () => {
    const options = { cornerRadius: 0.22, glyphScale: 1, opaqueCorners: false };
    expect(Buffer.from(renderIconPixels(64, options)).equals(Buffer.from(renderIconPixels(64, options)))).toBe(true);
  });
});

describe("encodePng", () => {
  test("PNG sah: tanda tangan, kepala, data yang bisa dikembalikan, dan penutup", () => {
    const size = 8;
    const rgba = renderIconPixels(size, { cornerRadius: 0, glyphScale: 1, opaqueCorners: true });
    const png = encodePng(size, rgba);

    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[24]).toBe(8); // kedalaman bit
    expect(png[25]).toBe(6); // RGBA
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");

    // Data piksel (setelah dimampatkan zlib) kembali persis: tiap baris = 1 byte filter + piksel.
    const idatStart = png.indexOf("IDAT") + 4;
    const idatLength = png.readUInt32BE(png.indexOf("IDAT") - 4);
    const raw = inflateSync(png.subarray(idatStart, idatStart + idatLength));
    expect(raw.length).toBe((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
      expect(raw[y * (size * 4 + 1)]).toBe(0);
      expect(Buffer.from(raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1))).equals(Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)))).toBe(true);
    }
  });

  test("CRC tiap bagian benar (pembaca PNG yang ketat menolak bila salah)", () => {
    const png = encodePng(4, renderIconPixels(4, { cornerRadius: 0, glyphScale: 1, opaqueCorners: true }));
    const table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    let offset = 8;
    let chunks = 0;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const body = png.subarray(offset + 4, offset + 8 + length);
      let crc = 0xffffffff;
      for (const byte of body) crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
      expect(((crc ^ 0xffffffff) >>> 0)).toBe(png.readUInt32BE(offset + 8 + length));
      offset += 12 + length;
      chunks++;
    }
    expect(chunks).toBe(3); // IHDR, IDAT, IEND
  });
});

describe("ikon yang di-commit", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  test("sama persis dengan yang dihasilkan skrip sekarang (tidak ketinggalan zaman)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentmon-icons-"));
    writeIcons(dir);
    for (const icon of ICONS) {
      const committed = readFileSync(join(__dirname, "..", "public", "icons", icon.file));
      expect(Buffer.from(readFileSync(join(dir, icon.file))).equals(committed), icon.file).toBe(true);
    }
    // Merender empat ikon dengan supersampling cukup berat; saat mesin sibuk bisa melewati batas 5 detik bawaan.
  }, 60_000);
});
