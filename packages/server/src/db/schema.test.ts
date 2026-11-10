import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS_FOLDER, openPglite, type DatabaseHandle } from "./connect";
import * as schema from "./schema";
import { devices, events, machines, pairingCodes, pairings, pushSubscriptions, sessions } from "./schema";
import { createTestDatabase, query, resetDatabase } from "./testing";

const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);
const TABLES = ["devices", "events", "machines", "pairing_codes", "pairings", "push_subscriptions", "sessions"];
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

describe("migrasi", () => {
  test("berjalan dari database kosong dan membuat ketujuh tabel PRD", async () => {
    const handle = await openPglite();
    try {
      const tableNames = async () =>
        (await query(handle.db, sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).map(
          (row) => row.table_name,
        );
      expect(await tableNames()).toEqual([]); // memang kosong di awal

      await handle.migrate();
      expect(await tableNames()).toEqual(TABLES);
    } finally {
      await handle.close();
    }
  }, 60_000);

  test("aman dijalankan berulang (tidak error dan tidak menggandakan)", async () => {
    const handle = await openPglite();
    try {
      await handle.migrate();
      await handle.migrate();
      await handle.migrate();
      const applied = await query(handle.db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
      const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql"));
      expect(applied[0]?.n).toBe(files.length);
    } finally {
      await handle.close();
    }
  }, 60_000);

  test("skema di kode SAMA dengan migrasi terakhir (tidak ada perubahan yang lupa dimigrasi)", async () => {
    const snapshots = readdirSync(join(MIGRATIONS_FOLDER, "meta"))
      .filter((f) => f.endsWith("_snapshot.json"))
      .sort();
    const latest = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", snapshots.at(-1) as string), "utf8"));
    const current = generateDrizzleJson(schema);
    // Selisih antara migrasi terakhir dan skema saat ini harus kosong.
    const pending = await generateMigration(latest, current);
    expect(pending, "Skema berubah tetapi migrasinya belum dibuat. Jalankan: pnpm --filter @agentmon/server db:generate").toEqual([]);
  });
});

describe("batasan di tingkat database", () => {
  let handle: DatabaseHandle;
  beforeAll(async () => {
    handle = await createTestDatabase();
  }, 60_000);
  afterAll(() => handle.close());
  beforeEach(() => resetDatabase(handle.db));

  const db = () => handle.db;

  describe("token hanya boleh berupa hash", () => {
    test.each([
      ["token mentah", "token-mentah-yang-tak-sengaja-tersimpan"],
      ["hash terlalu pendek", "a".repeat(63)],
      ["hash terlalu panjang", "a".repeat(65)],
      ["heksadesimal huruf besar", "A".repeat(64)],
      ["bukan heksadesimal", "z".repeat(64)],
      ["kosong", ""],
    ])("laptop menolak %s", async (_name, value) => {
      await expect(db().insert(machines).values({ id: "m1", name: "x", tokenHash: value })).rejects.toThrow();
    });

    test("HP dan kode pairing juga menolak yang bukan hash", async () => {
      await expect(db().insert(devices).values({ id: "d1", name: "x", tokenHash: "mentah" })).rejects.toThrow();
      await db().insert(machines).values({ id: "m1", name: "x", tokenHash: HASH });
      await expect(
        db().insert(pairingCodes).values({ codeHash: "123456", machineId: "m1", expiresAt: new Date(Date.now() + 60_000) }),
      ).rejects.toThrow();
    });

    test("hash SHA-256 yang sah diterima", async () => {
      await db().insert(machines).values({ id: "m1", name: "x", tokenHash: HASH });
      await db().insert(devices).values({ id: "d1", name: "x", tokenHash: HASH2 });
    });

    test("satu hash tidak bisa dipakai dua laptop", async () => {
      await db().insert(machines).values({ id: "m1", name: "x", tokenHash: HASH });
      await expect(db().insert(machines).values({ id: "m2", name: "y", tokenHash: HASH })).rejects.toThrow();
    });
  });

  describe("kunci asing dan penghapusan berantai", () => {
    test("tidak bisa memasangkan laptop atau HP yang tidak ada", async () => {
      await db().insert(machines).values({ id: "m1", name: "x", tokenHash: HASH });
      await expect(db().insert(pairings).values({ machineId: "m1", deviceId: "tidak-ada" })).rejects.toThrow();
      await expect(db().insert(pairings).values({ machineId: "tidak-ada", deviceId: "d1" })).rejects.toThrow();
    });

    test("event tidak bisa menunjuk sesi yang tidak ada", async () => {
      await db().insert(machines).values({ id: "m1", name: "x", tokenHash: HASH });
      await expect(
        db().insert(events).values({
          machineId: "m1", id: EVENT_ID, sessionId: "tidak-ada", seq: 0, ts: new Date(), agent: "claude-code", type: "x", payload: "{}",
        }),
      ).rejects.toThrow();
    });

    test("menghapus laptop menghapus pasangan, kode pairing, sesi, dan event-nya, tanpa menyentuh yang lain", async () => {
      await db().insert(machines).values([{ id: "m1", name: "a", tokenHash: HASH }, { id: "m2", name: "b", tokenHash: HASH2 }]);
      await db().insert(devices).values({ id: "d1", name: "hp", tokenHash: "c".repeat(64) });
      await db().insert(pairings).values([{ machineId: "m1", deviceId: "d1" }, { machineId: "m2", deviceId: "d1" }]);
      await db().insert(pairingCodes).values({ codeHash: "d".repeat(64), machineId: "m1", expiresAt: new Date(Date.now() + 60_000) });
      for (const machineId of ["m1", "m2"]) {
        await db().insert(sessions).values({ machineId, sessionId: "s", agent: "claude-code", startedAt: new Date(), lastEventAt: new Date() });
        await db().insert(events).values({
          machineId, id: machineId === "m1" ? EVENT_ID : "22222222-2222-4222-8222-222222222222",
          sessionId: "s", seq: 0, ts: new Date(), agent: "claude-code", type: "x", payload: "{}",
        });
      }

      await db().execute(sql`delete from machines where id = 'm1'`);

      const count = async (table: string, where = "true") => Number((await query(db(), sql.raw(`select count(*)::int as n from ${table} where ${where}`)))[0]?.n);
      expect(await count("pairings", "machine_id = 'm1'")).toBe(0);
      expect(await count("pairing_codes")).toBe(0);
      expect(await count("sessions", "machine_id = 'm1'")).toBe(0);
      expect(await count("events", "machine_id = 'm1'")).toBe(0);
      // Laptop lain dan HP-nya utuh.
      expect(await count("pairings", "machine_id = 'm2'")).toBe(1);
      expect(await count("sessions", "machine_id = 'm2'")).toBe(1);
      expect(await count("events", "machine_id = 'm2'")).toBe(1);
      expect(await count("devices")).toBe(1);
    });

    test("menghapus HP menghapus pasangan dan langganan pushnya", async () => {
      await db().insert(machines).values({ id: "m1", name: "a", tokenHash: HASH });
      await db().insert(devices).values({ id: "d1", name: "hp", tokenHash: HASH2 });
      await db().insert(pairings).values({ machineId: "m1", deviceId: "d1" });
      await db().insert(pushSubscriptions).values({ deviceId: "d1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" });
      await db().execute(sql`delete from devices where id = 'd1'`);
      expect(await query(db(), sql`select 1 from pairings`)).toHaveLength(0);
      expect(await query(db(), sql`select 1 from push_subscriptions`)).toHaveLength(0);
      expect(await query(db(), sql`select 1 from machines`)).toHaveLength(1);
    });
  });

  describe("nilai yang tidak sah ditolak", () => {
    async function seedSession() {
      await db().insert(machines).values({ id: "m1", name: "x", tokenHash: HASH });
    }

    test("status sesi dan agent harus yang dikenal", async () => {
      await seedSession();
      const base = { machineId: "m1", sessionId: "s", startedAt: new Date(), lastEventAt: new Date() };
      await expect(db().insert(sessions).values({ ...base, agent: "claude-code", status: "meledak" })).rejects.toThrow();
      await expect(db().insert(sessions).values({ ...base, agent: "agent-asing" })).rejects.toThrow();
      await db().insert(sessions).values({ ...base, agent: "codex" }); // yang sah diterima
    });

    test("nomor urut event tidak boleh negatif, dan id event harus UUID", async () => {
      await seedSession();
      await db().insert(sessions).values({ machineId: "m1", sessionId: "s", agent: "claude-code", startedAt: new Date(), lastEventAt: new Date() });
      const base = { machineId: "m1", sessionId: "s", ts: new Date(), agent: "claude-code", type: "x", payload: "{}" };
      await expect(db().insert(events).values({ ...base, id: EVENT_ID, seq: -1 })).rejects.toThrow();
      await expect(db().insert(events).values({ ...base, id: "bukan-uuid", seq: 0 })).rejects.toThrow();
    });

    test("endpoint langganan push unik", async () => {
      await db().insert(devices).values({ id: "d1", name: "hp", tokenHash: HASH });
      const row = { deviceId: "d1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" };
      await db().insert(pushSubscriptions).values(row);
      await expect(db().insert(pushSubscriptions).values(row)).rejects.toThrow();
    });
  });

  describe("pulang-pergi setiap tabel (menjaga kode dan SQL tetap sepaham)", () => {
    test("semua kolom tertulis dan terbaca kembali, dan nilai bawaan terisi", async () => {
      const expiresAt = new Date("2030-01-01T00:00:00Z");
      await db().insert(machines).values({ id: "m1", name: "Laptop", tokenHash: HASH });
      await db().insert(devices).values({ id: "d1", name: "HP", tokenHash: HASH2, publicKey: "kunci-publik" });
      await db().insert(pairings).values({ machineId: "m1", deviceId: "d1" });
      await db().insert(pairingCodes).values({ codeHash: "c".repeat(64), machineId: "m1", expiresAt });
      await db().insert(sessions).values({ machineId: "m1", sessionId: "s1", agent: "claude-code", startedAt: expiresAt, lastEventAt: expiresAt });
      await db().insert(events).values({
        machineId: "m1", id: EVENT_ID, sessionId: "s1", seq: 3, ts: expiresAt, agent: "claude-code", type: "tool.requested", payload: JSON.stringify({ a: [1, 2, { b: null }] }),
      });
      await db().insert(pushSubscriptions).values({ deviceId: "d1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" });

      const [machine] = await db().select().from(machines);
      expect(machine).toMatchObject({ id: "m1", name: "Laptop", tokenHash: HASH, lastSeenAt: null });
      expect(machine?.createdAt).toBeInstanceOf(Date);
      const [device] = await db().select().from(devices);
      expect(device).toMatchObject({ id: "d1", publicKey: "kunci-publik", revokedAt: null });
      const [code] = await db().select().from(pairingCodes);
      expect(code).toMatchObject({ machineId: "m1", usedAt: null });
      expect(code?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
      const [session] = await db().select().from(sessions);
      expect(session).toMatchObject({ status: "active", endedAt: null });
      const [event] = await db().select().from(events);
      expect(event).toMatchObject({ seq: 3, type: "tool.requested", payload: '{"a":[1,2,{"b":null}]}' }); // teks JSON apa adanya
      expect(event?.receivedAt).toBeInstanceOf(Date); // nilai bawaan: jam relay
      const [push] = await db().select().from(pushSubscriptions);
      expect(push?.id).toMatch(/^[0-9a-f-]{36}$/); // UUID dibuat database
    });
  });
});
