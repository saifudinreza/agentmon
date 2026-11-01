import { z } from "zod";

// Status approval sesuai PRD §12. Status akhir dan status otomatis dipisah
// supaya tiap event hanya menerima status yang masuk akal.
export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "partially_approved",
  "denied",
  "timed_out",
  "cancelled",
  "auto_approved",
  "auto_denied",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const FinalApprovalStatusSchema = z.enum([
  "approved",
  "partially_approved",
  "denied",
  "timed_out",
  "cancelled",
]);
export type FinalApprovalStatus = z.infer<typeof FinalApprovalStatusSchema>;

export const AutoApprovalStatusSchema = z.enum(["auto_approved", "auto_denied"]);
export type AutoApprovalStatus = z.infer<typeof AutoApprovalStatusSchema>;

export const HunkDecisionSchema = z.object({
  hunkId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  comment: z.string().optional(),
});
export type HunkDecision = z.infer<typeof HunkDecisionSchema>;

// Keputusan pengguna dari HP. "partial" berarti sebagian hunk diterima,
// jadi wajib ada minimal satu hunk yang diterima dan satu yang ditolak.
export const ApprovalDecisionSchema = z
  .object({
    approvalId: z.string().min(1),
    decision: z.enum(["approve", "deny", "partial"]),
    comment: z.string().optional(),
    hunks: z.array(HunkDecisionSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision !== "partial") return;
    const hunks = value.hunks ?? [];
    const hasApprove = hunks.some((h) => h.decision === "approve");
    const hasReject = hunks.some((h) => h.decision === "reject");
    if (!hasApprove || !hasReject) {
      ctx.addIssue({
        code: "custom",
        path: ["hunks"],
        message:
          "keputusan 'partial' harus punya minimal satu hunk yang diterima dan satu yang ditolak",
      });
    }
  });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
