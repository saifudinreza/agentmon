import { describe, expect, test } from "vitest";
import { EVENT_TYPES, type EventType } from "./events";
import { parseEvent } from "./parse";

const risk = { level: "high", reasons: [{ code: "secret-file", message: "Menyentuh .env" }] };

// Bertipe Record<EventType, ...>: menambah jenis event tanpa contoh di sini akan gagal typecheck.
const validPayloads: Record<EventType, unknown> = {
  "session.started": { cwd: "D:/Dev/app", permissionMode: "default" },
  "tool.requested": { toolName: "Edit", toolInput: { file_path: "a.ts" }, toolUseId: "t1" },
  "tool.completed": { toolName: "Edit", toolUseId: "t1", ok: true },
  "approval.requested": {
    approvalId: "a1",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    risk,
    summary: "Menjalankan test",
    expiresAt: "2026-11-01T10:10:00Z",
  },
  "approval.resolved": {
    approvalId: "a1",
    status: "partially_approved",
    hunks: [{ hunkId: "h1", decision: "approve" }],
  },
  "approval.auto_resolved": {
    approvalId: "a2",
    toolName: "Bash",
    status: "auto_approved",
    policy: { action: "allow", ruleId: "tests-allowed" },
  },
  "agent.notification": { message: "Butuh izin" },
  "agent.stopped": { lastMessage: "Selesai" },
  "turn.review_requested": { turnId: "turn1", files: ["a.ts", "b.ts"] },
  "checkpoint.created": { checkpointId: "c1" },
  "checkpoint.restored": { checkpointId: "c1", safetyCheckpointId: "c2" },
  "session.recap": { durationMs: 120000, filesChanged: ["a.ts"], rejected: 1, autoApproved: 3 },
};

const envelope = (type: string, payload: unknown, overrides: object = {}) => ({
  v: 1,
  id: "3f6c1f0e-8f0b-4c1e-9a53-0c6f7a2b9d11",
  machineId: "laptop-1",
  sessionId: "sess-1",
  seq: 0,
  ts: "2026-11-01T10:00:00.000Z",
  agent: "claude-code",
  type,
  payload,
  ...overrides,
});

describe("parseEvent: data valid", () => {
  test.each(EVENT_TYPES)("menerima event %s", (type) => {
    const result = parseEvent(envelope(type, validPayloads[type]));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.event.type).toBe(type);
  });

  test("daftar jenis event sama dengan PRD §12", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "session.started",
        "tool.requested",
        "tool.completed",
        "approval.requested",
        "approval.resolved",
        "approval.auto_resolved",
        "agent.notification",
        "agent.stopped",
        "turn.review_requested",
        "checkpoint.created",
        "checkpoint.restored",
        "session.recap",
      ].sort(),
    );
  });

  test("menerima agent codex dan ts dengan offset zona waktu", () => {
    const result = parseEvent(
      envelope("agent.stopped", {}, { agent: "codex", ts: "2026-11-01T17:00:00+07:00" }),
    );
    expect(result.status).toBe("ok");
  });

  test("approval.requested boleh tanpa risk", () => {
    const withoutRisk = { ...(validPayloads["approval.requested"] as object), risk: undefined };
    expect(parseEvent(envelope("approval.requested", withoutRisk)).status).toBe("ok");
  });
});

describe("parseEvent: amplop tidak valid", () => {
  const cases: [string, object, string][] = [
    ["id bukan UUID", { id: "abc" }, "id"],
    ["seq negatif", { seq: -1 }, "seq"],
    ["seq pecahan", { seq: 1.5 }, "seq"],
    ["ts bukan ISO 8601", { ts: "kemarin" }, "ts"],
    ["agent tidak dikenal", { agent: "gemini" }, "agent"],
    ["sessionId kosong", { sessionId: "" }, "sessionId"],
    ["machineId hilang", { machineId: undefined }, "machineId"],
  ];

  test.each(cases)("menolak: %s", (_name, overrides, field) => {
    const result = parseEvent(envelope("agent.stopped", {}, overrides));
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toBe("malformed_envelope");
      expect(result.message).toContain(field);
    }
  });

  test("menolak versi kontrak yang tidak didukung dengan pesan jelas", () => {
    const result = parseEvent(envelope("agent.stopped", {}, { v: 2 }));
    expect(result).toMatchObject({ status: "invalid", reason: "unsupported_version" });
    if (result.status === "invalid") expect(result.message).toContain("2");
  });
});

describe("parseEvent: payload tidak valid", () => {
  test("menyebut field yang salah", () => {
    const result = parseEvent(envelope("tool.completed", { toolName: "Edit", ok: "ya" }));
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toBe("invalid_payload");
      expect(result.message).toContain("payload.ok");
    }
  });

  test("menolak payload yang hilang", () => {
    expect(parseEvent(envelope("session.started", undefined)).status).toBe("invalid");
  });

  test("menolak status approval yang bukan status akhir", () => {
    const result = parseEvent(envelope("approval.resolved", { approvalId: "a", status: "pending" }));
    expect(result.status).toBe("invalid");
  });

  test("menolak level risiko yang tidak dikenal", () => {
    const payload = {
      ...(validPayloads["approval.requested"] as object),
      risk: { level: "extreme", reasons: [] },
    };
    const result = parseEvent(envelope("approval.requested", payload));
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.message).toContain("payload.risk.level");
  });

  test("menolak aksi policy yang tidak dikenal", () => {
    const payload = {
      ...(validPayloads["approval.auto_resolved"] as object),
      policy: { action: "maybe", ruleId: null },
    };
    expect(parseEvent(envelope("approval.auto_resolved", payload)).status).toBe("invalid");
  });
});

describe("parseEvent: event tak dikenal dan input aneh", () => {
  test("jenis event baru dilaporkan tanpa error", () => {
    const result = parseEvent(envelope("session.teleported", { x: 1 }));
    expect(result.status).toBe("unknown_type");
    if (result.status === "unknown_type") expect(result.type).toBe("session.teleported");
  });

  test.each([null, undefined, "teks", 42, [], {}, () => 1])(
    "tidak melempar error untuk input %s",
    (input) => {
      expect(() => parseEvent(input)).not.toThrow();
      expect(parseEvent(input).status).toBe("invalid");
    },
  );
});
