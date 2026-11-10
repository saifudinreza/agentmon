import { EVENT_TYPES, type AgentMonEvent } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { createTimeline, summarizeEvent } from "./timeline";

const base = { v: 1, id: "11111111-1111-4111-8111-111111111111", machineId: "m", sessionId: "s1", seq: 0, ts: "2026-11-10T10:00:00.000Z", agent: "claude-code" } as const;
const event = (type: string, payload: Record<string, unknown>, seq = 0) => ({ ...base, seq, type, payload }) as unknown as AgentMonEvent;

describe("summarizeEvent", () => {
  test.each([
    [event("session.started", { cwd: "C:/proyek" }), "sesi dimulai"],
    [event("tool.requested", { toolName: "Write", toolInput: {} }), "alat diminta: Write"],
    [event("tool.completed", { toolName: "Bash", ok: true }), "alat selesai: Bash"],
    [event("tool.completed", { toolName: "Bash", ok: false }), "alat selesai: Bash (dihentikan)"],
    [event("approval.requested", { approvalId: "a", toolName: "Edit", toolInput: {}, expiresAt: base.ts }), "menunggu keputusan: Edit"],
    [event("approval.resolved", { approvalId: "a", status: "denied" }), "keputusan: denied"],
    [event("approval.auto_resolved", { approvalId: "a", toolName: "Read", status: "auto_approved", policy: { action: "allow", ruleId: null } }), "keputusan otomatis: auto_approved"],
    [event("agent.stopped", {}), "agent selesai satu giliran"],
  ])("%#", (e, expected) => {
    expect(summarizeEvent(e)).toBe(expected);
  });

  test("setiap jenis event di kontrak punya ringkasan (tidak ada yang terlewat)", () => {
    const payloads: Record<string, Record<string, unknown>> = {
      "session.started": { cwd: "x" },
      "tool.requested": { toolName: "T", toolInput: {} },
      "tool.completed": { toolName: "T", ok: true },
      "approval.requested": { approvalId: "a", toolName: "T", toolInput: {}, expiresAt: base.ts },
      "approval.resolved": { approvalId: "a", status: "approved" },
      "approval.auto_resolved": { approvalId: "a", toolName: "T", status: "auto_approved", policy: { action: "allow", ruleId: null } },
      "agent.notification": { message: "x" },
      "agent.stopped": {},
      "turn.review_requested": { turnId: "t", files: [] },
      "checkpoint.created": { checkpointId: "c" },
      "checkpoint.restored": { checkpointId: "c" },
      "session.recap": { durationMs: 1, filesChanged: [], rejected: 0, autoApproved: 0 },
    };
    for (const type of EVENT_TYPES) {
      expect(summarizeEvent(event(type, payloads[type] ?? {})).length, type).toBeGreaterThan(3);
    }
  });

  test("ringkasan TIDAK memuat isi: input alat, pesan agent, dan komentar pengguna", () => {
    const secrets = [
      event("tool.requested", { toolName: "Write", toolInput: { content: "RAHASIA-ISI", command: "RAHASIA-PERINTAH" } }),
      event("agent.notification", { message: "RAHASIA-PESAN", title: "RAHASIA-JUDUL" }),
      event("approval.resolved", { approvalId: "a", status: "denied", comment: "RAHASIA-KOMENTAR" }),
      event("agent.stopped", { lastMessage: "RAHASIA-TERAKHIR" }),
      event("session.started", { cwd: "C:/RAHASIA-FOLDER" }),
    ];
    const timeline = createTimeline();
    for (const e of secrets) timeline.record(e);
    expect(JSON.stringify(timeline.list())).not.toContain("RAHASIA");
  });
});

describe("createTimeline", () => {
  test("mencatat berurutan dari yang paling lama, lengkap dengan nomor urut dan nomor izin", () => {
    const timeline = createTimeline();
    timeline.record(event("tool.requested", { toolName: "Write", toolInput: {} }, 0));
    timeline.record(event("approval.requested", { approvalId: "izin-1", toolName: "Write", toolInput: {}, expiresAt: base.ts }, 1));
    expect(timeline.list()).toEqual([
      { ts: base.ts, type: "tool.requested", sessionId: "s1", seq: 0, summary: "alat diminta: Write" },
      { ts: base.ts, type: "approval.requested", sessionId: "s1", seq: 1, summary: "menunggu keputusan: Write", approvalId: "izin-1" },
    ]);
  });

  test("jumlahnya dibatasi: yang paling lama dibuang", () => {
    const timeline = createTimeline(3);
    for (let i = 0; i < 10; i++) timeline.record(event("agent.stopped", {}, i));
    expect(timeline.list().map((e) => e.seq)).toEqual([7, 8, 9]);
  });

  test("list() mengembalikan salinan: mengubahnya tidak memengaruhi timeline", () => {
    const timeline = createTimeline();
    timeline.record(event("agent.stopped", {}));
    const copy = timeline.list();
    copy[0]!.summary = "diubah";
    copy.pop();
    expect(timeline.list()).toHaveLength(1);
    expect(timeline.list()[0]?.summary).toBe("agent selesai satu giliran");
  });
});
