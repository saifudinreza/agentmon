// =====================================================================================
// FILE INI: bentuk data "perubahan sebuah berkas" (diff) yang dihitung daemon.
// =====================================================================================
//
// Diff = daftar perbedaan antara isi berkas SEKARANG dan isi yang DIUSULKAN agent. Daemon
// menghitungnya (bridge/src/diff), lalu bentuk datanya dipakai bersama oleh:
//   - halaman web lokal dan HP, untuk menampilkan perubahan yang enak dibaca;
//   - fitur "terima sebagian", yang menyetujui sebagian HUNK dan menolak sisanya.
// Karena dipakai banyak pihak, bentuknya didefinisikan di sini (paket shared), sama seperti
// kontrak pesan.
//
// ISTILAH:
//   Hunk = satu potongan perubahan. Anggap berkas itu buku dan hunk satu paragraf yang
//          direvisi: paragraf 1 boleh diterima sementara paragraf 2 ditolak.
//   Context = baris yang tidak berubah di sekitar perubahan, supaya mudah dipahami letaknya.
//
// Analogi untuk hasil perhitungannya: "mode lacak perubahan" di aplikasi dokumen. Baris merah
// dicoret (remove), baris hijau ditambahkan (add), baris abu-abu tidak berubah (context).
import { z } from "zod";

// Satu baris dalam hunk. Nomor baris dimulai dari 1. Baris yang dihapus hanya punya nomor lama,
// baris yang ditambah hanya punya nomor baru, baris konteks punya keduanya.
export const DiffLineSchema = z.object({
  type: z.enum(["context", "add", "remove"]),
  text: z.string(), // isi baris, tanpa penanda akhir baris
  oldLine: z.int().positive().optional(),
  newLine: z.int().positive().optional(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

// Satu hunk. Penomoran mengikuti kebiasaan "unified diff": `oldStart` dan `newStart` adalah
// nomor baris pertama (dari 1); bila jumlah barisnya 0, nilainya baris SEBELUM titik itu.
export const DiffHunkSchema = z.object({
  id: z.string().min(1), // "h1", "h2", ... dipakai sebagai hunkId pada keputusan terima sebagian
  oldStart: z.int().nonnegative(),
  oldLines: z.int().nonnegative(),
  newStart: z.int().nonnegative(),
  newLines: z.int().nonnegative(),
  lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

// Alasan sebuah path ditandai sensitif. `code` untuk mesin, `message` untuk manusia (sama
// gayanya dengan alasan pada risiko).
export const SensitiveReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type SensitiveReason = z.infer<typeof SensitiveReasonSchema>;

// Cara berkas menandai akhir baris. "none" = tidak ada akhir baris sama sekali (berkas satu baris
// tanpa enter, atau berkas kosong). "mixed" = campuran gaya Windows dan Unix.
export const EolSchema = z.enum(["lf", "crlf", "mixed", "none"]);
export type Eol = z.infer<typeof EolSchema>;

// Perbedaan format yang tidak termasuk isi baris: gaya akhir baris dan ada tidaknya enter di
// akhir berkas. Disimpan terpisah supaya perubahan format murni tidak mengotori daftar hunk.
export const DiffFormatSchema = z.object({
  oldEol: EolSchema,
  newEol: EolSchema,
  oldFinalNewline: z.boolean(),
  newFinalNewline: z.boolean(),
});
export type DiffFormat = z.infer<typeof DiffFormatSchema>;

// Hasil perhitungan untuk satu berkas: tepat salah satu dari lima bentuk, dibedakan oleh `type`.
export const FileChangeSchema = z.discriminatedUnion("type", [
  // Perubahan teks biasa, lengkap dengan hunk-nya.
  z.object({
    type: z.literal("text"),
    isNew: z.boolean(), // berkas belum ada sebelumnya
    hunks: z.array(DiffHunkSchema),
    added: z.int().nonnegative(), // jumlah baris yang ditambah
    removed: z.int().nonnegative(), // jumlah baris yang dihapus
    format: DiffFormatSchema,
  }),
  // Isinya sama. `formatChanged` benar bila hanya gaya akhir baris atau enter di akhir yang berbeda.
  z.object({ type: z.literal("unchanged"), formatChanged: z.boolean(), format: DiffFormatSchema }),
  // Berkas biner (bukan teks UTF-8). Isinya tidak ditampilkan.
  z.object({
    type: z.literal("binary"),
    isNew: z.boolean(),
    oldBytes: z.int().nonnegative().optional(),
    newBytes: z.int().nonnegative().optional(),
  }),
  // Terlalu besar untuk dihitung penuh. Hanya ringkasan, supaya memori tidak habis.
  z.object({
    type: z.literal("too_large"),
    isNew: z.boolean(),
    oldBytes: z.int().nonnegative().optional(),
    newBytes: z.int().nonnegative().optional(),
    oldLines: z.int().nonnegative().optional(),
    newLines: z.int().nonnegative().optional(),
    added: z.int().nonnegative().optional(), // perkiraan atas
    removed: z.int().nonnegative().optional(),
    message: z.string().min(1),
  }),
  // Usulan agent tidak bisa diterapkan pada isi berkas yang ada sekarang.
  z.object({
    type: z.literal("mismatch"),
    reason: z.enum(["file_missing", "old_string_not_found", "old_string_ambiguous", "old_string_empty", "unreadable"]),
    message: z.string().min(1),
    editIndex: z.int().nonnegative().optional(), // untuk MultiEdit: edit ke berapa yang gagal
  }),
]);
export type FileChange = z.infer<typeof FileChangeSchema>;

// Diff lengkap untuk satu aksi agent pada satu berkas.
export const FileDiffSchema = z.object({
  path: z.string().min(1), // persis seperti yang diminta agent
  toolName: z.string().min(1),
  sensitive: z.array(SensitiveReasonSchema), // kosong = tidak ada yang ditandai
  change: FileChangeSchema,
});
export type FileDiff = z.infer<typeof FileDiffSchema>;
