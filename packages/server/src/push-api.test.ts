import { PushConfigResponseSchema } from "@agentmon/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createPairingService } from "./db/pairing";
import { createPushStore, type PushStore } from "./db/push";
import { createStore } from "./db/store";
import { createTestDatabase, resetDatabase } from "./db/testing";
import { startRelayServer, type RunningRelay } from "./node";
import { createEndpointPolicy, generateVapidKeys } from "./push";
import { fakeBrowser } from "./push-testing";

const T = { m1: "machine-token-satu-000000000000000", d1: "device-token-satu-00000000000000000", d2: "device-token-dua-000000000000000000", d3: "device-token-tiga-00000000000000000" };
const ORIGIN = "https://agentmon.contoh.com";
const KEYS = generateVapidKeys();

let handle: DatabaseHandle;
let directory: DbDirectory;
let pushStore: PushStore;
let relay: RunningRelay | undefined;

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  directory = createDbDirectory(handle.db);
  pushStore = createPushStore(handle.db);
  await directory.registerMachine({ id: "m1", name: "Laptop", token: T.m1 });
  await directory.registerDevice({ id: "d1", name: "HP satu", token: T.d1 });
  await directory.registerDevice({ id: "d2", name: "HP dua", token: T.d2 });
  await directory.registerDevice({ id: "d3", name: "HP luar", token: T.d3 });
  await directory.pair("m1", "d1");
  await directory.pair("m1", "d2");
});
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

async function start(options: { vapid?: boolean; push?: boolean } = {}): Promise<string> {
  const pairing = createPairingService(handle.db);
  relay = await startRelayServer({
    directory,
    port: 0,
    host: "127.0.0.1",
    pairing: { pairing, directory },
    deviceApi: {
      directory,
      store: createStore(handle.db),
      devices: pairing,
      allowedOrigins: [ORIGIN],
      ...(options.push === false ? {} : { push: { store: pushStore, isAllowedEndpoint: createEndpointPolicy(), ...(options.vapid === false ? {} : { vapidPublicKey: KEYS.publicKey }) } }),
    },
  });
  return `http://127.0.0.1:${relay.port}`;
}

const request = (base: string, method: string, path: string, token: string | null, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });

describe("GET /api/push/key", () => {
  test("push menyala: memberi kunci publik", async () => {
    const base = await start();
    const res = await request(base, "GET", "/api/push/key", T.d1);
    expect(res.status).toBe(200);
    expect(PushConfigResponseSchema.parse(await res.json())).toEqual({ enabled: true, publicKey: KEYS.publicKey });
  });

  test("push belum dikonfigurasi: enabled false tanpa kunci", async () => {
    const base = await start({ vapid: false });
    expect(PushConfigResponseSchema.parse(await (await request(base, "GET", "/api/push/key", T.d1)).json())).toEqual({ enabled: false });
  });

  test("tanpa token atau token salah: 401, dan kunci tidak bocor", async () => {
    const base = await start();
    for (const token of [null, "token-salah-0000000000000000000000"]) {
      const res = await request(base, "GET", "/api/push/key", token);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(KEYS.publicKey);
    }
  });

  test("tanpa penyimpanan push: /api/push/* tidak ada (404)", async () => {
    const base = await start({ push: false });
    expect((await request(base, "GET", "/api/push/key", T.d1)).status).toBe(404);
  });
});

describe("PUT /api/push/subscription", () => {
  test("langganan sah disimpan atas nama HP pemanggil", async () => {
    const base = await start();
    const { subscription } = fakeBrowser();
    const res = await request(base, "PUT", "/api/push/subscription", T.d1, subscription);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await pushStore.forDevice("d1")).toMatchObject([{ deviceId: "d1", endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }]);
    expect(await pushStore.forDevice("d2")).toEqual([]);
  });

  test("mendaftar lagi menggantikan yang lama: satu HP, satu langganan; HP lain tidak tersentuh", async () => {
    const base = await start();
    const first = fakeBrowser();
    const second = fakeBrowser();
    const other = fakeBrowser();
    await request(base, "PUT", "/api/push/subscription", T.d1, first.subscription);
    await request(base, "PUT", "/api/push/subscription", T.d2, other.subscription);
    await request(base, "PUT", "/api/push/subscription", T.d1, second.subscription);
    expect((await pushStore.forDevice("d1")).map((s) => s.endpoint)).toEqual([second.subscription.endpoint]);
    expect((await pushStore.forDevice("d2")).map((s) => s.endpoint)).toEqual([other.subscription.endpoint]);
    // Mengirim yang sama dua kali tidak menggandakan.
    await request(base, "PUT", "/api/push/subscription", T.d1, second.subscription);
    expect(await pushStore.forDevice("d1")).toHaveLength(1);
  });

  test("alamat yang sama didaftarkan HP lain: dipindahkan, tidak ada dua baris", async () => {
    const base = await start();
    const { subscription } = fakeBrowser();
    await request(base, "PUT", "/api/push/subscription", T.d1, subscription);
    await request(base, "PUT", "/api/push/subscription", T.d2, subscription);
    expect(await pushStore.forDevice("d1")).toEqual([]);
    expect((await pushStore.forDevice("d2")).map((s) => s.endpoint)).toEqual([subscription.endpoint]);
  });

  test("ditolak 400 dan tidak tersimpan: alamat bukan layanan push, kunci rusak, bentuk salah, bukan JSON", async () => {
    const base = await start();
    const { subscription } = fakeBrowser();
    const cases: unknown[] = [
      { ...subscription, endpoint: "https://169.254.169.254/latest" },
      { ...subscription, endpoint: "http://fcm.googleapis.com/fcm/send/x" },
      { ...subscription, keys: { ...subscription.keys, p256dh: "A".repeat(87) } },
      { ...subscription, keys: { ...subscription.keys, auth: "x" } },
      { endpoint: subscription.endpoint },
      [],
      "bukan objek",
      "{rusak",
    ];
    for (const body of cases) {
      const res = await request(base, "PUT", "/api/push/subscription", T.d1, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-subscription" });
    }
    expect(await pushStore.forDevice("d1")).toEqual([]);
  });

  test("isi terlalu besar: 413", async () => {
    const base = await start();
    const { subscription } = fakeBrowser();
    const res = await request(base, "PUT", "/api/push/subscription", T.d1, { ...subscription, kelebihan: "x".repeat(10_000) });
    expect(res.status).toBe(413);
  });

  test("push belum dikonfigurasi di relay: 503, tidak ada yang disimpan", async () => {
    const base = await start({ vapid: false });
    const res = await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push-disabled" });
    expect(await pushStore.forDevice("d1")).toEqual([]);
  });

  test("tanpa token atau token salah: 401 dan tidak ada yang disimpan", async () => {
    const base = await start();
    const { subscription } = fakeBrowser();
    expect((await request(base, "PUT", "/api/push/subscription", null, subscription)).status).toBe(401);
    expect((await request(base, "PUT", "/api/push/subscription", "token-salah-0000000000000000000000", subscription)).status).toBe(401);
    expect(await pushStore.forDevice("d1")).toEqual([]);
  });

  test("HP yang dicabut tidak bisa mendaftar", async () => {
    const base = await start();
    await directory.revokeDevice("d1");
    expect((await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription)).status).toBe(401);
  });

  test("CORS: asal PWA boleh memakai PUT dengan header authorization dan content-type; asal lain tidak", async () => {
    const base = await start();
    const preflight = (origin: string) =>
      fetch(`${base}/api/push/subscription`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type" } });
    const allowed = await preflight(ORIGIN);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(allowed.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(allowed.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
    expect((await preflight("https://penyerang.example")).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("DELETE /api/push/subscription", () => {
  test("menghapus langganan HP ini saja, dan aman diulang", async () => {
    const base = await start();
    await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription);
    await request(base, "PUT", "/api/push/subscription", T.d2, fakeBrowser().subscription);
    expect((await request(base, "DELETE", "/api/push/subscription", T.d1)).status).toBe(200);
    expect(await pushStore.forDevice("d1")).toEqual([]);
    expect(await pushStore.forDevice("d2")).toHaveLength(1);
    expect((await request(base, "DELETE", "/api/push/subscription", T.d1)).status).toBe(200);
  });

  test("tanpa token: 401 dan tidak ada yang terhapus", async () => {
    const base = await start();
    await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription);
    expect((await request(base, "DELETE", "/api/push/subscription", null)).status).toBe(401);
    expect(await pushStore.forDevice("d1")).toHaveLength(1);
  });
});

describe("langganan dan siapa yang dihubungi", () => {
  test("forMachine: hanya HP yang dipasangkan dengan laptop itu dan belum dicabut", async () => {
    const base = await start();
    const s1 = fakeBrowser();
    const s2 = fakeBrowser();
    const s3 = fakeBrowser();
    await request(base, "PUT", "/api/push/subscription", T.d1, s1.subscription);
    await request(base, "PUT", "/api/push/subscription", T.d2, s2.subscription);
    await request(base, "PUT", "/api/push/subscription", T.d3, s3.subscription); // d3 tidak dipasangkan dengan m1
    const endpoints = async () => (await pushStore.forMachine("m1")).map((s) => s.endpoint).sort();
    expect(await endpoints()).toEqual([s1.subscription.endpoint, s2.subscription.endpoint].sort());
    await directory.unpair("m1", "d2");
    expect(await endpoints()).toEqual([s1.subscription.endpoint]);
  });

  test("mencabut HP lewat API menghapus langganannya; yang lain tetap", async () => {
    const base = await start();
    await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription);
    await request(base, "PUT", "/api/push/subscription", T.d2, fakeBrowser().subscription);
    expect((await request(base, "DELETE", "/api/devices/d2", T.d1)).status).toBe(200);
    expect(await pushStore.forDevice("d2")).toEqual([]);
    expect(await pushStore.forDevice("d1")).toHaveLength(1);
  });

  test("mencabut lewat direktori (jalur lain) juga menghapus langganannya", async () => {
    const base = await start();
    await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription);
    await directory.revokeDevice("d1");
    expect(await pushStore.forDevice("d1")).toEqual([]);
  });

  test("langganan HP yang dicabut tidak dihubungi walau barisnya masih ada (cadangan bila penghapusan gagal)", async () => {
    const base = await start();
    await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription);
    // Mensimulasikan baris yang tertinggal: tandai dicabut tanpa menghapus langganannya.
    const { devices } = await import("./db/schema");
    const { eq } = await import("drizzle-orm");
    await handle.db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, "d1"));
    expect(await pushStore.forDevice("d1")).toHaveLength(1);
    expect(await pushStore.forMachine("m1")).toEqual([]);
  });

  test("removeByIds menghapus baris yang disebut saja", async () => {
    const base = await start();
    await request(base, "PUT", "/api/push/subscription", T.d1, fakeBrowser().subscription);
    await request(base, "PUT", "/api/push/subscription", T.d2, fakeBrowser().subscription);
    const [first] = await pushStore.forDevice("d1");
    await pushStore.removeByIds([first!.id]);
    expect(await pushStore.forDevice("d1")).toEqual([]);
    expect(await pushStore.forDevice("d2")).toHaveLength(1);
    await pushStore.removeByIds([]); // tidak melempar
  });
});
