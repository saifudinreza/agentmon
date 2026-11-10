// Pencatat log relay.
//
// ATURAN PENTING: log TIDAK PERNAH berisi isi pesan, token, maupun isi event. Isi pesan lewat
// relay bisa berupa kode atau data pengguna (dan mulai tahap 4 terenkripsi, yang tidak boleh
// bocor ke log juga). Yang boleh dicatat hanya kejadian umum: koneksi dibuka dan ditutup, peran,
// kode alasan penolakan, dan jumlah. Penulis log bertanggung jawab memilih apa yang dicatat.
export type Logger = {
  info(message: string): void;
  error(message: string): void;
};

// Pencatat yang tidak menulis apa pun (bawaan untuk test).
export const silentLogger: Logger = { info: () => undefined, error: () => undefined };

// Pencatat ke konsol, dengan cap waktu. Hosting seperti Render menangkap keluaran ini.
export function createConsoleLogger(): Logger {
  const line = (level: string, message: string) => `${new Date().toISOString()} ${level} ${message}`;
  return {
    info: (message) => console.log(line("INFO", message)),
    error: (message) => console.error(line("ERROR", message)),
  };
}
