import type { Envelope } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { computePendingApprovals } from "./approvals";

let n = 0;
const base = (type: string, payload: unknown, extra: Partial<Envelope> = {}): Envelope => ({
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
const NOW = new Date("2026-11-11T10:05:00.000Z");
const requested = (approvalId: string, expiresAt = "2026-11-11T10:09:00.000Z", extra: Record<string, unknown> = {}, env: Partial<Envelope> = {}) =>
  base("approval.requested", { approvalId, toolName: "Write", toolInput: { file_path: "a.ts" }, expiresAt, ...extra }, env);
const resolved = (approvalId: string, env: Partial<Envelope> = {}) => base("approval.resolved", { approvalId, status: "approved" }, env);

describe("computePendingApprovals", () => {
  test("permintaan yang belum selesai dan belum kedaluwarsa menunggu, lengkap dengan isinya", () => {
    const [item] = computePendingApprovals([requested("a1", undefined, { summary: "+3 -1 (2 hunk)", risk: { level: "high", reasons: [] } })], NOW);
    expect(item).toMatchObject({ machineId: "m1", sessionId: "s1", approvalId: "a1", toolName: "Write", summary: "+3 -1 (2 hunk)", expiresAt: "2026-11-11T10:09:00.000Z", requestedAt: "2026-11-11T10:00:00.000Z" });
    expect(item?.toolInput).toEqual({ file_path: "a.ts" });
    expect(item?.risk?.level).toBe("high");
  });

  test.each(["approval.resolved", "approval.auto_resolved"])("yang sudah punya penyelesaian (%s) tidak lagi menunggu", (type) => {
    const payload = type === "approval.resolved" ? { approvalId: "a1", status: "denied" } : { approvalId: "a1", toolName: "Write", status: "auto_denied", policy: { action: "deny", ruleId: null } };
    expect(computePendingApprovals([requested("a1"), base(type, payload)], NOW)).toEqual([]);
  });

  test("kedaluwarsa tidak menunggu, termasuk tepat di batas waktunya", () => {
    expect(computePendingApprovals([requested("a1", "2026-11-11T10:04:59.000Z")], NOW)).toEqual([]);
    expect(computePendingApprovals([requested("a1", "2026-11-11T10:05:00.000Z")], NOW)).toEqual([]);
    expect(computePendingApprovals([requested("a1", "2026-11-11T10:05:01.000Z")], NOW)).toHaveLength(1);
  });

  test("nomor izin yang sama di sesi BERBEDA tidak saling menutup", () => {
    const result = computePendingApprovals([requested("a1", undefined, {}, { sessionId: "s1" }), requested("a1", undefined, {}, { sessionId: "s2" }), resolved("a1", { sessionId: "s1" })], NOW);
    expect(result.map((r) => r.sessionId)).toEqual(["s2"]);
  });

  test("penyelesaian ganda tidak menghidupkan lagi apa pun yang sudah ditutup", () => {
    expect(computePendingApprovals([requested("a1"), resolved("a1"), resolved("a1")], NOW)).toEqual([]);
  });

  test("berisiko tinggi di atas, lalu yang paling cepat kedaluwarsa", () => {
    const result = computePendingApprovals(
      [
        requested("rendah-lama", "2026-11-11T10:08:00.000Z", { risk: { level: "low", reasons: [] } }),
        requested("tanpa-risiko-cepat", "2026-11-11T10:06:00.000Z"),
        requested("tinggi-lama", "2026-11-11T10:09:00.000Z", { risk: { level: "high", reasons: [] } }),
        requested("tinggi-cepat", "2026-11-11T10:07:00.000Z", { risk: { level: "high", reasons: [] } }),
      ],
      NOW,
    );
    expect(result.map((r) => r.approvalId)).toEqual(["tinggi-cepat", "tinggi-lama", "tanpa-risiko-cepat", "rendah-lama"]);
  });

  test("event yang bentuknya tidak sah atau jenis lain diabaikan tanpa galat", () => {
    const result = computePendingApprovals([base("approval.requested", { approvalId: 5 }), base("tool.requested", { toolName: "x", toolInput: {} }), requested("a1")], NOW);
    expect(result.map((r) => r.approvalId)).toEqual(["a1"]);
  });

  test("diff ikut dibawa", () => {
    const diff = { path: "a.ts", toolName: "Write", sensitive: [], change: { type: "unchanged", formatChanged: false, format: { oldEol: "lf", newEol: "lf", oldFinalNewline: true, newFinalNewline: true } } };
    expect(computePendingApprovals([requested("a1", undefined, { diff })], NOW)[0]?.diff).toEqual(diff);
  });

  test("daftar kosong", () => {
    expect(computePendingApprovals([], NOW)).toEqual([]);
  });
});
