import type { Envelope } from "@agentmon/shared";
import { describe, expect, test, vi } from "vitest";
import { createRelayApi, RelayApiError, type RelayApiErrorKind } from "./api";

const TOKEN = "t".repeat(64);
const RELAY = "https://relay.contoh.com";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ev = (seq: number): Envelope => ({
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

function setup(...responses: Array<Response | Error>) {
  const queue = [...responses];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("tidak ada jawaban");
    if (!(next instanceof Response)) throw next;
    return next;
  });
  return { api: createRelayApi({ relayUrl: RELAY, token: TOKEN, fetch: fetchMock as unknown as typeof fetch }), calls };
}

const kindOf = async (promise: Promise<unknown>): Promise<RelayApiErrorKind | "ok"> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof RelayApiError) return error.kind;
    throw error;
  }
};

describe("permintaan", () => {
  test("memakai alamat yang benar, token sebagai Bearer, dan batas waktu", async () => {
    const { api, calls } = setup(json(200, { machines: [{ id: "m1", name: "Laptop", online: true }] }));
    expect(await api.machines()).toEqual([{ id: "m1", name: "Laptop", online: true }]);
    expect(calls[0]?.url).toBe(`${RELAY}/api/machines`);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("garis miring di akhir alamat relay tidak menggandakan jalur", async () => {
    const calls: string[] = [];
    const api = createRelayApi({
      relayUrl: `${RELAY}//`,
      token: TOKEN,
      fetch: (async (url: string) => (calls.push(url), json(200, { machines: [] }))) as unknown as typeof fetch,
    });
    await api.machines();
    expect(calls[0]).toBe(`${RELAY}/api/machines`);
  });

  test("id laptop dan sesi dengan karakter khusus di-encode", async () => {
    const { api, calls } = setup(json(200, { sessions: [] }), json(200, { events: [], hasMore: false }));
    await api.sessions("lap/top?x=1");
    await api.events("m 1", "sesi/dengan spasi?&=", 7, 50);
    expect(calls[0]?.url).toBe(`${RELAY}/api/machines/lap%2Ftop%3Fx%3D1/sessions`);
    expect(calls[1]?.url).toBe(`${RELAY}/api/machines/m%201/sessions/sesi%2Fdengan%20spasi%3F%26%3D/events?afterSeq=7&limit=50`);
  });

  test("token tidak pernah masuk ke alamat (URL)", async () => {
    const { api, calls } = setup(json(200, { machines: [] }));
    await api.machines();
    expect(calls[0]?.url).not.toContain(TOKEN);
  });
});

describe("galat dikelompokkan", () => {
  test.each([
    [401, "unauthorized"],
    [404, "not-found"],
    [429, "rate-limited"],
    [500, "server"],
    [503, "server"],
    [400, "server"],
  ] as const)("status %s -> %s", async (status, kind) => {
    const { api } = setup(json(status, { error: "x" }));
    expect(await kindOf(api.machines())).toBe(kind);
  });

  test("jaringan putus atau batas waktu habis -> unreachable", async () => {
    expect(await kindOf(setup(new TypeError("Failed to fetch")).api.machines())).toBe("unreachable");
    expect(await kindOf(setup(new DOMException("timeout", "TimeoutError")).api.machines())).toBe("unreachable");
  });

  test.each([
    ["bukan JSON", new Response("<html>", { status: 200 })],
    ["bentuk salah", json(200, { aneh: true })],
    ["laptop tanpa nama", json(200, { machines: [{ id: "m1", online: true }] })],
  ])("jawaban 200 yang tidak sesuai kontrak -> bad-response: %s", async (_name, response) => {
    expect(await kindOf(setup(response).api.machines())).toBe("bad-response");
  });

  test("event yang rusak di dalam jawaban menolak seluruh jawaban (tidak setengah tampil)", async () => {
    const { api } = setup(json(200, { events: [ev(0), { rusak: true }], hasMore: false }));
    expect(await kindOf(api.events("m1", "s1", -1))).toBe("bad-response");
  });

  test("galat tidak memuat token", async () => {
    const { api } = setup(json(401, {}));
    try {
      await api.machines();
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});

describe("eventsAfter mengikuti halaman sampai habis", () => {
  test("mengumpulkan semua halaman berurutan dan melanjutkan dari nomor terbesar tiap halaman", async () => {
    const { api, calls } = setup(
      json(200, { events: [ev(0), ev(1), ev(2)], hasMore: true }),
      json(200, { events: [ev(3), ev(4), ev(5)], hasMore: true }),
      json(200, { events: [ev(6)], hasMore: false }),
    );
    const pages: number[][] = [];
    const all = await api.eventsAfter("m1", "s1", -1, (page) => pages.push(page.map((e) => e.seq)));

    expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(pages).toEqual([[0, 1, 2], [3, 4, 5], [6]]); // layar bisa terisi bertahap
    expect(calls.map((c) => /afterSeq=(-?\d+)/.exec(c.url)?.[1])).toEqual(["-1", "2", "5"]);
  });

  test("halaman pertama kosong: selesai tanpa permintaan tambahan", async () => {
    const { api, calls } = setup(json(200, { events: [], hasMore: false }));
    expect(await api.eventsAfter("m1", "s1", 9)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("relay yang rusak (hasMore terus benar tetapi halaman kosong) tidak membuat perulangan tanpa akhir", async () => {
    const { api, calls } = setup(json(200, { events: [], hasMore: true }), json(200, { events: [], hasMore: true }));
    expect(await api.eventsAfter("m1", "s1", 0)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("galat di tengah jalan melempar, dan halaman yang sudah diterima sudah sempat diserahkan lewat onPage", async () => {
    const { api } = setup(json(200, { events: [ev(0)], hasMore: true }), json(500, {}));
    const pages: number[][] = [];
    await expect(api.eventsAfter("m1", "s1", -1, (p) => pages.push(p.map((e) => e.seq)))).rejects.toBeInstanceOf(RelayApiError);
    expect(pages).toEqual([[0]]);
  });

  test("batas pengaman halaman: sesi raksasa tidak diunduh tanpa henti", async () => {
    let seq = 0;
    let requests = 0;
    const api = createRelayApi({
      relayUrl: RELAY,
      token: TOKEN,
      fetch: (async () => {
        requests++;
        return json(200, { events: [ev(seq++)], hasMore: true });
      }) as unknown as typeof fetch,
    });
    const all = await api.eventsAfter("m1", "s1", -1);
    expect(requests).toBe(200);
    expect(all).toHaveLength(200);
  });
});

describe("push", () => {
  const SUBSCRIPTION = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) } };

  test("pushConfig: GET /api/push/key dengan token, jawabannya divalidasi", async () => {
    const { api, calls } = setup(json(200, { enabled: true, publicKey: `B${"A".repeat(86)}` }), json(200, { enabled: false }));
    expect(await api.pushConfig()).toEqual({ enabled: true, publicKey: `B${"A".repeat(86)}` });
    expect(await api.pushConfig()).toEqual({ enabled: false });
    expect(calls[0]?.url).toBe(`${RELAY}/api/push/key`);
    expect(calls[0]?.init.method).toBe("GET");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("pushConfig: jawaban yang tidak sesuai kontrak (kunci rusak) -> bad-response", async () => {
    const { api } = setup(json(200, { enabled: true, publicKey: "pendek" }));
    expect(await kindOf(api.pushConfig())).toBe("bad-response");
  });

  test("savePushSubscription: PUT dengan isi JSON, content-type, dan token", async () => {
    const { api, calls } = setup(json(200, { ok: true }));
    await api.savePushSubscription(SUBSCRIPTION);
    expect(calls[0]?.url).toBe(`${RELAY}/api/push/subscription`);
    expect(calls[0]?.init.method).toBe("PUT");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(SUBSCRIPTION);
  });

  test("savePushSubscription: token tidak pernah masuk ke alamat atau isi", async () => {
    const { api, calls } = setup(json(200, { ok: true }));
    await api.savePushSubscription(SUBSCRIPTION);
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(String(calls[0]?.init.body)).not.toContain(TOKEN);
  });

  test.each([
    [400, "server"], // langganan ditolak relay
    [401, "unauthorized"],
    [429, "rate-limited"],
    [503, "server"], // push belum dikonfigurasi di relay
  ] as const)("savePushSubscription: status %i -> %s", async (status, kind) => {
    const { api } = setup(json(status, { error: "x" }));
    expect(await kindOf(api.savePushSubscription(SUBSCRIPTION))).toBe(kind);
  });

  test("removePushSubscription: DELETE tanpa isi, dengan token", async () => {
    const { api, calls } = setup(json(200, { ok: true }));
    await api.removePushSubscription();
    expect(calls[0]?.url).toBe(`${RELAY}/api/push/subscription`);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  test("jaringan putus -> unreachable", async () => {
    const { api } = setup(new TypeError("fetch gagal"));
    expect(await kindOf(api.removePushSubscription())).toBe("unreachable");
  });
});

describe("pengaturan jenis notifikasi", () => {
  test("pushPreferences: GET dengan token, jawabannya divalidasi", async () => {
    const { api, calls } = setup(json(200, { approvals: true, done: false }));
    expect(await api.pushPreferences()).toEqual({ approvals: true, done: false });
    expect(calls[0]?.url).toBe(`${RELAY}/api/push/preferences`);
    expect(calls[0]?.init.method).toBe("GET");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("pushPreferences: belum berlangganan (404) -> not-found; bentuk salah -> bad-response", async () => {
    expect(await kindOf(setup(json(404, { error: "no-subscription" })).api.pushPreferences())).toBe("not-found");
    expect(await kindOf(setup(json(200, { approvals: "ya" })).api.pushPreferences())).toBe("bad-response");
  });

  test("savePushPreferences: PUT dengan isi JSON yang hanya memuat yang diubah, dan hasil terbaru dikembalikan", async () => {
    const { api, calls } = setup(json(200, { approvals: false, done: true }));
    expect(await api.savePushPreferences({ approvals: false })).toEqual({ approvals: false, done: true });
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ approvals: false });
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test.each([
    [400, "server"],
    [401, "unauthorized"],
    [404, "not-found"],
    [429, "rate-limited"],
  ] as const)("savePushPreferences: status %i -> %s", async (status, kind) => {
    expect(await kindOf(setup(json(status, { error: "x" })).api.savePushPreferences({ done: false }))).toBe(kind);
  });
});
