// FILE INI: TEST `DELETE /machine` = laptop mencabut DIRINYA SENDIRI dari relay (perintah `uninstall`, issue #045).
// Yang dijaga: hanya pemegang token laptop itu yang bisa, hanya dirinya yang terhapus (data laptop lain dan perangkat HP utuh),
// sambungannya terputus seketika, dan token tidak berlaku lagi.
import { sql } from "drizzle-orm";
import type { Envelope } from "@agentmon/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createPairingService } from "./db/pairing";
import { createStore } from "./db/store";
import { createTestDatabase, query, resetDatabase } from "./db/testing";
import { CLOSE } from "./hub";
import { startRelayServer, type RunningRelay } from "./node";

const T = {
  m1: "machine-token-satu-000000000000000",
  m2: "machine-token-dua-0000000000000000",
  d1: "device-token-satu-00000000000000000",
  d2: "device-token-dua-000000000000000000",
  d3: "device-token-tiga-00000000000000000",
};

let handle: DatabaseHandle;
let directory: DbDirectory;
let relay: RunningRelay | undefined;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  directory = createDbDirectory(handle.db);
  await directory.registerMachine({ id: "m1", name: "Laptop Kantor", token: T.m1 });
  await directory.registerMachine({ id: "m2", name: "Laptop Rumah", token: T.m2 });
  await directory.registerDevice({ id: "d1", name: "HP satu", token: T.d1 }); // hanya dengan m1
  await directory.registerDevice({ id: "d2", name: "HP dua", token: T.d2 }); // hanya dengan m2
  await directory.registerDevice({ id: "d3", name: "HP bersama", token: T.d3 }); // dengan keduanya
  await directory.pair("m1", "d1");
  await directory.pair("m1", "d3");
  await directory.pair("m2", "d2");
  await directory.pair("m2", "d3");
  const store = createStore(handle.db);
  const event = (machineId: string, id: string): Envelope => ({ v: 1, id, machineId, sessionId: `sesi-${machineId}`, seq: 0, ts: "2026-11-10T10:00:00.000Z", agent: "claude-code", type: "tool.requested", payload: { toolName: "Write", toolInput: {} } });
  await store.saveEvent(event("m1", "00000000-0000-4000-8000-000000000001"));
  await store.saveEvent(event("m2", "00000000-0000-4000-8000-000000000002"));
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await relay?.stop();
  relay = undefined;
});

async function start(): Promise<string> {
  const pairing = createPairingService(handle.db);
  relay = await startRelayServer({
    directory,
    port: 0,
    host: "127.0.0.1",
    persist: (event) => createStore(handle.db).saveEvent(event),
    pairing: { pairing, directory },
    deviceApi: { directory, store: createStore(handle.db), devices: pairing },
  });
  return `http://127.0.0.1:${relay.port}`;
}

const call = (base: string, method: string, path: string, token: string | null) => fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
const count = async (table: string, where = "true") => Number((await query(handle.db, sql.raw(`select count(*)::int as n from ${table} where ${where}`)))[0]?.n);

function connectWs(port: number, role: "machine" | "device", token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state: { closeCode?: number; welcomed?: boolean } = {};
  ws.on("message", (data) => {
    if ((JSON.parse(String(data)) as { kind?: string }).kind === "welcome") state.welcomed = true;
  });
  ws.on("close", (code) => (state.closeCode = code));
  ws.on("open", () => ws.send(JSON.stringify({ kind: "hello", role, token })));
  return { ws, state };
}

describe("DELETE /machine", () => {
  test.each([
    ["tanpa token", null],
    ["token salah", "token-yang-salah-0000000000000000"],
    ["token HP (bukan laptop)", T.d1],
  ])("%s: 401 dan tidak ada yang terhapus", async (_n, token) => {
    const base = await start();
    const res = await call(base, "DELETE", "/machine", token);
    expect(res.status).toBe(401);
    expect(await count("machines")).toBe(2);
    expect(await count("pairings")).toBe(4);
    expect(await count("events")).toBe(2);
  });

  test("berhasil: laptop dan turunannya (pasangan, sesi, event) hilang; laptop lain dan perangkat HP utuh", async () => {
    const base = await start();
    const code = await call(base, "POST", "/pair/code", T.m1); // kode pairing yang belum terpakai milik m1
    expect(code.status).toBe(201);
    expect(await count("pairing_codes", "machine_id = 'm1'")).toBe(1);

    const res = await call(base, "DELETE", "/machine", T.m1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await count("machines", "id = 'm1'")).toBe(0);
    expect(await count("pairings", "machine_id = 'm1'")).toBe(0);
    expect(await count("sessions", "machine_id = 'm1'")).toBe(0);
    expect(await count("events", "machine_id = 'm1'")).toBe(0);
    expect(await count("pairing_codes", "machine_id = 'm1'")).toBe(0);

    // milik laptop lain tidak tersentuh
    expect(await count("machines", "id = 'm2'")).toBe(1);
    expect(await count("pairings", "machine_id = 'm2'")).toBe(2);
    expect(await count("events", "machine_id = 'm2'")).toBe(1);
    // perangkat HP tetap ada (bisa dipasangkan ke laptop lain); hanya hubungannya dengan m1 yang hilang
    expect(await count("devices")).toBe(3);
    expect(await count("pairings", "device_id = 'd3'")).toBe(1);
  });

  test("tokennya langsung tidak berlaku, dan permintaan kedua dijawab 401 (seperti token salah)", async () => {
    const base = await start();
    expect((await call(base, "DELETE", "/machine", T.m1)).status).toBe(200);
    expect((await call(base, "DELETE", "/machine", T.m1)).status).toBe(401);
    expect((await call(base, "POST", "/pair/code", T.m1)).status).toBe(401);
    expect((await call(base, "GET", "/pair/devices", T.m1)).status).toBe(401);
    // laptop lain tidak terganggu
    expect((await call(base, "GET", "/pair/devices", T.m2)).status).toBe(200);
  });

  test("tidak ada nomor di jalur permintaan: tidak ada jalan menghapus laptop LAIN", async () => {
    const base = await start();
    for (const path of ["/machine/m2", "/machine/m1", "/machines/m2", "/admin/machines/m2"]) {
      const res = await call(base, "DELETE", path, T.m1);
      expect([404, 405], path).toContain(res.status);
    }
    expect(await count("machines")).toBe(2);
    // dan dengan token m1, hanya m1 yang terhapus
    await call(base, "DELETE", "/machine", T.m1);
    expect(await count("machines", "id = 'm2'")).toBe(1);
  });

  test("sambungan WebSocket laptop itu diputus seketika; laptop lain tetap tersambung", async () => {
    const base = await start();
    const port = relay!.port;
    const gone = connectWs(port, "machine", T.m1);
    const stays = connectWs(port, "machine", T.m2);
    await vi.waitFor(() => expect(gone.state.welcomed && stays.state.welcomed).toBe(true));
    expect((await call(base, "DELETE", "/machine", T.m1)).status).toBe(200);
    await vi.waitFor(() => expect(gone.state.closeCode).toBeDefined());
    expect(gone.state.closeCode).toBe(CLOSE.unauthorized);
    expect(stays.state.closeCode).toBeUndefined();
    // sambungan baru dengan token yang sama ditolak
    const retry = connectWs(port, "machine", T.m1);
    await vi.waitFor(() => expect(retry.state.closeCode).toBeDefined());
    expect(retry.state.welcomed).not.toBe(true);
  });

  test("HP yang dipasangkan tidak lagi melihat laptop itu", async () => {
    const base = await start();
    const before = (await (await call(base, "GET", "/api/machines", T.d3)).json()) as { machines: Array<{ id: string }> };
    expect(before.machines.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    await call(base, "DELETE", "/machine", T.m1);
    const after = (await (await call(base, "GET", "/api/machines", T.d3)).json()) as { machines: Array<{ id: string }> };
    expect(after.machines.map((m) => m.id)).toEqual(["m2"]);
    const none = (await (await call(base, "GET", "/api/machines", T.d1)).json()) as { machines: unknown[] };
    expect(none.machines).toEqual([]);
  });
});
