import { ApprovalsResponseSchema, EventsResponseSchema, MachinesResponseSchema, SessionsResponseSchema, type Envelope } from "@agentmon/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createStore, type Store } from "./db/store";
import { createTestDatabase, resetDatabase } from "./db/testing";
import type { DeviceApiOptions } from "./device-api";
import { startRelayServer, type RunningRelay } from "./node";

const TOKEN = { m1: "machine-token-satu-000000000000000", m2: "machine-token-dua-0000000000000000", d1: "device-token-satu-00000000000000000", d2: "device-token-dua-000000000000000000", d3: "device-token-dicabut-0000000000000" };
const PWA = "https://app.contoh.com";

let handle: DatabaseHandle;
let directory: DbDirectory;
let store: Store;
let relay: RunningRelay | undefined;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  directory = createDbDirectory(handle.db);
  store = createStore(handle.db);
  await directory.registerMachine({ id: "m1", name: "Laptop Kantor", token: TOKEN.m1 });
  await directory.registerMachine({ id: "m2", name: "Laptop Rumah", token: TOKEN.m2 });
  await directory.registerDevice({ id: "d1", name: "HP satu", token: TOKEN.d1 });
  await directory.registerDevice({ id: "d2", name: "HP dua", token: TOKEN.d2 });
  await directory.registerDevice({ id: "d3", name: "HP dicabut", token: TOKEN.d3 });
  await directory.pair("m1", "d1");
  await directory.pair("m2", "d2");
  await directory.pair("m1", "d3");
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await relay?.stop();
  relay = undefined;
});

async function start(extra: Partial<DeviceApiOptions> = {}): Promise<string> {
  relay = await startRelayServer({
    directory,
    port: 0,
    host: "127.0.0.1",
    persist: (event) => store.saveEvent(event),
    deviceApi: { directory, store, allowedOrigins: [PWA], ...extra },
  });
  return `http://127.0.0.1:${relay.port}`;
}

const api = (base: string, path: string, token: string | null = TOKEN.d1, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

let counter = 0;
const event = (extra: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  machineId: "m1",
  sessionId: "s1",
  seq: 0,
  ts: "2026-11-11T10:00:00.000Z",
  agent: "claude-code",
  type: "tool.requested",
  payload: { toolName: "Write", toolInput: { file_path: "a.ts" } },
  ...extra,
});

function connectWs(port: number, role: "machine" | "device", token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  const ready = new Promise<void>((resolve) => ws.on("open", () => (ws.send(JSON.stringify({ kind: "hello", role, token })), resolve())));
  return { ws, frames, ready, waitFor: (kind: string) => vi.waitFor(() => expect(frames.some((f) => f.kind === kind)).toBe(true), { timeout: 5000 }) };
}

describe("autentikasi", () => {
  test.each([
    ["tanpa token", null],
    ["token salah", "token-salah-0000000000000000"],
    ["token laptop dipakai sebagai token HP", TOKEN.m1],
  ])("401: %s", async (_name, token) => {
    const base = await start();
    for (const path of ["/api/machines", "/api/machines/m1/sessions", "/api/machines/m1/sessions/s1/events"]) {
      const res = await api(base, path, token);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("HP yang sudah dicabut tidak bisa membaca apa pun", async () => {
    const base = await start();
    await directory.revokeDevice("d3");
    expect((await api(base, "/api/machines", TOKEN.d3)).status).toBe(401);
    expect((await api(base, "/api/machines/m1/sessions", TOKEN.d3)).status).toBe(401);
  });

  test("bukan Bearer: ditolak", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/machines`, { headers: { authorization: `Basic ${TOKEN.d1}` } });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/machines", () => {
  test("hanya laptop yang dipasangkan dengan HP ini, beserta status tersambung", async () => {
    const base = await start();
    const first = MachinesResponseSchema.parse(await (await api(base, "/api/machines")).json());
    expect(first.machines).toEqual([{ id: "m1", name: "Laptop Kantor", online: false }]);

    const machine = connectWs(relay?.port as number, "machine", TOKEN.m1);
    await machine.ready;
    await machine.waitFor("welcome");
    const second = MachinesResponseSchema.parse(await (await api(base, "/api/machines")).json());
    expect(second.machines[0]?.online).toBe(true);

    // HP lain melihat laptopnya sendiri, bukan milik d1.
    const other = MachinesResponseSchema.parse(await (await api(base, "/api/machines", TOKEN.d2)).json());
    expect(other.machines).toEqual([{ id: "m2", name: "Laptop Rumah", online: false }]);
  });

  test("HP satu bisa dipasangkan ke beberapa laptop, berurutan menurut nama", async () => {
    const base = await start();
    await directory.pair("m2", "d1");
    const result = MachinesResponseSchema.parse(await (await api(base, "/api/machines")).json());
    expect(result.machines.map((m) => m.name)).toEqual(["Laptop Kantor", "Laptop Rumah"]);
  });

  test("HP tanpa pasangan mendapat daftar kosong", async () => {
    const base = await start();
    await directory.unpair("m1", "d1");
    expect(MachinesResponseSchema.parse(await (await api(base, "/api/machines")).json()).machines).toEqual([]);
  });
});

describe("GET /api/machines/:id/sessions", () => {
  test("daftar sesi laptop itu, yang terbaru aktif di atas, sesuai kontrak", async () => {
    const base = await start();
    await store.saveEvent(event({ sessionId: "lama", ts: "2026-11-11T08:00:00.000Z" }));
    await store.saveEvent(event({ sessionId: "baru", ts: "2026-11-11T09:00:00.000Z" }));
    await store.saveEvent(event({ sessionId: "lama", seq: 1, type: "session.recap", ts: "2026-11-11T08:30:00.000Z", payload: { durationMs: 1, filesChanged: [], rejected: 0, autoApproved: 0 } }));

    const body = SessionsResponseSchema.parse(await (await api(base, "/api/machines/m1/sessions")).json());
    expect(body.sessions.map((s) => [s.sessionId, s.status])).toEqual([["baru", "active"], ["lama", "ended"]]);
  });

  test("laptop yang TIDAK dipasangkan dan laptop yang tidak ada dijawab SAMA (404), supaya tidak bisa dipakai mengintai", async () => {
    const base = await start();
    await store.saveEvent(event({ machineId: "m2" }));
    const notPaired = await api(base, "/api/machines/m2/sessions");
    const notExists = await api(base, "/api/machines/tidak-ada/sessions");
    expect(notPaired.status).toBe(404);
    expect(notExists.status).toBe(404);
    expect(await notPaired.json()).toEqual(await notExists.json());
  });

  test("id laptop yang terlalu panjang: 404", async () => {
    const base = await start();
    expect((await api(base, `/api/machines/${"x".repeat(300)}/sessions`)).status).toBe(404);
  });

  test("sesi laptop lain tidak bocor walau nomor sesinya sama", async () => {
    const base = await start();
    await store.saveEvent(event({ machineId: "m2", sessionId: "s-rahasia" }));
    const body = SessionsResponseSchema.parse(await (await api(base, "/api/machines/m1/sessions")).json());
    expect(body.sessions).toEqual([]);
  });
});

describe("GET /api/machines/:id/sessions/:id/events", () => {
  async function seed(n: number) {
    for (let seq = 0; seq < n; seq++) await store.saveEvent(event({ seq }));
  }
  const get = async (base: string, query = "") => EventsResponseSchema.parse(await (await api(base, `/api/machines/m1/sessions/s1/events${query}`)).json());

  test("event berurutan menurut nomor urut, sesuai kontrak", async () => {
    const base = await start();
    for (const seq of [2, 0, 1]) await store.saveEvent(event({ seq }));
    const body = await get(base);
    expect(body.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(body.hasMore).toBe(false);
    expect(body.events[0]).toMatchObject({ machineId: "m1", sessionId: "s1", type: "tool.requested", payload: { toolName: "Write" } });
  });

  test("afterSeq melanjutkan dari event setelah nomor itu (untuk mengambil yang terlewat)", async () => {
    const base = await start();
    await seed(10);
    expect((await get(base, "?afterSeq=6")).events.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect((await get(base, "?afterSeq=9")).events).toEqual([]);
  });

  test("halaman dibatasi dan hasMore memberi tahu masih ada lanjutan; mengikuti halaman sampai habis tidak melewatkan apa pun", async () => {
    const base = await start();
    await seed(25);
    const collected: number[] = [];
    let after = -1;
    for (let guard = 0; guard < 10; guard++) {
      const page = await get(base, `?afterSeq=${after}&limit=10`);
      collected.push(...page.events.map((e) => e.seq));
      if (!page.hasMore) break;
      after = page.events.at(-1)?.seq ?? after;
    }
    expect(collected).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test("tepat di batas halaman: hasMore bisa benar walau tidak ada lagi; halaman berikutnya kosong dan hasMore salah", async () => {
    const base = await start();
    await seed(10);
    const page = await get(base, "?limit=10");
    expect(page.hasMore).toBe(true);
    const next = await get(base, `?afterSeq=${page.events.at(-1)?.seq}&limit=10`);
    expect(next).toEqual({ events: [], hasMore: false });
  });

  test.each([
    ["limit bukan angka", "?limit=abc", 10],
    ["limit negatif", "?limit=-5", 1],
    ["limit nol", "?limit=0", 1],
    ["limit sangat besar", "?limit=99999999", 10],
    ["afterSeq bukan angka", "?afterSeq=xyz", 10],
    ["afterSeq sangat negatif", "?afterSeq=-99999", 10],
  ])("parameter tidak sah memakai nilai yang aman, bukan galat: %s", async (_name, query, expectedCount) => {
    const base = await start();
    await seed(10);
    const res = await api(base, `/api/machines/m1/sessions/s1/events${query}`);
    expect(res.status).toBe(200);
    expect(EventsResponseSchema.parse(await res.json()).events.length).toBe(expectedCount);
  });

  test("limit dibatasi paling banyak 500 per halaman", async () => {
    const base = await start();
    // Satu event lewat jalur biasa (membuat sesinya), sisanya langsung lewat satu pernyataan SQL: 520 transaksi
    // terpisah terlalu lambat saat mesin sibuk, dan yang diuji di sini hanya batas halaman.
    await store.saveEvent(event({ seq: 0 }));
    await handle.db.execute(sql`
      insert into events (machine_id, id, session_id, seq, ts, agent, type, payload, received_at)
      select 'm1', gen_random_uuid(), 's1', g, now(), 'claude-code', 'tool.requested', '{}', now() from generate_series(1, 519) as g`);
    const page = await get(base, "?limit=99999");
    expect(page.events).toHaveLength(500);
    expect(page.hasMore).toBe(true);
  });

  test("sesi yang tidak ada: daftar kosong, bukan galat", async () => {
    const base = await start();
    const res = await api(base, "/api/machines/m1/sessions/tidak-ada/events");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], hasMore: false });
  });

  test("laptop yang tidak dipasangkan: 404 dan tidak ada isi yang bocor", async () => {
    const base = await start();
    await store.saveEvent(event({ machineId: "m2", sessionId: "s-rahasia", payload: { toolName: "RAHASIA", toolInput: {} } }));
    const res = await api(base, "/api/machines/m2/sessions/s-rahasia/events");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("RAHASIA");
  });

  test("id sesi dengan karakter khusus yang di-encode dibaca dengan benar", async () => {
    const base = await start();
    await store.saveEvent(event({ sessionId: "sesi/dengan spasi?&=" }));
    const res = await api(base, `/api/machines/m1/sessions/${encodeURIComponent("sesi/dengan spasi?&=")}/events`);
    expect(EventsResponseSchema.parse(await res.json()).events).toHaveLength(1);
  });

  test("isi event tersimpan utuh, termasuk karakter NUL dan unicode", async () => {
    const base = await start();
    await store.saveEvent(event({ payload: { toolName: "Bash", toolInput: { command: "echo \u0000 halo 📱" } } }));
    const body = await get(base);
    expect((body.events[0]?.payload as { toolInput: { command: string } }).toolInput.command).toBe("echo \u0000 halo 📱");
  });
});

describe("permintaan bertoken salah dibatasi per alamat IP", () => {
  const bad = (base: string, ip?: string) => api(base, "/api/machines", "token-salah-0000000000000000", ip ? { "x-forwarded-for": ip } : {});

  test("setelah jatah kegagalan habis, permintaan berikutnya ditolak 429 SEBELUM menyentuh database", async () => {
    const authenticate = vi.spyOn(directory, "authenticate");
    const base = await start({ authFailureLimits: { burst: 3, refillPerSecond: 0 } });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await bad(base)).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    expect(authenticate).toHaveBeenCalledTimes(3); // yang ditolak 429 tidak membebani database
  });

  test("jatah pulih seiring waktu", async () => {
    const clock = { ms: 0 };
    const base = await start({ authFailureLimits: { burst: 1, refillPerSecond: 1 }, now: () => clock.ms });
    expect((await bad(base)).status).toBe(401);
    expect((await bad(base)).status).toBe(429);
    clock.ms += 1500;
    expect((await bad(base)).status).toBe(401);
  });

  test("HP yang sah dari alamat LAIN tetap terlayani walau satu alamat sedang membanjiri (dengan trustProxy)", async () => {
    const base = await start({ trustProxy: true, authFailureLimits: { burst: 2, refillPerSecond: 0 } });
    for (let i = 0; i < 5; i++) await bad(base, "9.9.9.9");
    expect((await bad(base, "9.9.9.9")).status).toBe(429);
    expect((await api(base, "/api/machines", TOKEN.d1, { "x-forwarded-for": "8.8.8.8" })).status).toBe(200);
  });

  test("alamat yang sedang diblokir ditolak walau memakai token yang sah (penyerang tidak bisa menyelipkan lewat token sah)", async () => {
    const base = await start({ trustProxy: true, authFailureLimits: { burst: 1, refillPerSecond: 0 } });
    await bad(base, "9.9.9.9");
    expect((await api(base, "/api/machines", TOKEN.d1, { "x-forwarded-for": "9.9.9.9" })).status).toBe(429);
  });

  test("permintaan sah tidak menghabiskan jatah kegagalan", async () => {
    const base = await start({ authFailureLimits: { burst: 2, refillPerSecond: 0 }, limits: { burst: 1000, refillPerSecond: 1000 } });
    for (let i = 0; i < 20; i++) expect((await api(base, "/api/machines")).status).toBe(200);
    expect((await bad(base)).status).toBe(401); // jatah masih penuh
  });

  test("tanpa trustProxy, header X-Forwarded-For palsu TIDAK bisa menghindari batas", async () => {
    const base = await start({ authFailureLimits: { burst: 1, refillPerSecond: 0 } });
    expect((await bad(base, "1.1.1.1")).status).toBe(401);
    expect((await bad(base, "2.2.2.2")).status).toBe(429); // alamat sebenarnya sama
  });

  test("tanpa token sama sekali juga dihitung sebagai kegagalan", async () => {
    const base = await start({ authFailureLimits: { burst: 2, refillPerSecond: 0 } });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await api(base, "/api/machines", null)).status);
    expect(statuses).toEqual([401, 401, 429, 429]);
  });
});

describe("GET /api/approvals (antrean izin yang menunggu)", () => {
  const future = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const nowIso = () => new Date().toISOString();
  const requested = (approvalId: string, extra: Partial<Envelope> = {}, payload: Record<string, unknown> = {}) =>
    event({ type: "approval.requested", ts: nowIso(), payload: { approvalId, toolName: "Bash", toolInput: { command: "rm -rf build" }, expiresAt: future(5), ...payload }, ...extra });
  const getApprovals = async (base: string, token: string | null = TOKEN.d1) => ApprovalsResponseSchema.parse(await (await api(base, "/api/approvals", token)).json()).approvals;

  test("memuat permintaan yang menunggu dari laptop yang dipasangkan, lengkap dengan perintah utuhnya", async () => {
    const base = await start();
    await store.saveEvent(requested("a1", { seq: 0 }, { summary: "hapus folder build" }));
    const [item] = await getApprovals(base);
    expect(item).toMatchObject({ machineId: "m1", sessionId: "s1", approvalId: "a1", toolName: "Bash", summary: "hapus folder build" });
    expect(item?.toolInput).toEqual({ command: "rm -rf build" });
  });

  test("yang sudah diputuskan, dan yang sudah kedaluwarsa, tidak ikut", async () => {
    const base = await start();
    await store.saveEvent(requested("selesai", { seq: 0 }));
    await store.saveEvent(event({ seq: 1, type: "approval.resolved", ts: nowIso(), payload: { approvalId: "selesai", status: "approved" } }));
    await store.saveEvent(requested("basi", { seq: 2 }, { expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    await store.saveEvent(requested("menunggu", { seq: 3 }));
    expect((await getApprovals(base)).map((a) => a.approvalId)).toEqual(["menunggu"]);
  });

  test("hanya laptop yang dipasangkan dengan HP ini; HP lain tidak melihatnya", async () => {
    const base = await start();
    await store.saveEvent(requested("milik-m2", { machineId: "m2", seq: 0 }));
    await store.saveEvent(requested("milik-m1", { seq: 0 }));
    expect((await getApprovals(base, TOKEN.d1)).map((a) => a.approvalId)).toEqual(["milik-m1"]);
    expect((await getApprovals(base, TOKEN.d2)).map((a) => a.approvalId)).toEqual(["milik-m2"]);
  });

  test("HP dengan beberapa laptop mendapat semuanya", async () => {
    const base = await start();
    await directory.pair("m2", "d1");
    await store.saveEvent(requested("a-m1", { seq: 0 }));
    await store.saveEvent(requested("a-m2", { machineId: "m2", seq: 0 }));
    expect((await getApprovals(base)).map((a) => a.approvalId).sort()).toEqual(["a-m1", "a-m2"]);
  });

  test("permintaan yang diterima relay lebih dari 30 menit lalu tidak dibaca (tidak mungkin masih menunggu)", async () => {
    const base = await start();
    await store.saveEvent(requested("a1", { seq: 0 }, { expiresAt: future(120) }));
    await handle.db.execute(sql`update events set received_at = now() - interval '40 minutes'`);
    expect(await getApprovals(base)).toEqual([]);
  });

  test("tanpa token: 401", async () => {
    const base = await start();
    expect((await api(base, "/api/approvals", null)).status).toBe(401);
  });

  test("tanpa antrean: daftar kosong", async () => {
    const base = await start();
    expect(await getApprovals(base)).toEqual([]);
  });
});

describe("laju dan CORS", () => {
  test("permintaan dibatasi lajunya per HP, dan HP lain tidak ikut terkena", async () => {
    const base = await start({ limits: { burst: 3, refillPerSecond: 0 } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await api(base, "/api/machines")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await api(base, "/api/machines", TOKEN.d2)).status).toBe(200);
  });

  test("permintaan yang ditolak karena token salah tidak menghabiskan jatah HP yang sah", async () => {
    const base = await start({ limits: { burst: 2, refillPerSecond: 0 } });
    for (let i = 0; i < 10; i++) await api(base, "/api/machines", "token-salah-0000000000000000");
    expect((await api(base, "/api/machines")).status).toBe(200);
  });

  test("asal PWA yang diizinkan boleh memanggil dari browser, termasuk preflight dengan header Authorization", async () => {
    const base = await start();
    const pre = await fetch(`${base}/api/machines`, { method: "OPTIONS", headers: { origin: PWA, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe(PWA);
    const res = await api(base, "/api/machines", TOKEN.d1, { origin: PWA });
    expect(res.headers.get("access-control-allow-origin")).toBe(PWA);
  });

  test("asal lain tidak mendapat izin CORS", async () => {
    const base = await start();
    const res = await api(base, "/api/machines", TOKEN.d1, { origin: "https://jahat.example" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("API tidak ada bila tidak dinyalakan", async () => {
    relay = await startRelayServer({ directory, port: 0, host: "127.0.0.1" });
    expect((await api(`http://127.0.0.1:${relay.port}`, "/api/machines")).status).toBe(404);
  });
});

describe("uji terpadu: laptop -> relay -> HP", () => {
  test("event disimpan SEBELUM di-ack, diteruskan ke HP secara langsung, dan bisa dibaca kembali lewat REST", async () => {
    const base = await start();
    const phone = connectWs(relay?.port as number, "device", TOKEN.d1);
    const laptop = connectWs(relay?.port as number, "machine", TOKEN.m1);
    await Promise.all([phone.ready, laptop.ready]);
    await Promise.all([phone.waitFor("welcome"), laptop.waitFor("welcome")]);

    const sent = event({ seq: 0, sessionId: "live" });
    laptop.ws.send(JSON.stringify({ kind: "event", event: sent }));
    await laptop.waitFor("ack");

    // Begitu ack diterima, event SUDAH ada di riwayat (bukan baru akan disimpan).
    const history = EventsResponseSchema.parse(await (await api(base, "/api/machines/m1/sessions/live/events")).json());
    expect(history.events.map((e) => e.id)).toEqual([sent.id]);
    // Dan HP yang tersambung menerimanya secara langsung.
    await phone.waitFor("event");
    expect(phone.frames.find((f) => f.kind === "event")).toMatchObject({ event: { id: sent.id, sessionId: "live" } });
  });

  test("kiriman ulang event yang sama tidak menggandakan riwayat maupun penerusan ke HP", async () => {
    const base = await start();
    const phone = connectWs(relay?.port as number, "device", TOKEN.d1);
    const laptop = connectWs(relay?.port as number, "machine", TOKEN.m1);
    await Promise.all([phone.ready, laptop.ready]);
    await Promise.all([phone.waitFor("welcome"), laptop.waitFor("welcome")]);

    const sent = event({ seq: 0, sessionId: "dup" });
    for (let i = 0; i < 3; i++) laptop.ws.send(JSON.stringify({ kind: "event", event: sent }));
    await vi.waitFor(() => expect(laptop.frames.filter((f) => f.kind === "ack")).toHaveLength(3));

    expect(EventsResponseSchema.parse(await (await api(base, "/api/machines/m1/sessions/dup/events")).json()).events).toHaveLength(1);
    expect(phone.frames.filter((f) => f.kind === "event")).toHaveLength(1);
  });

  test("HP yang offline saat event dikirim tetap bisa membacanya kemudian (inilah gunanya riwayat)", async () => {
    const base = await start();
    const laptop = connectWs(relay?.port as number, "machine", TOKEN.m1);
    await laptop.ready;
    await laptop.waitFor("welcome");
    for (let seq = 0; seq < 5; seq++) laptop.ws.send(JSON.stringify({ kind: "event", event: event({ seq, sessionId: "terlewat" }) }));
    await vi.waitFor(() => expect(laptop.frames.filter((f) => f.kind === "ack")).toHaveLength(5));

    // HP baru tersambung SESUDAH event dikirim: tidak menerima apa pun secara langsung...
    const phone = connectWs(relay?.port as number, "device", TOKEN.d1);
    await phone.ready;
    await phone.waitFor("welcome");
    expect(phone.frames.filter((f) => f.kind === "event")).toHaveLength(0);
    // ...tetapi bisa mengambil semuanya dari riwayat.
    expect(EventsResponseSchema.parse(await (await api(base, "/api/machines/m1/sessions/terlewat/events?afterSeq=1")).json()).events.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  test("laptop yang berbeda tidak bisa menyisipkan event ke riwayat laptop lain", async () => {
    const base = await start();
    const laptop = connectWs(relay?.port as number, "machine", TOKEN.m2);
    await laptop.ready;
    await laptop.waitFor("welcome");
    laptop.ws.send(JSON.stringify({ kind: "event", event: event({ machineId: "m1", sessionId: "palsu" }) })); // m2 menyamar sebagai m1
    await laptop.waitFor("error");
    expect(laptop.frames.some((f) => f.kind === "ack")).toBe(false);
    expect(EventsResponseSchema.parse(await (await api(base, "/api/machines/m1/sessions/palsu/events")).json()).events).toEqual([]);
  });
});
