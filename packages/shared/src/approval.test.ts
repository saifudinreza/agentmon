import { describe, expect, test } from "vitest";
import { ApprovalDecisionSchema, ApprovalStatusSchema } from "./approval";
import { PolicyResultSchema, RiskSchema } from "./risk";

describe("ApprovalDecisionSchema", () => {
  test("menerima approve dan deny dengan komentar", () => {
    expect(ApprovalDecisionSchema.safeParse({ approvalId: "a", decision: "approve" }).success).toBe(true);
    expect(
      ApprovalDecisionSchema.safeParse({ approvalId: "a", decision: "deny", comment: "terlalu luas" }).success,
    ).toBe(true);
  });

  test("menerima partial dengan hunk diterima dan ditolak", () => {
    const result = ApprovalDecisionSchema.safeParse({
      approvalId: "a",
      decision: "partial",
      hunks: [
        { hunkId: "h1", decision: "approve" },
        { hunkId: "h2", decision: "reject", comment: "ubah nama fungsi" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test.each([
    ["tanpa hunk", undefined],
    ["semua hunk diterima", [{ hunkId: "h1", decision: "approve" }]],
    ["semua hunk ditolak", [{ hunkId: "h1", decision: "reject" }]],
  ])("menolak partial %s dengan pesan jelas", (_name, hunks) => {
    const result = ApprovalDecisionSchema.safeParse({ approvalId: "a", decision: "partial", hunks });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain("partial");
  });

  test("menolak keputusan tanpa approvalId", () => {
    expect(ApprovalDecisionSchema.safeParse({ decision: "approve" }).success).toBe(false);
  });
});

describe("status, risiko, dan policy", () => {
  test("status approval sesuai PRD", () => {
    expect(ApprovalStatusSchema.options).toEqual([
      "pending",
      "approved",
      "partially_approved",
      "denied",
      "timed_out",
      "cancelled",
      "auto_approved",
      "auto_denied",
    ]);
  });

  test("risiko menolak level di luar rendah, sedang, tinggi", () => {
    expect(RiskSchema.safeParse({ level: "low", reasons: [] }).success).toBe(true);
    expect(RiskSchema.safeParse({ level: "critical", reasons: [] }).success).toBe(false);
  });

  test("policy menerima ruleId null sebagai default, tetapi tidak boleh hilang", () => {
    expect(PolicyResultSchema.safeParse({ action: "ask", ruleId: null }).success).toBe(true);
    expect(PolicyResultSchema.safeParse({ action: "ask" }).success).toBe(false);
  });
});
