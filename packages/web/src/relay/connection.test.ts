import type { Envelope } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeviceConnection, toWebSocketUrl, type ConnectionStatus, type DeviceConnection } from "./connection";

const TOKEN = "t".repeat(64);
const RELAY = "https://relay.contoh.com";

// WebSocket tiruan: mencatat apa yang dikirim, dan test memicu kejadiannya.
class FakeSocket {
  static instances: FakeSocket[] = [];
  handlers: Record<string, Array<(event?: unknown) => void>> = {};
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(name: string, fn: (event?: unknown) => void) {
    (this.handlers[name] ??= []).push(fn);
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, event?: unknown) {
    for (const fn of this.handlers[name] ?? []) fn(event);
  }
  receive(frame: unknown) {
    this.emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  welcome() {
    this.emit("open");
    this.receive({ kind: "welcome", role: "device", id: "d1" });
  }
}
const lastSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;

const event = (seq: number): Envelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${String(seq + 1).padStart(12, "0")}`,
  machineId: "m1",
  sessionId: "s1",
  seq,
  ts: "2026-11-11T10:00:00.000Z",
  agent: "claude-code",
  type: "tool.requested",
  payload: {},
});

let connection: DeviceConnection | undefined;
function open(extra: Partial<Parameters<typeof createDeviceConnection>[0]> = {}) {
  const statuses: ConnectionStatus[] = [];
  const events: Envelope[] = [];
  let ready = 0;
  connection = createDeviceConnection({
    relayUrl: RELAY,
    token: TOKEN,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onReady: () => void ready++,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    random: () => 1,
    ...extra,
  });
  return { statuses, events, ready: () => ready };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  connection?.close();
  connection = undefined;
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("toWebSocketUrl", () => {
  test.each([
    ["https://relay.contoh.com", "wss://relay.contoh.com/ws"],
    ["http://localhost:8787/", "ws://localhost:8787/ws"],
    ["https://relay.contoh.com/awalan//", "wss://relay.contoh.com/awalan/ws"],
    ["https://relay.contoh.com?x=1#y", "wss://relay.contoh.com/ws"],
  ])("%s -> %s", (input, expected) => expect(toWebSocketUrl(input)).toBe(expected));
  test.each(["bukan-alamat", "ftp://x.com", "javascript:alert(1)", ""])("menolak %j", (input) => expect(toWebSocketUrl(input)).toBeUndefined());
});

describe("menyambung", () => {
  test("setelah terbuka mengirim hello sebagai HP, dan baru 'online' setelah welcome; onReady dipanggil", () => {
    const { statuses, ready } = open();
    expect(lastSocket().url).toBe("wss://relay.contoh.com/ws");
    expect(statuses).toEqual([]); // awalnya connecting
    lastSocket().emit("open");
    expect(JSON.parse(lastSocket().sent[0] as string)).toEqual({ kind: "hello", role: "device", token: TOKEN });
    expect(connection?.status()).toBe("connecting");
    lastSocket().receive({ kind: "welcome", role: "device", id: "d1" });
    expect(statuses).toEqual(["online"]);
    expect(ready()).toBe(1);
  });

  test("welcome untuk peran lain diabaikan", () => {
    const { ready } = open();
    lastSocket().emit("open");
    lastSocket().receive({ kind: "welcome", role: "machine", id: "m1" });
    expect(ready()).toBe(0);
    expect(connection?.status()).toBe("connecting");
  });

  test("alamat relay yang tidak sah: offline, tanpa membuat soket", () => {
    const { statuses } = open({ relayUrl: "bukan-alamat" });
    expect(FakeSocket.instances).toHaveLength(0);
    expect(statuses).toEqual(["offline"]);
  });

  test("soket yang gagal dibuat tidak melempar dan dicoba lagi", () => {
    let attempts = 0;
    open({
      createSocket: () => {
        attempts++;
        throw new Error("SecurityError");
      },
    });
    vi.advanceTimersByTime(60_000);
    expect(attempts).toBeGreaterThan(2);
  });
});

describe("menerima event", () => {
  test("event yang sah diteruskan; yang rusak, bukan JSON, atau dari versi lebih baru diabaikan tanpa galat", () => {
    const { events } = open();
    lastSocket().welcome();
    lastSocket().receive({ kind: "event", event: event(0) });
    lastSocket().receive({ kind: "event", event: { rusak: true } });
    lastSocket().receive("{bukan json");
    lastSocket().receive({ kind: "jenis-baru", x: 1 });
    lastSocket().receive({ kind: "ack", eventId: "x" });
    lastSocket().emit("message", { data: new ArrayBuffer(4) });
    lastSocket().receive({ kind: "event", event: event(1) });
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });
});

describe("sambung ulang", () => {
  test("soket putus: offline, lalu dicoba lagi dengan jeda yang berlipat dua sampai batas atas", () => {
    const { statuses } = open({ reconnectMinMs: 500, reconnectMaxMs: 4000 });
    const times: number[] = [];
    // Tiap soket baru langsung gagal; catat kapan soket dibuat.
    const originalLength = () => FakeSocket.instances.length;
    let seen = 0;
    for (let tick = 0; tick < 200; tick++) {
      if (originalLength() > seen) {
        seen = originalLength();
        times.push(Date.now());
        lastSocket().emit("close");
      }
      vi.advanceTimersByTime(100);
    }
    const gaps = times.slice(1, 6).map((t, i) => t - (times[i] as number));
    expect(gaps).toEqual([500, 1000, 2000, 4000, 4000]);
    expect(statuses).toContain("offline");
  });

  test.each(["error", "close"] as const)("koneksi gagal dengan sinyal '%s' saja (Node 22 / browser tertentu tidak memicu close) tetap dicoba lagi", (signal) => {
    open();
    lastSocket().emit(signal);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  test("error lalu close untuk koneksi yang sama hanya menjadwalkan SATU percobaan ulang", () => {
    open({ reconnectMinMs: 1000, reconnectMaxMs: 1000 });
    lastSocket().emit("error");
    lastSocket().emit("close");
    vi.advanceTimersByTime(1500);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("percobaan yang menggantung tanpa kabar dibatalkan oleh batas waktu hello", () => {
    open({ helloTimeoutMs: 1000, reconnectMinMs: 100, reconnectMaxMs: 100 });
    vi.advanceTimersByTime(3000);
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakeSocket.instances[0]?.closed).toBe(true);
  });

  test("setelah berhasil tersambung, jeda kembali dari awal dan onReady dipanggil lagi (untuk menambal yang terlewat)", () => {
    const { ready } = open({ reconnectMinMs: 500, reconnectMaxMs: 8000 });
    lastSocket().welcome();
    lastSocket().emit("close");
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2); // jeda awal 500 ms, bukan lebih panjang
    lastSocket().welcome();
    expect(ready()).toBe(2);
  });

  test("event dari soket lama setelah sambung ulang diabaikan", () => {
    const { events } = open();
    const old = lastSocket();
    old.welcome();
    connection?.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(2);
    old.receive({ kind: "event", event: event(5) });
    expect(events).toEqual([]);
  });
});

describe("token ditolak (perangkat dicabut)", () => {
  test("status 'revoked' dan TIDAK mencoba lagi", () => {
    const { statuses } = open();
    lastSocket().emit("open");
    lastSocket().receive({ kind: "error", code: "unauthorized", message: "token tidak dikenal" });
    expect(statuses).toEqual(["revoked"]);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    connection?.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("galat lain tidak mencabut", () => {
    open();
    lastSocket().welcome();
    lastSocket().receive({ kind: "error", code: "rate_limited", message: "x" });
    expect(connection?.status()).toBe("online");
  });
});

describe("HP dikunci lalu dibuka, dan jaringan kembali", () => {
  test("halaman terlihat lagi: sambungan DIBUKA ULANG langsung, walau kelihatannya masih tersambung (soket bisa sudah mati diam-diam)", () => {
    const { ready } = open();
    lastSocket().welcome();
    expect(FakeSocket.instances).toHaveLength(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0]?.closed).toBe(true);
    lastSocket().welcome();
    expect(ready()).toBe(2); // memicu pengambilan yang terlewat
  });

  test("halaman disembunyikan (dikunci) tidak melakukan apa-apa", () => {
    open();
    lastSocket().welcome();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("tidak menunggu jeda: walau sedang menunggu percobaan ulang yang panjang", () => {
    open({ reconnectMinMs: 10_000, reconnectMaxMs: 10_000 });
    lastSocket().emit("close"); // menunggu 10 detik
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("jaringan kembali (event online) langsung menyambung ulang", () => {
    open({ reconnectMinMs: 10_000, reconnectMaxMs: 10_000 });
    lastSocket().emit("close");
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test("watchPage dimatikan: tidak memantau halaman", () => {
    open({ watchPage: false });
    lastSocket().welcome();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("close", () => {
  test("menutup soket, membatalkan percobaan ulang, dan tidak memantau halaman lagi", () => {
    open({ reconnectMinMs: 500 });
    lastSocket().emit("close"); // menjadwalkan percobaan ulang
    connection?.close();
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("close dua kali aman, dan reconnectNow sesudahnya tidak melakukan apa-apa", () => {
    open();
    connection?.close();
    expect(() => connection?.close()).not.toThrow();
    connection?.reconnectNow();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
