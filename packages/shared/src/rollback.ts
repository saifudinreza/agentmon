// =====================================================================================
// FILE INI: bentuk perintah dan balasan ROLLBACK (kembali ke checkpoint) antara HP dan laptop.
// =====================================================================================
//
// Alurnya dua langkah supaya yang disetujui pengguna sama dengan yang dikerjakan:
//   1. HP mengirim `rollback.preview` -> laptop membalas daftar berkas yang akan berubah dan sidik (hash) daftar itu.
//   2. HP mengirim `rollback.apply` beserta sidik tadi -> laptop menghitung ulang; bila daftarnya sudah berbeda
//      (pekerjaan berubah sejak pratinjau), ditolak (`preview_changed`) dan HP harus meminta pratinjau lagi.
// Membatalkan rollback = rollback ke `safetyCheckpointId` yang dikembalikan oleh rollback sebelumnya.
import { z } from "zod";

export const ROLLBACK_PREVIEW_COMMAND = "rollback.preview";
export const ROLLBACK_APPLY_COMMAND = "rollback.apply";
export const ROLLBACK_RESULT_REPLY = "rollback.result";

const checkpointId = z.string().min(1).max(200);
const commandId = z.string().uuid();

export const RollbackPreviewCommandSchema = z.object({ type: z.literal(ROLLBACK_PREVIEW_COMMAND), commandId, checkpointId });
export type RollbackPreviewCommand = z.infer<typeof RollbackPreviewCommandSchema>;

export const RollbackApplyCommandSchema = z.object({
  type: z.literal(ROLLBACK_APPLY_COMMAND),
  commandId,
  checkpointId,
  /** Sidik daftar berkas dari pratinjau yang dilihat dan disetujui pengguna. */
  previewHash: z.string().min(1).max(200),
});
export type RollbackApplyCommand = z.infer<typeof RollbackApplyCommandSchema>;

/** Apa yang akan terjadi pada satu berkas: dibuat lagi (restore), dikembalikan isinya (overwrite), atau dihapus (delete). */
export const RollbackChangeKindSchema = z.enum(["restore", "overwrite", "delete"]);
export type RollbackChangeKind = z.infer<typeof RollbackChangeKindSchema>;

export const RollbackFileChangeSchema = z.object({ path: z.string().max(1000), change: RollbackChangeKindSchema });
export type RollbackFileChange = z.infer<typeof RollbackFileChangeSchema>;

export const ROLLBACK_REFUSAL_REASONS = [
  "not_found", // checkpoint tidak dikenal laptop
  "agent_running", // agent masih berjalan di sesi itu
  "checkpoint_missing", // ref checkpoint sudah hilang dari repo
  "checkpoint_invalid", // checkpoint ada tetapi rusak / tidak bisa dibaca
  "preview_changed", // daftar berkas berubah sejak pratinjau
  "safety_failed", // keadaan sekarang tidak bisa disimpan, jadi tidak ada yang diubah
  "busy", // rollback lain sedang berjalan untuk repo itu
  "unsafe_path", // ada jalur berkas yang tidak aman (keluar dari repo)
  "ignored_conflict", // ada berkas yang diabaikan git di jalur yang akan ditimpa; ditolak supaya tidak hilang
] as const;
export const RollbackRefusalReasonSchema = z.enum(ROLLBACK_REFUSAL_REASONS);

const base = { type: z.literal(ROLLBACK_RESULT_REPLY), commandId, checkpointId };

export const RollbackResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...base,
    outcome: z.literal("preview"),
    /** Paling banyak sejumlah tertentu berkas ditampilkan; `total` selalu jumlah sebenarnya. */
    files: z.array(RollbackFileChangeSchema),
    total: z.int().nonnegative(),
    /** Jumlah per jenis dari daftar PENUH (bukan hanya yang ditampilkan). */
    counts: z.object({ restore: z.int().nonnegative(), overwrite: z.int().nonnegative(), delete: z.int().nonnegative() }),
    truncated: z.boolean(),
    previewHash: z.string().min(1),
    agentRunning: z.boolean(),
  }),
  z.object({
    ...base,
    outcome: z.literal("applied"),
    /** Keadaan sebelum rollback; kirim rollback ke nomor ini untuk membatalkan. Kosong bila tidak ada yang berubah. */
    safetyCheckpointId: z.string().optional(),
    changed: z.int().nonnegative(),
  }),
  z.object({ ...base, outcome: z.literal("refused"), reason: RollbackRefusalReasonSchema, message: z.string().max(500) }),
  z.object({
    ...base,
    outcome: z.literal("failed"),
    message: z.string().max(500),
    /** Gagal di tengah jalan, tetapi keadaan sebelumnya berhasil dipulihkan otomatis. */
    recovered: z.boolean(),
    safetyCheckpointId: z.string().optional(),
  }),
]);
export type RollbackResult = z.infer<typeof RollbackResultSchema>;
