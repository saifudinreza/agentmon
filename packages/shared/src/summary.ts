// =====================================================================================
// FILE INI: bentuk data ringkasan perubahan yang disusun daemon = "LEMBAR RINGKAS" di atas diff.
// =====================================================================================
//
// Ringkasan ini DETERMINISTIK: disusun dari data diff dengan aturan tetap, tanpa AI, dan hanya memuat hal yang
// terbukti dari diff itu sendiri (berkas, jumlah baris, hunk, dan deklarasi yang barisnya berubah). Daemon hanya
// mengirim DATA; kalimatnya disusun di HP lewat i18n, jadi bahasa bisa diganti tanpa mengubah daemon.
//
// Yang SENGAJA tidak ada: klaim tentang maksud perubahan, atau "perubahan di dalam fungsi X" (itu butuh analisis
// ruang lingkup yang tidak bisa dibuktikan dari baris diff).
import { z } from "zod";

// Satu deklarasi (fungsi, kelas, tipe) yang BARIS deklarasinya sendiri ditambah atau dihapus. "changed" berarti nama
// yang sama muncul di baris yang dihapus DAN baris yang ditambah (mis. tanda tangannya berubah).
export const DeclarationSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(["function", "class", "type"]),
  status: z.enum(["added", "removed", "changed"]),
});
export type Declaration = z.infer<typeof DeclarationSchema>;

export const FileSummarySchema = z.object({
  path: z.string().max(1000),
  // Jenis perubahan pada berkas ini.
  change: z.enum(["modified", "new", "unchanged", "format_only", "binary", "too_large", "mismatch"]),
  added: z.int().nonnegative().optional(),
  removed: z.int().nonnegative().optional(),
  hunks: z.int().nonnegative().optional(),
  // Bahasa yang dikenali (menentukan apakah deklarasi bisa dideteksi). Kosong = tidak dikenali: ringkasan dasar saja.
  language: z.string().max(20).optional(),
  declarations: z.array(DeclarationSchema).max(10).optional(),
  // Ada deklarasi lebih banyak dari yang dicantumkan.
  moreDeclarations: z.boolean().optional(),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const DiffSummarySchema = z.object({
  files: z.array(FileSummarySchema).max(50),
  // Ada berkas lebih banyak dari yang dicantumkan.
  moreFiles: z.boolean().optional(),
});
export type DiffSummary = z.infer<typeof DiffSummarySchema>;
