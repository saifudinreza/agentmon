import type { Envelope, PendingApproval } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { approvalFromEvent, approvalKey, formatRemaining, isExpired, mergeApprovals, remainingMs, resolutionFromEvent, sortApprovals } from "./model";

let n = 0;
const env = (type: string, payload: unknown, extra: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  machineId: "m1",
  sessionId: "s1",
  seq: n,
  ts: "2026-11-11T10:00:00.000Z",
  agent: "claude-code",
  type,
  payload,
  ...extra,
});
const pending = (approvalId: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  machineId: "m1",
  sessionId: "s1",
  approvalId,
  toolName: "Bash",
  toolInput: { command: "ls" },
  requestedAt: "2026-11-11T10:00:00.000Z",
  expiresAt: "2026-11-11T10:09:00.000Z",
  ...extra,
});

describe("approvalFromEvent", () => {
  test("membaca permintaan izin lengkap dengan isinya", () => {
    const diff = { path: "a.ts", toolName: "Edit", sensitive: [], change: { type: "binary", isNew: false } };
    const result = approvalFromEvent(env("approval.requested", { approvalId: "a1", toolName: "Edit", toolInput: { file_path: "a.ts" }, summary: "+1 -1", risk: { level: "high", reasons: [] }, diff, expiresAt: "2026-11-11T10:09:00.000Z" }));
    expect(result).toEqual({
      machineId: "m1",
      sessionId: "s1",
      approvalId: "a1",
      toolName: "Edit",
      toolInput: { file_path: "a.ts" },
      summary: "+1 -1",
      risk: { level: "high", reasons: [] },
      diff,
      requestedAt: "2026-11-11T10:00:00.000Z",
      expiresAt: "2026-11-11T10:09:00.000Z",
    });
  });

  test("bidang opsional yang tidak ada tidak muncul sebagai undefined", () => {
    const result = approvalFromEvent(env("approval.requested", { approvalId: "a1", toolName: "Bash", toolInput: {}, expiresAt: "2026-11-11T10:09:00.000Z" }));
    expect(Object.keys(result ?? {}).sort()).toEqual(["approvalId", "expiresAt", "machineId", "requestedAt", "sessionId", "toolInput", "toolName"]);
  });

  test.each([
    ["jenis lain", env("tool.requested", { toolName: "x", toolInput: {} })],
    ["isi rusak", env("approval.requested", { approvalId: 5 })],
    ["tanpa batas waktu", env("approval.requested", { approvalId: "a", toolName: "x", toolInput: {} })],
  ])("undefined untuk %s", (_name, event) => {
    expect(approvalFromEvent(event)).toBeUndefined();
  });
});

describe("resolutionFromEvent", () => {
  test("keputusan manusia dan keputusan otomatis", () => {
    expect(resolutionFromEvent(env("approval.resolved", { approvalId: "a1", status: "denied" }))).toEqual({ machineId: "m1", approvalId: "a1", status: "denied" });
    expect(resolutionFromEvent(env("approval.auto_resolved", { approvalId: "a2", toolName: "Read", status: "auto_approved", policy: { action: "allow", ruleId: null } }))).toEqual({ machineId: "m1", approvalId: "a2", status: "auto_approved" });
  });
  test("jenis lain dan isi rusak: undefined", () => {
    expect(resolutionFromEvent(env("tool.completed", { toolName: "x", ok: true }))).toBeUndefined();
    expect(resolutionFromEvent(env("approval.resolved", { approvalId: "a1", status: "aneh" }))).toBeUndefined();
  });
});

describe("sortApprovals", () => {
  test("berisiko tinggi di atas, lalu paling cepat kedaluwarsa, lalu nomor (pasti)", () => {
    const sorted = sortApprovals([
      pending("rendah", { risk: { level: "low", reasons: [] }, expiresAt: "2026-11-11T10:01:00.000Z" }),
      pending("tanpa-risiko", { expiresAt: "2026-11-11T10:02:00.000Z" }),
      pending("tinggi-lama", { risk: { level: "high", reasons: [] }, expiresAt: "2026-11-11T10:08:00.000Z" }),
      pending("tinggi-cepat", { risk: { level: "high", reasons: [] }, expiresAt: "2026-11-11T10:03:00.000Z" }),
      pending("b", { expiresAt: "2026-11-11T10:02:00.000Z" }),
    ]);
    expect(sorted.map((a) => a.approvalId)).toEqual(["tinggi-cepat", "tinggi-lama", "b", "tanpa-risiko", "rendah"]);
  });
  test("tidak mengubah masukan", () => {
    const input = Object.freeze([pending("b"), pending("a")]);
    expect(() => sortApprovals(input)).not.toThrow();
    expect(input.map((a) => a.approvalId)).toEqual(["b", "a"]);
  });
});

describe("mergeApprovals", () => {
  test("menyatukan relay dan event langsung tanpa ganda", () => {
    const merged = mergeApprovals([pending("a1"), pending("a2")], [pending("a2"), pending("a3")], {});
    expect(merged.map((a) => a.approvalId).sort()).toEqual(["a1", "a2", "a3"]);
  });
  test("yang sudah diketahui selesai dibuang walau relay masih menyebutnya", () => {
    const merged = mergeApprovals([pending("a1"), pending("a2")], [], { [approvalKey("m1", "a1")]: "approved" });
    expect(merged.map((a) => a.approvalId)).toEqual(["a2"]);
  });
  test("nomor izin yang sama di laptop berbeda tidak saling menutup", () => {
    const merged = mergeApprovals([pending("a1"), pending("a1", { machineId: "m2" })], [], { [approvalKey("m1", "a1")]: "denied" });
    expect(merged.map((a) => a.machineId)).toEqual(["m2"]);
  });
});

describe("waktu", () => {
  const approval = { expiresAt: "2026-11-11T10:09:00.000Z" };
  const at = (iso: string) => Date.parse(iso);
  test("sisa waktu tidak pernah negatif", () => {
    expect(remainingMs(approval, at("2026-11-11T10:08:00.000Z"))).toBe(60_000);
    expect(remainingMs(approval, at("2026-11-11T10:09:00.000Z"))).toBe(0);
    expect(remainingMs(approval, at("2026-11-11T11:00:00.000Z"))).toBe(0);
  });
  test("kedaluwarsa tepat di batas, dan batas waktu rusak dianggap kedaluwarsa (aman: tidak bisa diputuskan)", () => {
    expect(isExpired(approval, at("2026-11-11T10:08:59.999Z"))).toBe(false);
    expect(isExpired(approval, at("2026-11-11T10:09:00.000Z"))).toBe(true);
    expect(isExpired({ expiresAt: "bukan-tanggal" }, 0)).toBe(true);
  });
  test.each([
    [0, "0:00"],
    [1, "0:01"],
    [7_000, "0:07"],
    [59_001, "1:00"],
    [60_000, "1:00"],
    [522_000, "8:42"],
    [540_000, "9:00"],
  ])("formatRemaining(%s) = %s", (ms, expected) => expect(formatRemaining(ms)).toBe(expected));
});
