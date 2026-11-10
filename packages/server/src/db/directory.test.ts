import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { hashToken } from "../directory";
import { describeDirectoryContract } from "../directory.contract";
import { CLOSE, createRelayHub } from "../hub";
import type { ServerFrame } from "@agentmon/shared";
import type { DatabaseHandle } from "./connect";
import { createDbDirectory, type DbDirectory } from "./directory";
import { createTestDatabase, query, resetDatabase } from "./testing";

let handle: DatabaseHandle;
const clock = { ms: Date.parse("2026-11-11T00:00:00Z") };
let directory: DbDirectory;

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);
afterAll(() => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  clock.ms = Date.parse("2026-11-11T00:00:00Z");
  directory = createDbDirectory(handle.db, { now: () => new Date(clock.ms) });
});

const MACHINE = "machine-token-0000000000000000";
const DEVICE = "device-token-00000000000000000";

// Kontrak yang SAMA dengan direktori memori: keduanya harus berperilaku identik.
describeDirectoryContract("database", async () => {
  await resetDatabase(handle.db);
  const db = createDbDirectory(handle.db);
  return {
    directory: db,
    addMachine: (id, token) => db.registerMachine({ id, name: id, token }),
    addDevice: (id, token) => db.registerDevice({ id, name: id, token }),
    pair: (machineId, deviceId) => db.pair(machineId, deviceId),
    unpair: (machineId, deviceId) => db.unpair(machineId, deviceId),
  };
});

describe("token hanya tersimpan sebagai hash", () => {
  test("tidak ada token mentah di tabel mana pun, dan yang tersimpan adalah SHA-256-nya", async () => {
    await directory.registerMachine({ id: "m1", name: "Laptop", token: MACHINE });
    await directory.registerDevice({ id: "d1", name: "HP", token: DEVICE });

    const dump = JSON.stringify([
      await query(handle.db, sql`select * from machines`),
      await query(handle.db, sql`select * from devices`),
      await query(handle.db, sql`select * from pairings`),
    ]);
    expect(dump).not.toContain(MACHINE);
    expect(dump).not.toContain(DEVICE);
    expect(dump).toContain(hashToken(MACHINE));
    expect(dump).toContain(hashToken(DEVICE));

    const [row] = await query(handle.db, sql`select token_hash from machines`);
    expect(String(row?.token_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("token yang terlalu pendek tidak didaftarkan", async () => {
    await expect(directory.registerMachine({ id: "m1", name: "x", token: "pendek" })).rejects.toThrow(/minimal/);
    await expect(directory.registerDevice({ id: "d1", name: "x", token: "pendek" })).rejects.toThrow(/minimal/);
    expect(await query(handle.db, sql`select 1 from machines`)).toHaveLength(0);
  });

  test("dua laptop tidak bisa memakai token yang sama", async () => {
    await directory.registerMachine({ id: "m1", name: "a", token: MACHINE });
    await expect(directory.registerMachine({ id: "m2", name: "b", token: MACHINE })).rejects.toThrow();
  });

  test("nomor yang sama tidak bisa didaftarkan dua kali", async () => {
    await directory.registerMachine({ id: "m1", name: "a", token: MACHINE });
    await expect(directory.registerMachine({ id: "m1", name: "b", token: "token-lain-000000000000000000" })).rejects.toThrow();
  });
});

describe("perangkat yang dicabut", () => {
  test("HP yang dicabut tidak bisa tersambung dan tidak dianggap dipasangkan", async () => {
    await directory.registerMachine({ id: "m1", name: "Laptop", token: MACHINE });
    await directory.registerDevice({ id: "d1", name: "HP", token: DEVICE });
    await directory.pair("m1", "d1");
    expect(await directory.authenticate("device", DEVICE)).toBe("d1");

    await directory.revokeDevice("d1");

    expect(await directory.authenticate("device", DEVICE)).toBeUndefined();
    expect(await directory.isPaired("m1", "d1")).toBe(false);
    expect(await directory.devicesOf("m1")).toEqual([]);
  });

  test("jejak HP yang dicabut tetap ada (waktu pencabutan tercatat), dan mencabut dua kali tidak mengubah waktunya", async () => {
    await directory.registerDevice({ id: "d1", name: "HP", token: DEVICE });
    await directory.revokeDevice("d1");
    const first = await query(handle.db, sql`select revoked_at from devices where id = 'd1'`);
    expect(first[0]?.revoked_at).not.toBeNull();

    clock.ms += 3_600_000;
    await directory.revokeDevice("d1");
    const second = await query(handle.db, sql`select revoked_at from devices where id = 'd1'`);
    expect(second[0]?.revoked_at).toEqual(first[0]?.revoked_at);
  });

  test("mencabut satu HP tidak memengaruhi HP lain yang dipasangkan dengan laptop yang sama", async () => {
    await directory.registerMachine({ id: "m1", name: "Laptop", token: MACHINE });
    await directory.registerDevice({ id: "d1", name: "HP satu", token: DEVICE });
    await directory.registerDevice({ id: "d2", name: "HP dua", token: "device-token-dua-000000000000000" });
    await directory.pair("m1", "d1");
    await directory.pair("m1", "d2");
    await directory.revokeDevice("d1");
    expect(await directory.devicesOf("m1")).toEqual(["d2"]);
  });
});

describe("waktu terakhir terlihat", () => {
  test("laptop yang berhasil tersambung dicatat waktunya, dan yang gagal tidak mengubah apa pun", async () => {
    await directory.registerMachine({ id: "m1", name: "Laptop", token: MACHINE });
    expect((await query(handle.db, sql`select last_seen_at from machines`))[0]?.last_seen_at).toBeNull();

    await directory.authenticate("machine", "token-salah-0000000000000000");
    expect((await query(handle.db, sql`select last_seen_at from machines`))[0]?.last_seen_at).toBeNull();

    await directory.authenticate("machine", MACHINE);
    // SQL mentah mengembalikan waktu sebagai teks; dinormalkan dulu sebelum dibandingkan.
    const seen = (await query(handle.db, sql`select last_seen_at from machines`))[0]?.last_seen_at;
    expect(new Date(String(seen)).toISOString()).toBe(new Date(clock.ms).toISOString());
  });

  test("bila hanya pencatatan waktu yang gagal, laptop dengan token sah tetap diterima", async () => {
    await directory.registerMachine({ id: "m1", name: "Laptop", token: MACHINE });
    await handle.db.execute(sql`create function tolak_update() returns trigger language plpgsql as $$ begin raise exception 'update ditolak'; end $$`);
    await handle.db.execute(sql`create trigger tolak before update on machines for each row execute function tolak_update()`);
    try {
      expect(await directory.authenticate("machine", MACHINE)).toBe("m1");
      // Token salah tetap ditolak: gagal tertutup berlaku untuk keputusan, bukan pembukuan.
      expect(await directory.authenticate("machine", "token-salah-0000000000000000")).toBeUndefined();
    } finally {
      await handle.db.execute(sql`drop trigger tolak on machines`);
      await handle.db.execute(sql`drop function tolak_update()`);
    }
  });
});

describe("dipakai relay sungguhan: menggantikan direktori memori tanpa mengubah hub", () => {
  const envelope = (machineId: string) => ({
    v: 1, id: "11111111-1111-4111-8111-111111111111", machineId, sessionId: "s1", seq: 0,
    ts: "2026-11-11T10:00:00.000Z", agent: "claude-code", type: "tool.requested", payload: { toolName: "Write", toolInput: {} },
  });

  function connection() {
    const sent: ServerFrame[] = [];
    let closed: { code: number } | undefined;
    return {
      sent,
      get closed() {
        return closed;
      },
      conn: { send: (t: string) => void sent.push(JSON.parse(t) as ServerFrame), close: (code: number) => void (closed = { code }) },
    };
  }
  const join = async (hub: ReturnType<typeof createRelayHub>, role: "machine" | "device", token: string) => {
    const c = connection();
    const session = hub.accept(c.conn);
    await session.receive(JSON.stringify({ kind: "hello", role, token }));
    return { c, session };
  };

  test("pesan hanya sampai ke HP yang dipasangkan, dan HP yang dicabut langsung berhenti menerima", async () => {
    await directory.registerMachine({ id: "m1", name: "Laptop", token: MACHINE });
    await directory.registerDevice({ id: "d1", name: "HP dipasangkan", token: DEVICE });
    await directory.registerDevice({ id: "d2", name: "HP asing", token: "device-token-dua-000000000000000" });
    await directory.pair("m1", "d1");

    const hub = createRelayHub({ directory });
    const m1 = await join(hub, "machine", MACHINE);
    const d1 = await join(hub, "device", DEVICE);
    const d2 = await join(hub, "device", "device-token-dua-000000000000000");

    await m1.session.receive(JSON.stringify({ kind: "event", event: envelope("m1") }));
    expect(d1.c.sent.filter((f) => f.kind === "event")).toHaveLength(1);
    expect(d2.c.sent.filter((f) => f.kind === "event")).toHaveLength(0); // tidak dipasangkan

    await directory.revokeDevice("d1");
    await m1.session.receive(JSON.stringify({ kind: "event", event: envelope("m1") }));
    expect(d1.c.sent.filter((f) => f.kind === "event")).toHaveLength(1); // tidak bertambah
  });

  test("HP yang sudah dicabut ditolak saat mencoba tersambung", async () => {
    await directory.registerDevice({ id: "d1", name: "HP", token: DEVICE });
    await directory.revokeDevice("d1");
    const hub = createRelayHub({ directory });
    const d1 = await join(hub, "device", DEVICE);
    expect(d1.c.sent).toEqual([{ kind: "error", code: "unauthorized", message: "token tidak dikenal" }]);
    expect(d1.c.closed?.code).toBe(CLOSE.unauthorized);
  });

  test("database yang mati diperlakukan sebagai ditolak (gagal tertutup), bukan diloloskan", async () => {
    const closedHandle = await createTestDatabase();
    const dir = createDbDirectory(closedHandle.db);
    await dir.registerMachine({ id: "m1", name: "Laptop", token: MACHINE });
    await closedHandle.close(); // database "mati"

    const hub = createRelayHub({ directory: dir });
    const m1 = await join(hub, "machine", MACHINE);
    expect(m1.c.sent.map((f) => f.kind)).toEqual(["error"]);
    expect(m1.c.closed).toBeDefined();
  }, 60_000);
});
