// FILE INI: TEST sisi relay untuk E2E (issue #033 bagian D). Yang dijaga: relay hanya melihat data terenkripsi (penanda rahasia TIDAK muncul di
// database, log, atau isi push), izin yang menunggu dan notifikasi dihitung dari AMPLOP tanpa membaca isi, HP tetap bisa membuka dan memverifikasi
// apa yang diambilnya lewat API, dan event yang diubah di relay ditolak HP.
import {
  approvalHash,
  fromB64,
  generateDataKey,
  generateSignKeyPair,
  loadSodium,
  openEvent,
  sealEvent,
  utf8,
  type Sodium,
} from "@agentmon/shared/crypto";
import { sql } from "drizzle-orm";
import type { Envelope, PushPayload } from "@agentmon/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { waitingApprovals } from "./approvals";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createPairingService } from "./db/pairing";
import { createStore } from "./db/store";
import { createTestDatabase, query, resetDatabase } from "./db/testing";
import type { Logger } from "./logger";
import { startRelayServer, type RunningRelay } from "./node";
import { createNotifier, notifyAfterSave, pendingLookup } from "./notifier";

let s: Sodium;
let laptop: { sign: ReturnType<typeof generateSignKeyPair>; dataKey: Uint8Array };
let handle: DatabaseHandle;
let directory: DbDirectory;
let relay: RunningRelay | undefined;
const sockets: WebSocket[] = [];
const logs: string[] = [];
const logger: Logger = { info: (m) => void logs.push(m), error: (m) => void logs.push(m) };

const T = { m1: "machine-token-satu-000000000000000", d1: "device-token-satu-00000000000000000" };
const MARKER = "PENANDA-RAHASIA-JANGAN-BOCOR-98765";
const NOW = new Date("2026-11-24T10:00:00.000Z");
const IN_5_MIN = "2026-11-24T10:05:00.000Z";

beforeAll(async () => {
  s = await loadSodium();
  laptop = { sign: generateSignKeyPair(s), dataKey: generateDataKey(s) };
  handle = await createTestDatabase();
}, 60_000);
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  logs.length = 0;
  directory = createDbDirectory(handle.db);
  await directory.registerMachine({ id: "m1", name: "Laptop", token: T.m1 });
  await directory.registerDevice({ id: "d1", name: "HP", token: T.d1 });
  await directory.pair("m1", "d1");
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await relay?.stop();
  relay = undefined;
});

describe("waitingApprovals (dari amplop, tanpa membaca isi)", () => {
  const env = (over: Partial<Envelope> & { type: string }): Envelope => ({ v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s1", seq: 0, ts: NOW.toISOString(), agent: "claude-code", payload: "TIDAK-DIBACA", ...over }) as Envelope;

  test("izin menunggu dihitung dari approvalId dan expiresAt di amplop; yang selesai atau lewat tenggat tidak dihitung; sesi terpisah", () => {
    const list = waitingApprovals(
      [
        env({ type: "approval.requested", approvalId: "a1", expiresAt: IN_5_MIN }),
        env({ type: "approval.requested", approvalId: "a2", expiresAt: IN_5_MIN }),
        env({ type: "approval.resolved", approvalId: "a2" }),
        env({ type: "approval.requested", approvalId: "a3", expiresAt: "2026-11-24T09:00:00.000Z" }),
        env({ type: "approval.requested", approvalId: "a1", sessionId: "s2", expiresAt: IN_5_MIN }),
        env({ type: "approval.requested", approvalId: "a4", expiresAt: IN_5_MIN }),
        env({ type: "approval.auto_resolved", approvalId: "a4" }),
      ],
      NOW,
    );
    expect(list.map((a) => `${a.sessionId}/${a.approvalId}`).sort()).toEqual(["s1/a1", "s2/a1"]);
  });

  test("event lama tanpa nomor izin di amplop (laptop tanpa E2E) tetap dihitung dari isinya", () => {
    const list = waitingApprovals(
      [env({ type: "approval.requested", payload: { approvalId: "lama", toolName: "Bash", toolInput: {}, expiresAt: IN_5_MIN } })],
      NOW,
    );
    expect(list.map((a) => a.approvalId)).toEqual(["lama"]);
  });

  test("izin tanpa tenggat di amplop tidak dihitung (tidak bisa dipastikan masih berlaku)", () => {
    expect(waitingApprovals([env({ type: "approval.requested", approvalId: "x" })], NOW)).toEqual([]);
  });
});

describe("relay menyimpan dan meneruskan event terenkripsi", () => {
  function seal(type: string, payload: Record<string, unknown>, seq: number, overrides: { approvalId?: string; expiresAt?: string } = {}) {
    const plaintext = utf8(JSON.stringify(payload));
    const base = { v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s1", seq, ts: NOW.toISOString(), agent: "claude-code", type, ...overrides };
    const sealed = sealEvent(s, { dataKey: laptop.dataKey, kid: 1, envelope: base, plaintext, signPrivateKey: laptop.sign.privateKey });
    return { envelope: { ...base, payload: sealed } as unknown as Envelope, plaintext };
  }

  async function startRelay(extra: Partial<Parameters<typeof startRelayServer>[0]> = {}) {
    const store = createStore(handle.db);
    relay = await startRelayServer({
      directory,
      port: 0,
      host: "127.0.0.1",
      logger,
      persist: (event) => store.saveEvent(event),
      pairing: { pairing: createPairingService(handle.db), directory },
      deviceApi: { directory, store, devices: createPairingService(handle.db) },
      ...extra,
    });
    return { store, base: `http://127.0.0.1:${relay.port}` };
  }

  function connect(role: "machine" | "device", token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${relay!.port}/ws`);
    sockets.push(ws);
    const received: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => received.push(JSON.parse(String(data))));
    ws.on("open", () => ws.send(JSON.stringify({ kind: "hello", role, token })));
    return { ws, received };
  }

  test("penanda rahasia TIDAK muncul di database, log relay, maupun yang diteruskan ke HP, tetapi HP bisa membuka dan memverifikasinya", async () => {
    const { base } = await startRelay();
    const machine = connect("machine", T.m1);
    const phone = connect("device", T.d1);
    await expect.poll(() => machine.received.some((f) => f.kind === "welcome") && phone.received.some((f) => f.kind === "welcome")).toBe(true);

    const { envelope, plaintext } = seal("approval.requested", { approvalId: "ap-1", toolName: "Bash", toolInput: { command: `echo ${MARKER}` }, expiresAt: IN_5_MIN }, 1, { approvalId: "ap-1", expiresAt: IN_5_MIN });
    machine.ws.send(JSON.stringify({ kind: "event", event: envelope }));
    await expect.poll(() => phone.received.some((f) => f.kind === "event")).toBe(true);
    await expect.poll(() => machine.received.some((f) => f.kind === "ack")).toBe(true);

    // 1) database: seluruh baris event sebagai teks
    const rows = await query(handle.db, sql.raw("select row_to_json(e)::text as t from events e"));
    const dump = rows.map((r) => String(r.t)).join("\n");
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain(Buffer.from(MARKER).toString("base64"));
    expect(dump).not.toContain("toolInput");
    expect(dump).toContain("ap-1"); // yang memang terlihat: nomor acak izin di amplop

    // 2) log relay
    expect(logs.join("\n")).not.toContain(MARKER);

    // 3) yang diteruskan ke HP lewat WebSocket, dan yang diambil HP lewat API riwayat
    const forwarded = phone.received.find((f) => f.kind === "event")!.event as Envelope;
    expect(JSON.stringify(forwarded)).not.toContain(MARKER);
    expect(forwarded).toMatchObject({ approvalId: "ap-1", expiresAt: IN_5_MIN });
    const history = (await (await fetch(`${base}/api/machines/m1/sessions/s1/events`, { headers: { authorization: `Bearer ${T.d1}` } })).json()) as { events: Envelope[] };
    expect(JSON.stringify(history)).not.toContain(MARKER);
    expect(history.events[0]).toMatchObject({ approvalId: "ap-1", expiresAt: IN_5_MIN });

    // HP: membuka event dari relay dengan kunci laptop yang ia kenal, dan mendapat isi persis semula
    for (const received of [forwarded, history.events[0]!]) {
      const opened = openEvent(s, { payload: received.payload, envelope: { ...received, approvalId: received.approvalId, expiresAt: received.expiresAt }, expectedMachineId: "m1", dataKeys: () => laptop.dataKey, signPublicKey: laptop.sign.publicKey });
      expect(opened.plaintext).toEqual(plaintext);
      expect(approvalHash(s, opened.plaintext)).toEqual(approvalHash(s, plaintext));
    }
  });

  test("relay yang MENGUBAH event (ciphertext di database dibalik satu bit) tidak membuat HP menerimanya", async () => {
    const { base } = await startRelay();
    const machine = connect("machine", T.m1);
    await expect.poll(() => machine.received.some((f) => f.kind === "welcome")).toBe(true);
    const { envelope } = seal("tool.requested", { toolName: "Write", toolInput: { file_path: "a.ts" } }, 1);
    machine.ws.send(JSON.stringify({ kind: "event", event: envelope }));
    await expect.poll(() => machine.received.some((f) => f.kind === "ack")).toBe(true);

    const sealed = envelope.payload as { c: string };
    const flipped = fromB64(s, sealed.c);
    flipped[3] = flipped[3]! ^ 1;
    const tampered = JSON.stringify({ ...sealed, c: Buffer.from(flipped).toString("base64url") });
    await query(handle.db, sql`update events set payload = ${tampered}`);

    const history = (await (await fetch(`${base}/api/machines/m1/sessions/s1/events`, { headers: { authorization: `Bearer ${T.d1}` } })).json()) as { events: Envelope[] };
    const received = history.events[0]!;
    expect(() => openEvent(s, { payload: received.payload, envelope: received, expectedMachineId: "m1", dataKeys: () => laptop.dataKey, signPublicKey: laptop.sign.publicKey })).toThrow();
  });

  test("notifikasi dari event terenkripsi: jumlah dan nomor izin dari AMPLOP, level risiko dan isi tidak ikut, dan isi tidak dibaca relay", async () => {
    const store = createStore(handle.db, { now: () => NOW });
    const pushes: PushPayload[] = [];
    const notifier = createNotifier({
      push: { notifyMachine: async (_machineId, payload) => (pushes.push(payload), { attempted: 1, delivered: 1, failed: 0, removed: 0 }) },
      pending: pendingLookup(store, () => NOW),
      schedule: () => ({ cancel: () => undefined }),
    });
    const save = notifyAfterSave((event) => store.saveEvent(event), notifier);
    const { envelope } = seal("approval.requested", { approvalId: "ap-7", toolName: "Bash", toolInput: { command: MARKER }, risk: { level: "high", reasons: [] }, expiresAt: IN_5_MIN }, 1, { approvalId: "ap-7", expiresAt: IN_5_MIN });
    await save(envelope);
    await expect.poll(() => pushes.length).toBe(1);
    expect(pushes[0]).toEqual({ v: 1, kind: "approval", machineId: "m1", sessionId: "s1", count: 1, approvalId: "ap-7" });
    expect(JSON.stringify(pushes)).not.toContain(MARKER);
    notifier.stop();
  });

  test("penyimpanan: nomor izin dan tenggat di amplop tersimpan dan kembali; event tanpa keduanya tidak mendapat kolom itu", async () => {
    const store = createStore(handle.db);
    const withIds = seal("approval.requested", { approvalId: "ap-1", expiresAt: IN_5_MIN }, 1, { approvalId: "ap-1", expiresAt: IN_5_MIN }).envelope;
    const without = seal("tool.requested", { toolName: "x" }, 2).envelope;
    await store.saveEvent(withIds);
    await store.saveEvent(without);
    const list = await store.listEvents({ machineId: "m1", sessionId: "s1" });
    expect(list[0]).toMatchObject({ approvalId: "ap-1", expiresAt: IN_5_MIN });
    expect(list[1]).not.toHaveProperty("approvalId");
    expect(list[1]).not.toHaveProperty("expiresAt");
  });
});
