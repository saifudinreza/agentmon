import { buildPairingUrl } from "@agentmon/shared";
import jsQR from "jsqr";
import { describe, expect, test } from "vitest";
import { qrMatrix, renderQrForTerminal } from "./qr";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

// Membaca KEMBALI teks yang dicetak ke terminal menjadi kisi gelap/terang, persis seperti mata
// manusia dan kamera melihatnya. Dengan begitu yang dites adalah apa yang benar-benar tampil.
function parseTerminalText(text: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of text.replace(ANSI, "").split("\n")) {
    const upper: boolean[] = [];
    const lower: boolean[] = [];
    for (const ch of line) {
      upper.push(ch === "█" || ch === "▀");
      lower.push(ch === "█" || ch === "▄");
    }
    rows.push(upper, lower);
  }
  return rows;
}

// Menggambar kisi sebagai gambar piksel (hitam/putih) lalu dibaca pemindai QR sungguhan (jsQR).
function scan(matrix: boolean[][], scale = 6): string | undefined {
  const size = matrix.length;
  const width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const dark = matrix[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true;
      const i = (y * width + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = dark ? 0 : 255;
      pixels[i + 3] = 255;
    }
  }
  return jsQR(pixels, width, width)?.data;
}

const REALISTIC = buildPairingUrl("https://agentmon-app.contoh.com", {
  code: "abcDEF0123456789_-abcDEF0123456789",
  relayUrl: "https://agentmon-relay.contoh-hosting.example.com",
});

describe("QR untuk terminal", () => {
  test("isi QR bisa dibaca kembali oleh pemindai sungguhan: alamat pairing yang realistis", () => {
    expect(scan(qrMatrix(REALISTIC))).toBe(REALISTIC);
  });

  test("TEKS yang dicetak ke terminal (bukan hanya kisi di memori) juga terbaca persis", () => {
    const printed = renderQrForTerminal(REALISTIC);
    expect(scan(parseTerminalText(printed))).toBe(REALISTIC);
  });

  test("alamat dengan rahasia E2E (tahap 4) yang lebih panjang tetap muat dan terbaca", () => {
    const long = buildPairingUrl("https://app.contoh.com", {
      code: "abcDEF0123456789_-abcDEF0123456789",
      relayUrl: "https://relay.contoh.com",
      secret: "k".repeat(43), // 32 byte base64url
    });
    expect(scan(parseTerminalText(renderQrForTerminal(long)))).toBe(long);
  });

  test("jumlah baris ganjil (setengah blok di baris terakhir) tidak merusak kisi", () => {
    // Kisi 29x29 + tepi = 33 baris: ganjil. Baris ke-34 yang hilang harus dianggap terang.
    const matrix = qrMatrix("A");
    const printed = parseTerminalText(renderQrForTerminal("A"));
    expect(printed.length % 2).toBe(0);
    expect(printed.slice(0, matrix.length)).toEqual(matrix);
    expect(printed.slice(matrix.length).every((row) => row.every((cell) => !cell))).toBe(true);
  });

  test("ada tepi terang di sekeliling supaya pemindai bisa menemukan QR", () => {
    const matrix = qrMatrix(REALISTIC);
    expect(matrix[0]?.every((cell) => !cell)).toBe(true);
    expect(matrix[matrix.length - 1]?.every((cell) => !cell)).toBe(true);
    expect(matrix.every((row) => !row[0] && !row[row.length - 1])).toBe(true);
  });

  test("dicetak hitam di atas putih secara eksplisit dan tiap baris dikembalikan ke warna semula", () => {
    const lines = renderQrForTerminal(REALISTIC).split("\n");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line.startsWith(`${ESC}[47m${ESC}[30m`)).toBe(true);
      expect(line.endsWith(`${ESC}[0m`)).toBe(true);
    }
  });

  test("cukup ringkas untuk terminal standar: lebar kurang dari 80 kolom dan tinggi kurang dari 40 baris", () => {
    const lines = renderQrForTerminal(REALISTIC).split("\n");
    expect(lines.length).toBeLessThan(40);
    expect([...(lines[0] ?? "").replace(ANSI, "")].length).toBeLessThan(80);
  });
});
