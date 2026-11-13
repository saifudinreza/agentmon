import { describe, expect, test } from "vitest";
import { createSessionActivity } from "./session-activity";

describe("pelacak aktivitas sesi", () => {
  test("sesi yang tidak dikenal dianggap diam (rollback tidak terkunci)", () => {
    expect(createSessionActivity().isRunning("s1")).toBe(false);
  });

  test("event alat, izin, atau sesi mulai berarti berjalan; agent.stopped dan session.recap berarti selesai", () => {
    const a = createSessionActivity();
    for (const type of ["session.started", "tool.requested", "tool.completed", "approval.requested", "approval.resolved", "agent.notification", "checkpoint.created"]) {
      a.record({ sessionId: "s1", type });
      expect(a.isRunning("s1"), type).toBe(true);
    }
    a.record({ sessionId: "s1", type: "agent.stopped" });
    expect(a.isRunning("s1")).toBe(false);
    a.record({ sessionId: "s1", type: "tool.requested" });
    a.record({ sessionId: "s1", type: "session.recap" });
    expect(a.isRunning("s1")).toBe(false);
  });

  test("checkpoint.restored tidak mengubah keadaan (bukan tanda agent bekerja, bukan tanda selesai)", () => {
    const a = createSessionActivity();
    a.record({ sessionId: "s1", type: "agent.stopped" });
    a.record({ sessionId: "s1", type: "checkpoint.restored" });
    expect(a.isRunning("s1")).toBe(false);
    a.record({ sessionId: "s2", type: "tool.requested" });
    a.record({ sessionId: "s2", type: "checkpoint.restored" });
    expect(a.isRunning("s2")).toBe(true);
  });

  test("sesi tanpa kabar melewati batas dianggap diam, dan sesi lain tidak terpengaruh", () => {
    const clock = { ms: 0 };
    const a = createSessionActivity({ now: () => clock.ms, staleMs: 1000 });
    a.record({ sessionId: "s1", type: "tool.requested" });
    clock.ms = 999;
    a.record({ sessionId: "s2", type: "tool.requested" });
    expect(a.isRunning("s1")).toBe(true);
    clock.ms = 1000;
    expect(a.isRunning("s1")).toBe(false);
    expect(a.isRunning("s2")).toBe(true);
  });
});
