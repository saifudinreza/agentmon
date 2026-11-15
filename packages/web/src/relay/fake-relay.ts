// Pembantu KHUSUS TEST: relay tiruan di sisi data (laptop, sesi, event yang "tersimpan") beserta API yang
// membacanya. Dipakai test store dan test layar. Tidak dipakai kode aplikasi.
import type { DeviceMachine, Envelope, ListedDevice, PendingApproval, PushConfigResponse, PushPreferences, PushSubscriptionRequest, SessionSummary } from "@agentmon/shared";
import { vi } from "vitest";
import type { RelayApi } from "./api";
import { sessionKey } from "./relay-store";

// Kunci publik VAPID tiruan: 65 byte (titik tak terkompresi) dalam base64url, 87 karakter.
export const FAKE_VAPID_PUBLIC_KEY = `B${"A".repeat(86)}`;
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
    approvals: [] as PendingApproval[],
    devices: [] as ListedDevice[],
    // Web Push: konfigurasi yang diberikan relay, langganan terakhir yang tersimpan, dan berapa kali dihapus.
    push: { config: { enabled: true, publicKey: FAKE_VAPID_PUBLIC_KEY } as PushConfigResponse, saved: undefined as PushSubscriptionRequest | undefined, removed: 0, prefs: { approvals: true, done: true } as PushPreferences },
  };
  const fail: { machines?: Error; sessions?: Error; events?: Error; approvals?: Error; devices?: Error; revoke?: Error; pushConfig?: Error; pushSave?: Error; pushRemove?: Error; pushPrefsLoad?: Error; pushPrefsSave?: Error } = {};
  const calls = { machines: 0, sessions: 0, eventsAfter: [] as number[] };
  let gate: Promise<void> | undefined;
  const api: RelayApi = {
    machines: vi.fn(async () => {
      calls.machines++;
      if (gate) await gate;
      if (fail.machines) throw fail.machines;
      return [...data.machines];
    }),
    devices: vi.fn(async () => {
      if (fail.devices) throw fail.devices;
      return [...data.devices];
    }),
    revokeDevice: vi.fn(async (deviceId: string) => {
      if (fail.revoke) throw fail.revoke;
      data.devices = data.devices.filter((d) => d.id !== deviceId);
    }),
    approvals: vi.fn(async () => {
      if (fail.approvals) throw fail.approvals;
      return [...data.approvals];
    }),
    pushConfig: vi.fn(async () => {
      if (fail.pushConfig) throw fail.pushConfig;
      return { ...data.push.config };
    }),
    savePushSubscription: vi.fn(async (subscription: PushSubscriptionRequest) => {
      if (fail.pushSave) throw fail.pushSave;
      data.push.saved = subscription;
    }),
    pushPreferences: vi.fn(async () => {
      if (fail.pushPrefsLoad) throw fail.pushPrefsLoad;
      return { ...data.push.prefs };
    }),
    savePushPreferences: vi.fn(async (update: Partial<PushPreferences>) => {
      if (fail.pushPrefsSave) throw fail.pushPrefsSave;
      data.push.prefs = { ...data.push.prefs, ...update };
      return { ...data.push.prefs };
    }),
    removePushSubscription: vi.fn(async () => {
      if (fail.pushRemove) throw fail.pushRemove;
      data.push.saved = undefined;
      data.push.removed++;
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

