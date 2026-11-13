import { afterEach, describe, expect, test, vi } from "vitest";
import type { DeviceConnectionOptions } from "./connection";
import { fakeRelay } from "./fake-relay";
import { createRelayStore, type RelayStore } from "./relay-store";

const IDS = ["11111111-1111-4111-8111-111111111101", "11111111-1111-4111-8111-111111111102", "11111111-1111-4111-8111-111111111103"];

function setup(send: () => boolean = () => true) {
  let options!: DeviceConnectionOptions;
  const sent: Array<Record<string, unknown>> = [];
  let n = 0;
  const store: RelayStore = createRelayStore({
    relayUrl: "https://relay.contoh.com",
    token: "t".repeat(64),
    api: fakeRelay().api,
    newId: () => IDS[n++] as string,
    connect: (opts) => {
      options = opts;
      return {
        reconnectNow: vi.fn(),
        status: () => "online" as const,
        close: vi.fn(),
        send: (frame) => {
          const ok = send();
          if (ok) sent.push(frame as Record<string, unknown>);
          return ok;
        },
      };
    },
  });
  store.start();
  return { store, sent, reply: (machineId: string, body: Record<string, unknown>) => options.onReply?.(machineId, body), error: (code: string) => options.onError?.(code) };
}
let current: RelayStore | undefined;
afterEach(() => {
  current?.stop();
  current = undefined;
  vi.useRealTimers();
});

describe("store.request: perintah umum dan balasannya", () => {
  test("mengirim perintah dengan nomor dari store, dan menyelesaikan dengan balasan yang cocok", async () => {
    const s = setup();
    current = s.store;
    const pending = s.store.request("m1", { type: "rollback.preview", checkpointId: "cp1" });
    expect(s.sent).toEqual([{ kind: "command", machineId: "m1", body: { type: "rollback.preview", checkpointId: "cp1", commandId: IDS[0] } }]);
    s.reply("m1", { type: "rollback.result", commandId: IDS[0], outcome: "preview" });
    expect(await pending).toEqual({ ok: true, reply: { type: "rollback.result", commandId: IDS[0], outcome: "preview" } });
  });

  test("nomor dari pemanggil tidak dipakai (store yang menentukan), supaya balasan tidak bisa dipalsukan", async () => {
    const s = setup();
    current = s.store;
    void s.store.request("m1", { type: "x", commandId: "buatan-pemanggil" });
    expect((s.sent[0]?.body as Record<string, unknown>).commandId).toBe(IDS[0]);
  });

  test("balasan dari laptop lain atau dengan nomor lain diabaikan", async () => {
    const s = setup();
    current = s.store;
    vi.useFakeTimers();
    const pending = s.store.request("m1", { type: "x" }, 1000);
    s.reply("m2", { commandId: IDS[0], outcome: "palsu" });
    s.reply("m1", { commandId: "nomor-lain", outcome: "palsu" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: false, reason: "unconfirmed" });
  });

  test("balasan kedua untuk perintah yang sama diabaikan (tidak menyelesaikan dua kali)", async () => {
    const s = setup();
    current = s.store;
    const first = s.store.request("m1", { type: "x" });
    s.reply("m1", { commandId: IDS[0], outcome: "satu" });
    s.reply("m1", { commandId: IDS[0], outcome: "dua" });
    expect(await first).toMatchObject({ ok: true, reply: { outcome: "satu" } });
  });

  test("tidak tersambung (send gagal): ok=false/offline, dan tidak ada yang tertinggal", async () => {
    const s = setup(() => false);
    current = s.store;
    expect(await s.store.request("m1", { type: "x" })).toEqual({ ok: false, reason: "offline" });
  });

  test("tanpa balasan dalam batas waktu: unconfirmed", async () => {
    const s = setup();
    current = s.store;
    vi.useFakeTimers();
    const pending = s.store.request("m1", { type: "x" }, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ ok: false, reason: "unconfirmed" });
  });

  test("relay menolak (laptop mati, tidak berhak, terlalu cepat): gagal dengan alasannya", async () => {
    for (const [code, reason] of [["target_offline", "laptop-offline"], ["forbidden", "not-allowed"], ["rate_limited", "rate-limited"]] as const) {
      const s = setup();
      const pending = s.store.request("m1", { type: "x" });
      s.error(code);
      expect(await pending).toEqual({ ok: false, reason });
      s.store.stop();
    }
  });

  test("galat relay lain diabaikan dan tidak menggagalkan permintaan", async () => {
    const s = setup();
    current = s.store;
    const pending = s.store.request("m1", { type: "x" });
    s.error("invalid_frame");
    s.reply("m1", { commandId: IDS[0], outcome: "ok" });
    expect(await pending).toMatchObject({ ok: true });
  });

  test("store dihentikan saat menunggu: selesai sebagai offline, tidak menggantung", async () => {
    const s = setup();
    const pending = s.store.request("m1", { type: "x" });
    s.store.stop();
    expect(await pending).toEqual({ ok: false, reason: "offline" });
  });
});
