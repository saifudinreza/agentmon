// Log lokal daemon dengan rotasi sederhana: saat berkas melewati batas ukuran, isinya
// dipindah ke "<berkas>.1" (menimpa yang lama), lalu log baru dimulai.
//
// Aturan penting: log TIDAK pernah berisi isi pesan hook (kode, perintah, jawaban),
// hanya nama event dan keputusan. Penulis log bertanggung jawab memilih apa yang dicatat.
import { appendFileSync, renameSync, statSync } from "node:fs";

export type Logger = {
  info(message: string): void;
  error(message: string): void;
};

export const DEFAULT_LOG_MAX_BYTES = 1_000_000;

export function createLogger(file: string, maxBytes = DEFAULT_LOG_MAX_BYTES): Logger {
  const write = (level: string, message: string) => {
    // Pencatatan tidak boleh mematikan daemon: kegagalan (disk penuh, berkas terkunci)
    // diabaikan begitu saja.
    try {
      // Pesan bisa memuat teks dari luar (path, nama alat). Baris baru dibuang supaya
      // tidak ada yang bisa menyisipkan baris log palsu.
      const line = `${new Date().toISOString()} ${level} ${message.replace(/[\r\n]+/g, " ")}\n`;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // berkas belum ada
      }
      if (size > 0 && size + line.length > maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, line);
    } catch {
      // sengaja diabaikan
    }
  };
  return {
    info: (message) => write("INFO", message),
    error: (message) => write("ERROR", message),
  };
}
