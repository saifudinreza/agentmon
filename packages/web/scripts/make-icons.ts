// =====================================================================================
// FILE INI: pembuat ikon aplikasi = "PENCETAK STEMPEL" gambar logo dalam berbagai ukuran.
// =====================================================================================
//
// Menggambar logo (kotak hijau-teal dengan garis denyut putih, tanda "memantau") langsung ke berkas
// PNG, tanpa pustaka gambar. Dijalankan sekali: `pnpm --filter @agentmon/web icons`. Hasilnya
// (public/icons/*.png) ikut di-commit, jadi build tidak bergantung pada skrip ini.
//
// Empat ikon, karena tiap platform meminta bentuk berbeda:
//   icon-192, icon-512        ikon biasa, sudut membulat, latar luar transparan (Android, desktop)
//   icon-maskable-512         memenuhi seluruh kotak; Android memotongnya jadi lingkaran atau bentuk
//                             lain, jadi isi pentingnya dikecilkan ke bagian tengah ("safe zone")
//   apple-touch-icon (180)    memenuhi seluruh kotak tanpa sudut membulat; iOS membulatkannya sendiri
//                             dan menampilkan transparansi sebagai hitam
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

type Point = readonly [number, number];

// Garis denyut dalam koordinat 0..1 dari lebar ikon.
const PULSE: readonly Point[] = [
  [0.17, 0.55],
  [0.35, 0.55],
  [0.43, 0.3],
  [0.56, 0.72],
  [0.64, 0.5],
  [0.83, 0.5],
];
const STROKE = 0.075; // tebal garis, dari lebar ikon

const BACKGROUND: readonly [number, number, number] = [0x0f, 0x76, 0x6e]; // teal tua
const FOREGROUND: readonly [number, number, number] = [0xff, 0xff, 0xff];

export type IconOptions = {
  /** Bagian sudut yang dibulatkan, dari lebar ikon. 0 = persegi penuh. */
  cornerRadius: number;
  /** Pengecil gambar logo terhadap tengah ikon. 1 = ukuran penuh. */
  glyphScale: number;
  /** Beri latar di luar sudut membulat? Bila tidak, bagian itu transparan. */
  opaqueCorners: boolean;
};

// Jarak titik p ke ruas garis a-b.
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Apakah titik (0..1) berada di dalam persegi bersudut membulat?
function insideRoundedSquare(x: number, y: number, radius: number): boolean {
  if (radius <= 0) return true;
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

/** Menggambar ikon sebagai piksel RGBA. Tepi dihaluskan dengan 4x4 contoh per piksel. */
export function renderIconPixels(size: number, options: IconOptions): Uint8Array {
  const SAMPLES = 4;
  const pixels = new Uint8Array(size * size * 4);
  const center: Point = [0.5, 0.5];
  const glyph = PULSE.map((p): Point => [center[0] + (p[0] - center[0]) * options.glyphScale, center[1] + (p[1] - center[1]) * options.glyphScale]);
  const halfStroke = (STROKE * options.glyphScale) / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let coverage = 0; // seberapa banyak piksel ini di dalam bentuk ikon
      let glyphCoverage = 0; // dan seberapa banyak di antaranya tertutup logo
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!options.opaqueCorners && !insideRoundedSquare(x, y, options.cornerRadius)) continue;
          coverage++;
          for (let i = 0; i < glyph.length - 1; i++) {
            if (distanceToSegment([x, y], glyph[i] as Point, glyph[i + 1] as Point) <= halfStroke) {
              glyphCoverage++;
              break;
            }
          }
        }
      }
      const total = SAMPLES * SAMPLES;
      const mix = coverage === 0 ? 0 : glyphCoverage / coverage;
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round((BACKGROUND[channel] as number) * (1 - mix) + (FOREGROUND[channel] as number) * mix);
      }
      pixels[offset + 3] = Math.round((coverage / total) * 255);
    }
  }
  return pixels;
}

// ---- Penulis PNG: tanda tangan, IHDR, IDAT (data dimampatkan zlib), IEND ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(size: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); // lebar
  header.writeUInt32BE(size, 4); // tinggi
  header[8] = 8; // kedalaman bit
  header[9] = 6; // RGBA
  // Tiap baris diawali satu byte "filter" (0 = tanpa filter).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const ICONS: ReadonlyArray<{ file: string; size: number; options: IconOptions }> = [
  { file: "icon-192.png", size: 192, options: { cornerRadius: 0.22, glyphScale: 1, opaqueCorners: false } },
  { file: "icon-512.png", size: 512, options: { cornerRadius: 0.22, glyphScale: 1, opaqueCorners: false } },
  { file: "icon-maskable-512.png", size: 512, options: { cornerRadius: 0, glyphScale: 0.66, opaqueCorners: true } },
  { file: "apple-touch-icon.png", size: 180, options: { cornerRadius: 0, glyphScale: 0.84, opaqueCorners: true } },
];

export function writeIcons(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const icon of ICONS) {
    writeFileSync(join(outDir, icon.file), encodePng(icon.size, renderIconPixels(icon.size, icon.options)));
  }
}

// Dijalankan langsung (bukan diimpor test): tulis ke public/icons.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
  writeIcons(outDir);
  console.log(`Ikon ditulis ke ${outDir}`);
}
