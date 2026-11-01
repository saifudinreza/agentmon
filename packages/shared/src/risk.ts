import { z } from "zod";

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskSchema = z.object({
  level: RiskLevelSchema,
  reasons: z.array(
    z.object({
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  ),
});
export type Risk = z.infer<typeof RiskSchema>;

export const PolicyResultSchema = z.object({
  action: z.enum(["allow", "ask", "deny"]),
  // null berarti hasil default, bukan dari aturan tertentu.
  ruleId: z.string().nullable(),
});
export type PolicyResult = z.infer<typeof PolicyResultSchema>;
