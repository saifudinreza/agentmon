// =====================================================================================
// FILE INI: perintah dari HP ke laptop dan balasannya = "FORMULIR KEPUTUSAN" beserta "TANDA TERIMA".
// =====================================================================================
//
// HP memutuskan sebuah permintaan izin dengan mengirim PERINTAH (command) lewat relay ke laptop. Relay hanya
// meneruskan; yang memutuskan sah atau tidaknya adalah daemon di laptop (keputusan pertama yang berlaku, dan
// permintaan yang kedaluwarsa tidak bisa diputuskan: FR-28 dan FR-29). Karena itu laptop mengirim BALASAN
// (reply) kembali ke HP yang bertanya, berisi hasil sebenarnya:
//
//   applied           keputusan ini yang berlaku
//   already_resolved  permintaan sudah selesai lebih dulu (HP lain memutuskan, atau waktu habis); balasan memuat
//                     status yang sebenarnya berlaku, supaya HP bisa menjelaskannya
//   unknown           permintaan tidak dikenal laptop (sudah terlalu lama, atau daemon dimulai ulang)
//   invalid           bentuk keputusan salah
//
// Dua HP yang memutuskan bersamaan: hanya satu mendapat `applied`, yang lain `already_resolved` beserta status
// yang menang, sehingga ia tidak sekadar gagal tanpa penjelasan.
//
// `commandId` mengaitkan balasan dengan perintahnya (satu HP bisa punya beberapa keputusan yang sedang jalan).
import { z } from "zod";
import { ApprovalDecisionSchema, FinalApprovalStatusSchema } from "./approval";
import { FileDiffSchema } from "./diff";
import { DiffSummarySchema } from "./summary";
import { RiskSchema } from "./risk";

const isoDate = z.iso.datetime({ offset: true });

export const APPROVAL_DECISION_COMMAND = "approval.decision";
export const APPROVAL_RESULT_REPLY = "approval.result";

/** Perintah keputusan: isi keputusan biasa ditambah jenis dan nomor perintah. */
export const ApprovalDecisionCommandSchema = z.object({
  type: z.literal(APPROVAL_DECISION_COMMAND),
  commandId: z.uuid(),
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "deny", "partial"]),
  comment: z.string().max(2000).optional(),
  hunks: ApprovalDecisionSchema.shape.hunks,
});
export type ApprovalDecisionCommand = z.infer<typeof ApprovalDecisionCommandSchema>;

export const ApprovalReplySchema = z.object({
  type: z.literal(APPROVAL_RESULT_REPLY),
  commandId: z.string().min(1),
  approvalId: z.string().min(1),
  outcome: z.enum(["applied", "already_resolved", "unknown", "invalid"]),
  /** Status yang BERLAKU, untuk `applied` dan `already_resolved`. */
  status: FinalApprovalStatusSchema.optional(),
});
export type ApprovalReply = z.infer<typeof ApprovalReplySchema>;

// ---- Antrean izin yang menunggu (dibaca HP lewat API) ----
export const PendingApprovalSchema = z.object({
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  toolName: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()),
  summary: z.string().optional(),
  risk: RiskSchema.optional(),
  diff: FileDiffSchema.optional(),
  diffSummary: DiffSummarySchema.optional(),
  truncated: z.boolean().optional(),
  requestedAt: isoDate,
  expiresAt: isoDate,
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

export const ApprovalsResponseSchema = z.object({ approvals: z.array(PendingApprovalSchema) });
