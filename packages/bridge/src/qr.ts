// =====================================================================================
// FILE INI: mencetak QR ke terminal = "PENCETAK STEMPEL" dari kotak-kotak hitam putih.
// =====================================================================================
//
// QR adalah kisi kotak kecil ("modul") yang gelap atau terang. Pustaka `qrcode` menghitung kisi itu;
// file ini yang menggambarnya sebagai teks.
//
// Satu baris terminal sekitar dua kali lebih tinggi daripada lebarnya, jadi dua baris kisi
// digabung ke satu baris teks memakai karakter setengah blok, supaya QR tampak kotak dan tidak
// terlalu tinggi:
//
//     atas gelap, bawah gelap  ->  █
//     atas gelap, bawah terang ->  ▀
//     atas terang, bawah gelap ->  ▄
//     keduanya terang          ->  (spasi)
//
// WARNA: dicetak hitam di atas latar putih (kode ANSI) dengan tepi putih di sekelilingnya. Ini
// yang membuat QR terbaca baik di terminal bertema gelap maupun terang. Tanpa warna eksplisit,
// terminal gelap akan menampilkan QR terbalik, dan banyak pemindai gagal membacanya.
//
// Didukung Windows Terminal, PowerShell/cmd modern (Windows 10 ke atas), macOS Terminal, dan
// terminal Linux umum.
import QRCode from "qrcode";

const QUIET_ZONE = 2; // lebar tepi terang di sekeliling, dalam modul
const BLACK_ON_WHITE = "\u001b[47m\u001b[30m";
const RESET = "\u001b[0m";

/** Kisi QR: `true` = modul gelap. Sudah termasuk tepi terang. */
export function qrMatrix(text: string): boolean[][] {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const total = size + QUIET_ZONE * 2;
  return Array.from({ length: total }, (_, row) =>
    Array.from({ length: total }, (_, col) => {
      const r = row - QUIET_ZONE;
      const c = col - QUIET_ZONE;
      return r >= 0 && c >= 0 && r < size && c < size && Boolean(qr.modules.get(r, c));
    }),
  );
}

/** QR sebagai teks siap cetak di terminal. */
export function renderQrForTerminal(text: string): string {
  const matrix = qrMatrix(text);
  const lines: string[] = [];
  for (let row = 0; row < matrix.length; row += 2) {
    const top = matrix[row] as boolean[];
    const bottom = matrix[row + 1]; // tidak ada pada kisi berjumlah baris ganjil = dianggap terang
    let line = "";
    for (let col = 0; col < top.length; col++) {
      const upper = top[col] === true;
      const lower = bottom?.[col] === true;
      line += upper && lower ? "█" : upper ? "▀" : lower ? "▄" : " ";
    }
    lines.push(`${BLACK_ON_WHITE}${line}${RESET}`);
  }
  return lines.join("\n");
}
