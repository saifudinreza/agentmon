import { DevicesResponseSchema, PairedDevicesResponseSchema } from "@agentmon/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createPairingService } from "./db/pairing";
import { createStore } from "./db/store";
import { createTestDatabase, resetDatabase } from "./db/testing";
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
  await directory.registerDevice({ id: "d1", name: "HP satu", token: T.d1 });
  await directory.registerDevice({ id: "d2", name: "HP dua", token: T.d2 });
  await directory.registerDevice({ id: "d3", name: "HP hilang", token: T.d3 });
  await directory.pair("m1", "d1");
  await directory.pair("m1", "d3");
  await directory.pair("m2", "d2");
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

const call = (base: string, method: string, path: string, token: string | null) =>
  fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

function connectWs(port: number, role: "machine" | "device", token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  const state: { closeCode?: number } = {};
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  ws.on("close", (code) => (state.closeCode = code));
  ws.on("open", () => ws.send(JSON.stringify({ kind: "hello", role, token })));
  return { ws, frames, state };
}
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const presences = (frames: Array<Record<string, unknown>>) => frames.filter((f) => f.kind === "presence").map((f) => f.reachable);

describe("GET /api/devices", () => {
  test("HP melihat dirinya dan sesamanya yang berbagi laptop, dengan penanda 'current'; HP laptop lain tidak tampak", async () => {
    const base = await start();
    const res = await call(base, "GET", "/api/devices", T.d1);
    expect(res.status).toBe(200);
    const { devices } = DevicesResponseSchema.parse(await res.json());
    expect(devices.map((d) => [d.id, d.name, d.current])).toEqual([
      ["d1", "HP satu", true],
      ["d3", "HP hilang", false],
    ]);
  });

  test("tanpa token atau token salah: 401", async () => {
    const base = await start();
    expect((await call(base, "GET", "/api/devices", null)).status).toBe(401);
    expect((await call(base, "GET", "/api/devices", "token-salah-00000000000000000000")).status).toBe(401);
  });
});

describe("DELETE /api/devices/:id (dari HP)", () => {
  test("perangkat yang dicabut: koneksinya langsung diputus, token ditolak, sambung ulang ditolak, hilang dari daftar", async () => {
    const base = await start();
    const port = relay!.port;
    const lost = connectWs(port, "device", T.d3);
    await vi_waitFor(() => lost.frames.some((f) => f.kind === "welcome"));

    const res = await call(base, "DELETE", "/api/devices/d3", T.d1);
    expect(res.status).toBe(200);

    await vi_waitFor(() => lost.state.closeCode !== undefined);
    expect(lost.state.closeCode).toBe(CLOSE.unauthorized);
    expect((await call(base, "GET", "/api/devices", T.d3)).status).toBe(401);

    const again = connectWs(port, "device", T.d3);
    await vi_waitFor(() => again.state.closeCode !== undefined);
    expect(again.frames.some((f) => f.kind === "welcome")).toBe(false);

    const { devices } = DevicesResponseSchema.parse(await (await call(base, "GET", "/api/devices", T.d1)).json());
    expect(devices.map((d) => d.id)).toEqual(["d1"]);
  });

  test("mencabut dua kali aman (idempoten)", async () => {
    const base = await start();
    expect((await call(base, "DELETE", "/api/devices/d3", T.d1)).status).toBe(200);
    expect((await call(base, "DELETE", "/api/devices/d3", T.d1)).status).toBe(200);
  });

  test("perangkat milik laptop lain atau yang tidak ada: 404 yang sama, dan tidak terpengaruh", async () => {
    const base = await start();
    const other = await call(base, "DELETE", "/api/devices/d2", T.d1);
    const none = await call(base, "DELETE", "/api/devices/hantu", T.d1);
    expect(other.status).toBe(404);
    expect(none.status).toBe(404);
    expect(await other.json()).toEqual(await none.json());
    expect((await call(base, "GET", "/api/devices", T.d2)).status).toBe(200); // d2 masih sah
  });

  test("HP boleh mencabut dirinya sendiri; tokennya langsung tidak berlaku", async () => {
    const base = await start();
    expect((await call(base, "DELETE", "/api/devices/d1", T.d1)).status).toBe(200);
    expect((await call(base, "GET", "/api/devices", T.d1)).status).toBe(401);
  });

  test("tanpa token: 401, dan tidak ada yang dicabut", async () => {
    const base = await start();
    expect((await call(base, "DELETE", "/api/devices/d3", null)).status).toBe(401);
    expect((await call(base, "GET", "/api/devices", T.d3)).status).toBe(200);
  });

  test("laptop diberi tahu: hitungan HP yang bisa dihubungi turun seketika", async () => {
    const base = await start();
    const port = relay!.port;
    const machine = connectWs(port, "machine", T.m1);
    connectWs(port, "device", T.d1);
    connectWs(port, "device", T.d3);
    await vi_waitFor(() => presences(machine.frames).at(-1) === 2);
    await call(base, "DELETE", "/api/devices/d3", T.d1);
    await vi_waitFor(() => presences(machine.frames).at(-1) === 1);
  });

  test("keputusan dari perangkat yang dicabut ditolak: perintahnya tidak sampai ke laptop", async () => {
    const base = await start();
    const port = relay!.port;
    const machine = connectWs(port, "machine", T.m1);
    const lost = connectWs(port, "device", T.d3);
    await vi_waitFor(() => lost.frames.some((f) => f.kind === "welcome") && machine.frames.some((f) => f.kind === "welcome"));
    const body = { type: "approval.decision", commandId: "11111111-1111-4111-8111-111111111111", approvalId: "a1", decision: "approve" };

    lost.ws.send(JSON.stringify({ kind: "command", machineId: "m1", body })); // sebelum dicabut: sampai
    await vi_waitFor(() => machine.frames.some((f) => f.kind === "command"));

    await call(base, "DELETE", "/api/devices/d3", T.d1);
    await vi_waitFor(() => lost.state.closeCode !== undefined);
    const before = machine.frames.filter((f) => f.kind === "command").length;
    try {
      lost.ws.send(JSON.stringify({ kind: "command", machineId: "m1", body })); // soket sudah tertutup
    } catch {
      // diharapkan
    }
    // Sambung ulang dengan token yang sama juga tidak bisa mengirim apa pun.
    const retry = connectWs(port, "device", T.d3);
    await vi_waitFor(() => retry.state.closeCode !== undefined);
    await settle();
    expect(machine.frames.filter((f) => f.kind === "command")).toHaveLength(before);
  });
});

describe("DELETE /pair/devices/:id (dari laptop, untuk HP yang hilang)", () => {
  test("laptop mencabut HP-nya: diputus, ditolak, dan hilang dari daftar laptop", async () => {
    const base = await start();
    const lost = connectWs(relay!.port, "device", T.d3);
    await vi_waitFor(() => lost.frames.some((f) => f.kind === "welcome"));
    expect((await call(base, "DELETE", "/pair/devices/d3", T.m1)).status).toBe(200);
    await vi_waitFor(() => lost.state.closeCode !== undefined);
    expect((await call(base, "GET", "/api/devices", T.d3)).status).toBe(401);
    const list = PairedDevicesResponseSchema.parse(await (await call(base, "GET", "/pair/devices", T.m1)).json());
    expect(list.devices.map((d) => d.id)).toEqual(["d1"]);
  });

  test("laptop tidak boleh mencabut HP milik laptop lain (404), dan tanpa token 401", async () => {
    const base = await start();
    expect((await call(base, "DELETE", "/pair/devices/d2", T.m1)).status).toBe(404);
    expect((await call(base, "DELETE", "/pair/devices/d3", T.m2)).status).toBe(404);
    expect((await call(base, "DELETE", "/pair/devices/d3", null)).status).toBe(401);
    expect((await call(base, "GET", "/api/devices", T.d3)).status).toBe(200); // tidak ada yang tercabut
    expect((await call(base, "GET", "/api/devices", T.d2)).status).toBe(200);
  });
});


describe("perintah dari soket yang masih terbuka setelah pencabutan di database", () => {
  test("hub menolak (forbidden) dan laptop tidak menerima apa pun, walau soket belum sempat diputus", async () => {
    await start();
    const port = relay!.port;
    const machine = connectWs(port, "machine", T.m1);
    const lost = connectWs(port, "device", T.d3);
    await vi_waitFor(() => lost.frames.some((f) => f.kind === "welcome") && machine.frames.some((f) => f.kind === "welcome"));
    await directory.revokeDevice("d3"); // langsung di database: hub belum memutus soketnya
    lost.ws.send(JSON.stringify({ kind: "command", machineId: "m1", body: { type: "approval.decision", commandId: "11111111-1111-4111-8111-111111111111", approvalId: "a1", decision: "approve" } }));
    await vi_waitFor(() => lost.frames.some((f) => f.kind === "error" && f.code === "forbidden"));
    await settle();
    expect(machine.frames.filter((f) => f.kind === "command")).toHaveLength(0);
  });
});

describe("perintah rollback dari perangkat yang tidak berhak", () => {
  const rollbackBody = { type: "rollback.apply", commandId: "22222222-2222-4222-8222-222222222222", checkpointId: "cp1", previewHash: "h" };

  test("HP yang sudah dicabut (soket lama masih terbuka) dan HP milik laptop lain: ditolak, laptop tidak menerima apa pun", async () => {
    await start();
    const port = relay!.port;
    const machine = connectWs(port, "machine", T.m1);
    const revoked = connectWs(port, "device", T.d3);
    const stranger = connectWs(port, "device", T.d2); // dipasangkan dengan m2, bukan m1
    await vi_waitFor(() => [revoked, stranger, machine].every((c) => c.frames.some((f) => f.kind === "welcome")));
    await directory.revokeDevice("d3"); // dicabut di database; soketnya belum diputus hub
    for (const device of [revoked, stranger]) device.ws.send(JSON.stringify({ kind: "command", machineId: "m1", body: rollbackBody }));
    await vi_waitFor(() => revoked.frames.some((f) => f.kind === "error" && f.code === "forbidden") && stranger.frames.some((f) => f.kind === "error" && f.code === "forbidden"));
    await settle();
    expect(machine.frames.filter((f) => f.kind === "command")).toHaveLength(0);
  });

  test("token tidak dikenal: tidak bisa tersambung sehingga tidak bisa mengirim perintah", async () => {
    await start();
    const unknown = connectWs(relay!.port, "device", "token-tidak-dikenal-0000000000000000");
    await vi_waitFor(() => unknown.state.closeCode !== undefined);
    expect(unknown.frames.some((f) => f.kind === "welcome")).toBe(false);
  });
});

// Menunggu sampai syarat terpenuhi (lihat vi.waitFor); ditulis sendiri agar mudah dipakai dengan fungsi boolean.
async function vi_waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("syarat tidak terpenuhi tepat waktu");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
