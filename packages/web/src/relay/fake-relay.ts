// Pembantu KHUSUS TEST: relay tiruan di sisi data (laptop, sesi, event yang "tersimpan") beserta API yang
// membacanya. Dipakai test store dan test layar. Tidak dipakai kode aplikasi.
import type { DeviceMachine, Envelope, SessionSummary } from "@agentmon/shared";
import { vi } from "vitest";
import type { RelayApi } from "./api";
import { sessionKey } from "./relay-store";

export const MACHINES: DeviceMachine[] = [{ id: "m1", name: "Laptop Kantor", online: true }];
export const summary = (id: string, last: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  agent: "claude-code",
  status: "active",
  startedAt: "2026-11-11T09:00:00.000Z",
  lastEventAt: last,
  endedAt: null,
  ...extra,
});

let counter = 0;
export const ev = (seq: number, extra: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  machineId: "m1",
  sessionId: "s1",
  seq,
  ts: `2026-11-11T10:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}.000Z`,
  agent: "claude-code",
  type: "tool.requested",
  payload: {},
  ...extra,
});

// Server tiruan di sisi relay: data yang "tersimpan", dan API yang membacanya.
export function fakeRelay() {
  const data = {
    machines: [...MACHINES] as DeviceMachine[],
    sessions: { m1: [summary("s1", "2026-11-11T10:00:00.000Z")] } as Record<string, SessionSummary[]>,
    events: { "m1/s1": [] as Envelope[] } as Record<string, Envelope[]>,
  };
  const fail: { machines?: Error; sessions?: Error; events?: Error } = {};
  const calls = { machines: 0, sessions: 0, eventsAfter: [] as number[] };
  let gate: Promise<void> | undefined;
  const api: RelayApi = {
    machines: vi.fn(async () => {
      calls.machines++;
      if (gate) await gate;
      if (fail.machines) throw fail.machines;
      return [...data.machines];
    }),
    sessions: vi.fn(async (machineId: string) => {
      calls.sessions++;
      if (fail.sessions) throw fail.sessions;
      return [...(data.sessions[machineId] ?? [])];
    }),
    events: vi.fn(async () => ({ events: [], hasMore: false })),
    eventsAfter: vi.fn(async (machineId: string, sessionId: string, afterSeq: number, onPage?: (e: Envelope[]) => void) => {
      calls.eventsAfter.push(afterSeq);
      if (fail.events) throw fail.events;
      const rest = (data.events[sessionKey(machineId, sessionId)] ?? []).filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
      for (let i = 0; i < rest.length; i += 3) {
        await Promise.resolve();
        onPage?.(rest.slice(i, i + 3));
      }
      return rest;
    }),
  };
  return {
    data,
    api,
    fail,
    calls,
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
  };
}

