import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RelayEntry } from "../relay/RelayProvider";
import type { RelayStore } from "../relay/relay-store";
import { approvalTag } from "./notification";
import { closeStaleApprovalNotifications, StaleNotificationCleaner, type NotificationLike } from "./stale";

const note = (tag: string): NotificationLike & { closed: boolean } => {
  const n = { tag, closed: false, close: () => void (n.closed = true) };
  return n;
};
const pending = (machineId: string, sessionId: string) => ({ machineId, sessionId });

describe("closeStaleApprovalNotifications", () => {
  test("menutup notifikasi izin yang sesinya tidak punya izin menunggu, dan membiarkan yang masih menunggu", async () => {
    const stale = note(approvalTag("m1", "s-selesai"));
    const alive = note(approvalTag("m1", "s-menunggu"));
    const closed = await closeStaleApprovalNotifications({ getNotifications: async () => [stale, alive] }, [pending("m1", "s-menunggu")]);
    expect(closed).toBe(1);
    expect(stale.closed).toBe(true);
    expect(alive.closed).toBe(false);
  });

  test("tanpa izin menunggu sama sekali: semua notifikasi izin ditutup", async () => {
    const list = [note(approvalTag("m1", "s1")), note(approvalTag("m1", "s2")), note(approvalTag("m2", "s1"))];
    expect(await closeStaleApprovalNotifications({ getNotifications: async () => list }, [])).toBe(3);
    expect(list.every((n) => n.closed)).toBe(true);
  });

  test("hanya notifikasi izin yang disentuh: 'selesai', uji, umum, dan tag lain dibiarkan", async () => {
    const others = [note("done:m1:s1"), note("test"), note("agentmon"), note(""), note("approvalx:m1:s1")];
    expect(await closeStaleApprovalNotifications({ getNotifications: async () => others }, [])).toBe(0);
    expect(others.some((n) => n.closed)).toBe(false);
  });

  test("laptop yang berbeda dengan nomor sesi sama tidak saling menyelamatkan", async () => {
    const m2 = note(approvalTag("m2", "s1"));
    await closeStaleApprovalNotifications({ getNotifications: async () => [m2] }, [pending("m1", "s1")]);
    expect(m2.closed).toBe(true);
  });

  test("tanpa registrasi service worker, atau daftar gagal dibaca: tidak menutup apa pun dan tidak melempar", async () => {
    expect(await closeStaleApprovalNotifications(undefined, [])).toBe(0);
    const n = note(approvalTag("m1", "s1"));
    const failing = { getNotifications: async () => Promise.reject(new Error("tidak diizinkan")) };
    expect(await closeStaleApprovalNotifications(failing, [])).toBe(0);
    expect(n.closed).toBe(false);
  });
});

describe("StaleNotificationCleaner", () => {
  type State = { approvalsLoaded: boolean; approvals: Array<{ machineId: string; sessionId: string }> };
  let state: State;
  const listeners = new Set<() => void>();
  const store = { getState: () => state, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) } as unknown as RelayStore;
  const entry = { pairing: { relayUrl: "https://r.example" }, store } as unknown as RelayEntry;
  const notifications = [note(approvalTag("m1", "s-lama")), note(approvalTag("m1", "s-menunggu"))];
  const getNotifications = vi.fn(async () => notifications);

  beforeEach(() => {
    notifications.forEach((n) => (n.closed = false));
    getNotifications.mockClear();
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => ({ getNotifications }) }, configurable: true });
  });
  afterEach(() => {
    cleanup();
    listeners.clear();
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  });
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

  test("antrean izin BELUM dimuat: tidak menutup apa pun (kosong di sini bukan berarti tidak ada yang menunggu)", async () => {
    state = { approvalsLoaded: false, approvals: [] };
    render(<StaleNotificationCleaner entry={entry} />);
    await settle();
    expect(getNotifications).not.toHaveBeenCalled();
    expect(notifications.some((n) => n.closed)).toBe(false);
  });

  test("setelah dimuat: yang sesinya tidak punya izin menunggu ditutup, yang menunggu dibiarkan", async () => {
    state = { approvalsLoaded: true, approvals: [pending("m1", "s-menunggu")] };
    render(<StaleNotificationCleaner entry={entry} />);
    await settle();
    expect(notifications.map((n) => n.closed)).toEqual([true, false]);
  });

  test("antrean berubah (diputuskan di perangkat lain): dibersihkan lagi", async () => {
    state = { approvalsLoaded: true, approvals: [pending("m1", "s-menunggu"), pending("m1", "s-lama")] };
    render(<StaleNotificationCleaner entry={entry} />);
    await settle();
    expect(notifications.some((n) => n.closed)).toBe(false);
    state = { approvalsLoaded: true, approvals: [pending("m1", "s-menunggu")] };
    act(() => listeners.forEach((l) => l()));
    await settle();
    expect(notifications.map((n) => n.closed)).toEqual([true, false]);
  });

  test("browser tanpa service worker: tidak melempar", async () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    state = { approvalsLoaded: true, approvals: [] };
    expect(() => render(<StaleNotificationCleaner entry={entry} />)).not.toThrow();
    await settle();
  });
});
