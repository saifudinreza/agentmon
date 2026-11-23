// Menjalankan sw.ts sungguhan dengan lingkungan service worker tiruan: yang diuji adalah PERANGKAIANNYA (peristiwa apa
// yang didengar, waitUntil dipakai, notifikasi ditutup saat diketuk), karena logikanya sudah diuji di push/.
import { beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("workbox-precaching", () => ({ cleanupOutdatedCaches: vi.fn(), createHandlerBoundToURL: vi.fn((url: string) => ({ boundTo: url })), precacheAndRoute: vi.fn() }));
vi.mock("workbox-routing", () => ({
  NavigationRoute: class {
    constructor(readonly handler: unknown) {}
  },
  registerRoute: vi.fn(),
}));

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";

type Listener = (event: Record<string, unknown>) => void;
const listeners = new Map<string, Listener>();
const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
const opened: string[] = [];
const clientsState = { windows: [] as Array<{ url: string; focus: () => Promise<void>; postMessage: (m: unknown) => void }>, claimed: 0, skipped: 0 };
const MANIFEST = [{ url: "index.html", revision: "abc" }];
// Perangkaian terjadi SEKALI saat sw.ts dimuat. Konfigurasi tes memakai restoreMocks, yang menghapus catatan panggilan
// antar tes, jadi catatannya diambil tepat setelah impor.
let wiring: { cleanup: number; precache: unknown[][]; handler: unknown[][]; routes: unknown[][] };

beforeAll(async () => {
  vi.stubGlobal("self", {
    __WB_MANIFEST: MANIFEST,
    location: { origin: "https://agentmon.contoh.com" },
    navigator: { language: "id-ID" },
    clients: {
      claim: async () => void (clientsState.claimed += 1),
      matchAll: async () => clientsState.windows,
      openWindow: async (url: string) => void opened.push(url),
    },
    caches: { open: async () => ({ match: async () => new Response("dari-cache"), put: async () => undefined, keys: async () => [], delete: async () => true }) },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }), getNotifications: async () => [] },
    skipWaiting: async () => void (clientsState.skipped += 1),
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
  });
  await import("./sw");
  wiring = {
    cleanup: vi.mocked(cleanupOutdatedCaches).mock.calls.length,
    precache: [...vi.mocked(precacheAndRoute).mock.calls],
    handler: [...vi.mocked(createHandlerBoundToURL).mock.calls],
    routes: [...vi.mocked(registerRoute).mock.calls],
  };
});

// Peristiwa tiruan yang menampung janji dari waitUntil, lalu menunggunya.
function fire(type: string, extra: Record<string, unknown> = {}) {
  const pending: Array<Promise<unknown>> = [];
  const event = { waitUntil: (p: Promise<unknown>) => void pending.push(p), ...extra };
  listeners.get(type)?.(event);
  return { event, settled: () => Promise.all(pending), pending };
}

describe("sw.ts: perangkaian", () => {
  test("mendengarkan kelima peristiwa (fetch hanya untuk chunk libsodium)", () => {
    expect([...listeners.keys()].sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
  });

  test("fetch: chunk libsodium dijawab dari cache service worker; permintaan lain dibiarkan lewat", () => {
    const answers: unknown[] = [];
    const request = (url: string) => ({ request: { url, method: "GET" }, respondWith: (promise: unknown) => void answers.push(promise) });
    listeners.get("fetch")?.(request("https://agentmon.contoh.com/assets/index-1.js"));
    expect(answers).toHaveLength(0);
    listeners.get("fetch")?.(request("https://agentmon.contoh.com/assets/libsodium-wrappers-1.js"));
    expect(answers).toHaveLength(1);
  });

  test("berkas aplikasi disimpan dari daftar yang disisipkan build, dan navigasi dijawab kerangka aplikasi", () => {
    expect(wiring.cleanup).toBe(1);
    expect(wiring.precache).toEqual([[MANIFEST]]);
    expect(wiring.handler).toEqual([["/index.html"]]);
    expect(wiring.routes).toHaveLength(1);
    expect(wiring.routes[0]![0]).toMatchObject({ handler: { boundTo: "/index.html" } });
  });

  test("versi baru langsung mengambil alih: skipWaiting saat dipasang, claim saat aktif (dan activate menunggu claim)", async () => {
    fire("install");
    expect(clientsState.skipped).toBe(1);
    const activate = fire("activate");
    expect(activate.pending).toHaveLength(1);
    await activate.settled();
    expect(clientsState.claimed).toBe(1);
  });
});

describe("sw.ts: push", () => {
  test("push yang sah: satu notifikasi, dan browser diminta menunggu sampai tampil (waitUntil)", async () => {
    shown.length = 0;
    const push = fire("push", { data: { text: () => JSON.stringify({ v: 1, kind: "approval", machineId: "m1", approvalId: "a1" }) } });
    expect(push.pending).toHaveLength(1);
    await push.settled();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("Izin dibutuhkan");
    expect(shown[0]!.options).toMatchObject({ tag: "approval:m1:a1", data: { path: "/a/m1/a1" } });
  });

  test("push tanpa isi: tetap satu notifikasi umum", async () => {
    shown.length = 0;
    await fire("push", { data: null }).settled();
    expect(shown.map((s) => s.title)).toEqual(["AgentMon"]);
  });

  test("isi yang gagal dibaca (text() melempar): tetap satu notifikasi umum, bukan galat", async () => {
    shown.length = 0;
    await fire("push", {
      data: {
        text: () => {
          throw new Error("tidak bisa didekode");
        },
      },
    }).settled();
    expect(shown.map((s) => s.title)).toEqual(["AgentMon"]);
  });

  test("bahasa perangkat dipakai untuk teks notifikasi", async () => {
    shown.length = 0;
    (self as unknown as { navigator: { language: string } }).navigator.language = "en-US";
    try {
      await fire("push", { data: { text: () => JSON.stringify({ v: 1, kind: "done", machineId: "m1", sessionId: "s1" }) } }).settled();
      expect(shown[0]!.title).toBe("Agent finished");
    } finally {
      (self as unknown as { navigator: { language: string } }).navigator.language = "id-ID";
    }
  });
});

describe("sw.ts: ketukan notifikasi", () => {
  test("notifikasi ditutup, dan aplikasi tertutup dibuka langsung di layar tujuan", async () => {
    opened.length = 0;
    clientsState.windows = [];
    let closed = 0;
    const click = fire("notificationclick", { notification: { close: () => void (closed += 1), data: { path: "/a/m1/a1" } } });
    expect(closed).toBe(1);
    expect(click.pending).toHaveLength(1);
    await click.settled();
    expect(opened).toEqual(["https://agentmon.contoh.com/a/m1/a1"]);
  });

  test("aplikasi terbuka: difokuskan dan diminta pindah layar, tanpa jendela baru", async () => {
    opened.length = 0;
    const messages: unknown[] = [];
    let focused = 0;
    clientsState.windows = [{ url: "https://agentmon.contoh.com/", focus: async () => void (focused += 1), postMessage: (m) => void messages.push(m) }];
    await fire("notificationclick", { notification: { close: () => undefined, data: { path: "/s/m1/s1" } } }).settled();
    expect(focused).toBe(1);
    expect(messages).toEqual([{ type: "agentmon:navigate", path: "/s/m1/s1" }]);
    expect(opened).toEqual([]);
  });
});
