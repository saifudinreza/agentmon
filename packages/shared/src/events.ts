import { z } from "zod";
import {
  AutoApprovalStatusSchema,
  FinalApprovalStatusSchema,
  HunkDecisionSchema,
} from "./approval";
import { PolicyResultSchema, RiskSchema } from "./risk";

export const CONTRACT_VERSION = 1;

const nonEmpty = z.string().min(1);
const isoDate = z.iso.datetime({ offset: true });
const toolInput = z.record(z.string(), z.unknown());

export const AgentSchema = z.enum(["claude-code", "codex"]);
export type Agent = z.infer<typeof AgentSchema>;

const envelopeFields = {
  v: z.literal(CONTRACT_VERSION),
  id: z.uuid(),
  machineId: nonEmpty,
  sessionId: nonEmpty,
  seq: z.int().nonnegative(),
  ts: isoDate,
  agent: AgentSchema,
};

// Bentuk payload tiap jenis event. Ini versi awal: bentuk persisnya
// disesuaikan setelah data hook asli terlihat (lihat issue riset hook).
export const eventPayloads = {
  "session.started": z.object({
    cwd: nonEmpty,
    permissionMode: z.string().optional(),
  }),
  "tool.requested": z.object({
    toolName: nonEmpty,
    toolInput,
    toolUseId: z.string().optional(),
  }),
  "tool.completed": z.object({
    toolName: nonEmpty,
    toolUseId: z.string().optional(),
    ok: z.boolean(),
  }),
  "approval.requested": z.object({
    approvalId: nonEmpty,
    toolName: nonEmpty,
    toolInput,
    // Opsional dulu karena penilai risiko baru hadir di tahap berikutnya.
    risk: RiskSchema.optional(),
    summary: z.string().optional(),
    expiresAt: isoDate,
  }),
  "approval.resolved": z.object({
    approvalId: nonEmpty,
    status: FinalApprovalStatusSchema,
    comment: z.string().optional(),
    hunks: z.array(HunkDecisionSchema).optional(),
  }),
  "approval.auto_resolved": z.object({
    approvalId: nonEmpty,
    toolName: nonEmpty,
    status: AutoApprovalStatusSchema,
    policy: PolicyResultSchema,
    risk: RiskSchema.optional(),
  }),
  "agent.notification": z.object({
    message: nonEmpty,
    title: z.string().optional(),
  }),
  "agent.stopped": z.object({
    lastMessage: z.string().optional(),
  }),
  "turn.review_requested": z.object({
    turnId: nonEmpty,
    files: z.array(nonEmpty),
  }),
  "checkpoint.created": z.object({
    checkpointId: nonEmpty,
    approvalId: z.string().optional(),
  }),
  "checkpoint.restored": z.object({
    checkpointId: nonEmpty,
    // Checkpoint keadaan sebelum rollback, supaya rollback bisa dibatalkan.
    safetyCheckpointId: z.string().optional(),
  }),
  "session.recap": z.object({
    durationMs: z.int().nonnegative(),
    filesChanged: z.array(nonEmpty),
    rejected: z.int().nonnegative(),
    autoApproved: z.int().nonnegative(),
  }),
} as const;

export type EventType = keyof typeof eventPayloads;
export const EVENT_TYPES = Object.keys(eventPayloads) as EventType[];

// Amplop longgar: hanya memastikan bentuk umum, tanpa memeriksa type dan payload.
// Dipakai untuk mengenali event dari versi yang lebih baru tanpa gagal.
export const EnvelopeSchema = z.object({
  ...envelopeFields,
  type: nonEmpty,
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

const event = <T extends EventType>(type: T) =>
  z.object({
    ...envelopeFields,
    type: z.literal(type),
    payload: eventPayloads[type],
  });

export const EventSchema = z.discriminatedUnion("type", [
  event("session.started"),
  event("tool.requested"),
  event("tool.completed"),
  event("approval.requested"),
  event("approval.resolved"),
  event("approval.auto_resolved"),
  event("agent.notification"),
  event("agent.stopped"),
  event("turn.review_requested"),
  event("checkpoint.created"),
  event("checkpoint.restored"),
  event("session.recap"),
]);
export type AgentMonEvent = z.infer<typeof EventSchema>;
