import { PairCodeResponseSchema, PairedDevicesResponseSchema, PairRedeemResponseSchema } from "@agentmon/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createPairingService } from "./db/pairing";
import { createTestDatabase, query, resetDatabase } from "./db/testing";
import { startRelayServer, type RunningRelay } from "./node";
import type { PairingLimits } from "./pairing-http";

const MACHINE = "machine-token-0000000000000000";
const PWA = "https://app.contoh.com";

let handle: DatabaseHandle;
let directory: DbDirectory;
let relay: RunningRelay | undefined;
const clock = { ms: Date.parse("2026-11-11T00:00:00Z") };

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000); // memulai PGlite + migrasi bisa lambat saat banyak berkas test berjalan bersamaan
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  clock.ms = Date.parse("2026-11-11T00:00:00Z");
  directory = createDbDirectory(handle.db, { now: () => new Date(clock.ms) });
  await directory.registerMachine({ id: "m1", name: "Laptop Kantor", token: MACHINE });
});
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

async function start(extra: { limits?: Partial<PairingLimits>; allowedOrigins?: string[]; trustProxy?: boolean } = {}): Promise<string> {
  const now = () => new Date(clock.ms);
  relay = await startRelayServer({
    directory,
    port: 0,
    host: "127.0.0.1",
    pairing: {
      pairing: createPairingService(handle.db, { now }),
      directory,
      now: () => clock.ms,
      ...extra,
    },
  });
  return `http://127.0.0.1:${relay.port}`;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const asMachine = { authorization: `Bearer ${MACHINE}` };

async function newCode(base: string): Promise<string> {
  const res = await fetch(`${base}/pair/code`, { method: "POST", headers: asMachine });
  return PairCodeResponseSchema.parse(await res.json()).code;
}

describe("POST /pair/code", () => {
  test("laptop dengan token sah mendapat kode (201) dengan bentuk yang benar", async () => {
    const base = await start();
    const res = await fetch(`${base}/pair/code`, { method: "POST", headers: asMachine });
    expect(res.status).toBe(201);
    const body = PairCodeResponseSchema.parse(await res.json());
    expect(new Date(body.expiresAt).getTime()).toBe(clock.ms + 5 * 60_000);
  });

  test.each([
    ["tanpa token", {}],
    ["token salah", { authorization: "Bearer token-salah-0000000000000000" }],
    ["bukan Bearer", { authorization: `Basic ${MACHINE}` }],
    ["token milik HP, bukan laptop", { authorization: "Bearer device-token-00000000000000000" }],
  ])("ditolak 401: %s", async (_name, headers) => {
    const base = await start();
    const res = await fetch(`${base}/pair/code`, { method: "POST", headers });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(Number((await query(handle.db, sql`select count(*)::int as n from pairing_codes`))[0]?.n)).toBe(0);
  });

  test("kode ke-6 yang masih aktif ditolak 429", async () => {
    const base = await start({ limits: { codeBurstPerMachine: 100 } });
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/pair/code`, { method: "POST", headers: asMachine })).status).toBe(201);
    const res = await fetch(`${base}/pair/code`, { method: "POST", headers: asMachine });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too-many-codes" });
  });

  test("permintaan kode dibatasi lajunya per laptop", async () => {
    const base = await start({ limits: { codeBurstPerMachine: 2, codeRefillPerSecondPerMachine: 0 } });
    expect((await fetch(`${base}/pair/code`, { method: "POST", headers: asMachine })).status).toBe(201);
    expect((await fetch(`${base}/pair/code`, { method: "POST", headers: asMachine })).status).toBe(201);
    const res = await fetch(`${base}/pair/code`, { method: "POST", headers: asMachine });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate-limited" });
  });
});

describe("POST /pair/redeem", () => {
  test("menukar kode: HP mendapat kredensial yang langsung bisa dipakai", async () => {
    const base = await start();
    const code = await newCode(base);
    const res = await post(`${base}/pair/redeem`, { code, name: "iPhone Budi" });
    expect(res.status).toBe(200);
    const body = PairRedeemResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ machineId: "m1", machineName: "Laptop Kantor" });
    expect(await directory.authenticate("device", body.deviceToken as string)).toBe(body.deviceId);
    expect(await directory.isPaired("m1", body.deviceId)).toBe(true);
  });

  test("kode terpakai, kedaluwarsa, dan tak dikenal: jawabannya SAMA (400 invalid-code)", async () => {
    const base = await start();
    const used = await newCode(base);
    await post(`${base}/pair/redeem`, { code: used, name: "HP" });
    const expired = await newCode(base);
    clock.ms += 6 * 60_000;

    const answers = await Promise.all(
      [used, expired, "x".repeat(32)].map(async (code) => {
        const res = await post(`${base}/pair/redeem`, { code, name: "HP" });
        return { status: res.status, body: await res.json() };
      }),
    );
    for (const answer of answers) expect(answer).toEqual({ status: 400, body: { error: "invalid-code" } });
  });

  test.each([
    ["tanpa isi", undefined],
    ["bukan JSON", "{bukan json"],
    ["tanpa nama", { code: "a".repeat(32) }],
    ["nama kosong", { code: "a".repeat(32), name: "  " }],
    ["kode terlalu pendek", { code: "pendek", name: "HP" }],
    ["nama berisi escape ANSI", { code: "a".repeat(32), name: "HP\u001b[2J" }],
    ["nama berisi baris baru", { code: "a".repeat(32), name: "HP\nresmi" }],
    ["kode berisi karakter berbahaya", { code: "a'; drop table devices;--aaaaaaaa", name: "HP" }],
  ])("masukan tidak sah ditolak 400: %s", async (_name, body) => {
    const base = await start();
    const res = await fetch(`${base}/pair/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-request" });
  });

  test("isi permintaan lebih dari 4 KiB ditolak 413", async () => {
    const base = await start();
    const res = await post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "x".repeat(5000) });
    expect(res.status).toBe(413);
  });

  test("HP yang sudah punya kredensial memasangkan laptop kedua dengan token lamanya", async () => {
    await directory.registerMachine({ id: "m2", name: "Laptop Rumah", token: "machine-token-1111111111111111" });
    const base = await start();
    const first = PairRedeemResponseSchema.parse(await (await post(`${base}/pair/redeem`, { code: await newCode(base), name: "HP" })).json());

    const code2 = PairCodeResponseSchema.parse(
      await (await fetch(`${base}/pair/code`, { method: "POST", headers: { authorization: "Bearer machine-token-1111111111111111" } })).json(),
    ).code;
    const res = await post(`${base}/pair/redeem`, { code: code2, name: "HP" }, { authorization: `Bearer ${first.deviceToken}` });
    const second = PairRedeemResponseSchema.parse(await res.json());
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.deviceToken).toBeUndefined();
    expect(await directory.devicesOf("m2")).toEqual([first.deviceId]);
  });

  test("token HP yang salah: 401 dan kodenya tetap utuh", async () => {
    const base = await start();
    const code = await newCode(base);
    const bad = await post(`${base}/pair/redeem`, { code, name: "HP" }, { authorization: "Bearer token-salah-0000000000000000" });
    expect(bad.status).toBe(401);
    expect((await post(`${base}/pair/redeem`, { code, name: "HP" })).status).toBe(200);
  });

  test("dua HP menukar kode yang sama bersamaan: tepat satu yang lolos", async () => {
    const base = await start({ limits: { redeemBurstPerIp: 100, redeemBurstGlobal: 100 } });
    const code = await newCode(base);
    const statuses = await Promise.all(Array.from({ length: 6 }, (_, i) => post(`${base}/pair/redeem`, { code, name: `HP ${i}` }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 400)).toHaveLength(5);
  });
});

describe("pembatasan percobaan penukaran", () => {
  test("setelah lonjakan awal, percobaan dari satu IP ditolak 429 (termasuk menebak kode)", async () => {
    const base = await start({ limits: { redeemBurstPerIp: 3, redeemRefillPerSecondPerIp: 0 } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(`${String(i).repeat(32)}`);
    const statuses = [];
    for (const code of codes) statuses.push((await post(`${base}/pair/redeem`, { code, name: "HP" })).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
  });

  test("kode yang SAH pun ditolak saat penelepon sudah melewati batas (tidak ada jalan pintas)", async () => {
    const base = await start({ limits: { redeemBurstPerIp: 1, redeemRefillPerSecondPerIp: 0 } });
    const code = await newCode(base);
    await post(`${base}/pair/redeem`, { code: "z".repeat(32), name: "HP" }); // menghabiskan jatah
    expect((await post(`${base}/pair/redeem`, { code, name: "HP" })).status).toBe(429);
    expect(Number((await query(handle.db, sql`select count(*)::int as n from devices`))[0]?.n)).toBe(0);
  });

  test("jatah terisi lagi seiring waktu", async () => {
    const base = await start({ limits: { redeemBurstPerIp: 1, redeemRefillPerSecondPerIp: 1 } });
    expect((await post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" })).status).toBe(400);
    expect((await post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" })).status).toBe(429);
    clock.ms += 1500;
    expect((await post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" })).status).toBe(400);
  });

  test("ada juga batas keseluruhan untuk semua IP digabung", async () => {
    const base = await start({ limits: { redeemBurstPerIp: 100, redeemBurstGlobal: 2, redeemRefillPerSecondGlobal: 0 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" })).status);
    expect(statuses).toEqual([400, 400, 429]);
  });

  test("tanpa trustProxy, header X-Forwarded-For palsu TIDAK bisa menghindari batas per IP", async () => {
    const base = await start({ limits: { redeemBurstPerIp: 1, redeemRefillPerSecondPerIp: 0 } });
    const attempt = (ip: string) => post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" }, { "x-forwarded-for": ip }).then((r) => r.status);
    expect(await attempt("1.1.1.1")).toBe(400);
    expect(await attempt("2.2.2.2")).toBe(429);
  });

  test("dengan trustProxy, IP dibedakan lewat entri paling kanan; entri kiri yang dipalsukan tidak berpengaruh", async () => {
    const base = await start({ trustProxy: true, limits: { redeemBurstPerIp: 1, redeemRefillPerSecondPerIp: 0 } });
    const attempt = (header: string) => post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" }, { "x-forwarded-for": header }).then((r) => r.status);
    expect(await attempt("palsu-1, 9.9.9.9")).toBe(400);
    expect(await attempt("palsu-2, 9.9.9.9")).toBe(429); // IP sebenarnya sama
    expect(await attempt("palsu-1, 8.8.8.8")).toBe(400); // IP lain punya jatah sendiri
  });
});

describe("GET /pair/devices", () => {
  test("laptop melihat HP yang terpasang; token salah ditolak", async () => {
    const base = await start();
    expect(PairedDevicesResponseSchema.parse(await (await fetch(`${base}/pair/devices`, { headers: asMachine })).json()).devices).toEqual([]);

    await post(`${base}/pair/redeem`, { code: await newCode(base), name: "iPhone Budi" });
    const body = PairedDevicesResponseSchema.parse(await (await fetch(`${base}/pair/devices`, { headers: asMachine })).json());
    expect(body.devices.map((d) => d.name)).toEqual(["iPhone Budi"]);

    expect((await fetch(`${base}/pair/devices`)).status).toBe(401);
    expect((await fetch(`${base}/pair/devices`, { headers: { authorization: "Bearer salah-salah-salah-salah" } })).status).toBe(401);
  });

  test("laptop hanya melihat HP-nya sendiri", async () => {
    await directory.registerMachine({ id: "m2", name: "Lain", token: "machine-token-1111111111111111" });
    const base = await start();
    await post(`${base}/pair/redeem`, { code: await newCode(base), name: "HP milik m1" });
    const other = await fetch(`${base}/pair/devices`, { headers: { authorization: "Bearer machine-token-1111111111111111" } });
    expect(PairedDevicesResponseSchema.parse(await other.json()).devices).toEqual([]);
  });
});

describe("CORS dan keadaan lain", () => {
  test("asal PWA yang diizinkan boleh memanggil dari browser (preflight dan permintaan)", async () => {
    const base = await start({ allowedOrigins: [PWA] });
    const pre = await fetch(`${base}/pair/redeem`, {
      method: "OPTIONS",
      headers: { origin: PWA, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBe(PWA);

    const res = await post(`${base}/pair/redeem`, { code: await newCode(base), name: "HP" }, { origin: PWA });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PWA);
  });

  test("asal lain tidak mendapat izin CORS", async () => {
    const base = await start({ allowedOrigins: [PWA] });
    const res = await post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" }, { origin: "https://jahat.example" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("tanpa daftar asal, tidak ada yang diizinkan", async () => {
    const base = await start();
    const res = await post(`${base}/pair/redeem`, { code: "a".repeat(32), name: "HP" }, { origin: PWA });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("endpoint pairing tidak ada bila pairing tidak dinyalakan", async () => {
    relay = await startRelayServer({ directory, port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${relay.port}/pair/code`, { method: "POST", headers: asMachine });
    expect(res.status).toBe(404);
  });

  test("galat tak terduga (database bermasalah) = 500 polos, tanpa rincian dan tanpa kredensial", async () => {
    const base = await start();
    const code = await newCode(base);
    await handle.db.execute(sql`create function rusak() returns trigger language plpgsql as $$ begin raise exception 'rahasia-internal'; end $$`);
    await handle.db.execute(sql`create trigger rusak before insert on devices for each row execute function rusak()`);
    try {
      const res = await post(`${base}/pair/redeem`, { code, name: "HP" });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("rahasia-internal");
      expect(JSON.parse(text)).toEqual({ error: "internal" });
    } finally {
      await handle.db.execute(sql`drop trigger rusak on devices`);
      await handle.db.execute(sql`drop function rusak()`);
    }
    // Transaksi dibatalkan: kodenya TIDAK hangus, jadi bisa dicoba lagi.
    expect((await post(`${base}/pair/redeem`, { code, name: "HP" })).status).toBe(200);
  });
});
