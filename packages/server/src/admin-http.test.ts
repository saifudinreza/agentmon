import { createHash } from "node:crypto";
import { MachineRegisterResponseSchema, PairCodeResponseSchema, PairedDevicesResponseSchema, PairRedeemResponseSchema } from "@agentmon/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { MIN_ADMIN_SECRET_LENGTH, parseAdminSecret, type AdminLimits } from "./admin-http";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createMachineRegistry } from "./db/machines";
import { createPairingService } from "./db/pairing";
import { createTestDatabase, query, resetDatabase } from "./db/testing";
import { CLOSE } from "./hub";
import type { Logger } from "./logger";
import { startRelayServer, type RunningRelay } from "./node";
import { sql } from "drizzle-orm";

const SECRET = "rahasia-admin-yang-panjang-0123456789abcdef";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

let handle: DatabaseHandle;
let directory: DbDirectory;
let relay: RunningRelay | undefined;
let logs: string[];
const sockets: WebSocket[] = [];
const clock = { ms: Date.parse("2026-11-14T00:00:00Z") };

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  clock.ms = Date.parse("2026-11-14T00:00:00Z");
  logs = [];
  directory = createDbDirectory(handle.db);
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await relay?.stop();
  relay = undefined;
});

const logger: Logger = { info: (m) => logs.push(`INFO ${m}`), error: (m) => logs.push(`ERROR ${m}`) };

async function start(extra: { admin?: boolean; limits?: Partial<AdminLimits>; trustProxy?: boolean; newToken?: () => string } = {}): Promise<string> {
  relay = await startRelayServer({
    directory,
    port: 0,
    host: "127.0.0.1",
    logger,
    pairing: { pairing: createPairingService(handle.db), directory },
    ...(extra.admin === false
      ? {}
      : {
          admin: {
            secret: SECRET,
            registry: createMachineRegistry(handle.db),
            logger,
            now: () => clock.ms,
            ...(extra.limits ? { limits: extra.limits } : {}),
            ...(extra.trustProxy ? { trustProxy: true } : {}),
            ...(extra.newToken ? { newToken: extra.newToken } : {}),
          },
        }),
  });
  return `http://127.0.0.1:${relay.port}`;
}

const register = (base: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
  fetch(`${base}/admin/machines`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const rows = () => query(handle.db, sql`select id, name, token_hash from machines order by id`);

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

describe("parseAdminSecret", () => {
  test("tidak diisi: loket tertutup tanpa masalah", () => {
    expect(parseAdminSecret({})).toEqual({});
    expect(parseAdminSecret({ ADMIN_SECRET: "" })).toEqual({});
  });
  test("cukup panjang: dipakai (spasi tepi dibuang)", () => {
    expect(parseAdminSecret({ ADMIN_SECRET: SECRET })).toEqual({ secret: SECRET });
    expect(parseAdminSecret({ ADMIN_SECRET: `  ${SECRET}\n` })).toEqual({ secret: SECRET });
  });
  test("terlalu pendek: tidak dipakai, dengan alasan, dan nilainya tidak ikut tertulis", () => {
    const short = "a".repeat(MIN_ADMIN_SECRET_LENGTH - 1);
    const result = parseAdminSecret({ ADMIN_SECRET: short });
    expect(result.secret).toBeUndefined();
    expect(result.problem).toContain("terlalu pendek");
    expect(result.problem).not.toContain(short);
  });
  test("hanya spasi dianggap terlalu pendek (bukan 'diisi')", () => {
    expect(parseAdminSecret({ ADMIN_SECRET: " ".repeat(40) }).secret).toBeUndefined();
  });
});

describe("tanpa ADMIN_SECRET", () => {
  test("loket tidak ada (404), dan tidak ada yang tercatat", async () => {
    const base = await start({ admin: false });
    const res = await register(base, { id: ID, name: "Laptop" });
    expect(res.status).toBe(404);
    expect(await rows()).toEqual([]);
  });
});

describe("POST /admin/machines: pendaftaran berhasil", () => {
  test("201 dengan nomor dan token; token sah untuk laptop itu, dan jawabannya tidak boleh disimpan cache", async () => {
    const base = await start();
    const res = await register(base, { id: ID, name: "Laptop Kantor" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = MachineRegisterResponseSchema.parse(await res.json());
    expect(body.machineId).toBe(ID);
    expect(await directory.authenticate("machine", body.token)).toBe(ID);
    expect(await directory.authenticate("machine", "token-lain-0000000000000000000000000")).toBeUndefined();
  });

  test("hanya HASH token yang disimpan: token mentah dan rahasia admin tidak ada di kolom mana pun", async () => {
    const base = await start();
    const { token } = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "Laptop Kantor" })).json());
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    const everything = JSON.stringify(await query(handle.db, sql`select * from machines`));
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(SECRET);
  });

  test("setiap pendaftaran mendapat token berbeda", async () => {
    const base = await start();
    const a = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "A" })).json());
    const b = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID2, name: "B" })).json());
    expect(a.token).not.toBe(b.token);
  });

  test("nama dipangkas spasinya dan tersimpan", async () => {
    const base = await start();
    await register(base, { id: ID, name: "   Laptop Rumah   " });
    expect((await rows())[0]!.name).toBe("Laptop Rumah");
  });

  test("log memuat nomor laptop saja: tidak pernah token maupun rahasia admin, dan jawaban galat tidak memuat rahasia", async () => {
    const base = await start();
    const ok = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "Laptop" })).json());
    const GUESS = "tebakan-penyerang-QWERTY-9876";
    const wrong = await register(base, { id: ID2, name: "X" }, { authorization: `Bearer ${GUESS}` });
    const wrongBody = await wrong.text();
    expect(logs.some((l) => l.includes(ID))).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain(ok.token);
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(GUESS); // tebakan yang salah pun tidak ikut tercatat
    }
    expect(wrongBody).not.toContain(SECRET);
  });
});

describe("POST /admin/machines: tanpa rahasia admin ditolak", () => {
  test.each([
    ["tanpa header", {}],
    ["rahasia salah", { authorization: "Bearer salah-sekali" }],
    ["rahasia kepotong", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["rahasia ditambah", { authorization: `Bearer ${SECRET}x` }],
    ["skema bukan Bearer", { authorization: `Basic ${SECRET}` }],
    ["tanpa nilai", { authorization: "Bearer " }],
    ["huruf besar kecil berbeda", { authorization: `Bearer ${SECRET.toUpperCase()}` }],
    ["token laptop yang sah bukan rahasia admin", { authorization: `Bearer ${"a".repeat(64)}` }],
  ])("%s: 401 dan tidak ada laptop yang terdaftar", async (_name, headers) => {
    const base = await start();
    const res = await register(base, { id: ID, name: "Laptop" }, headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await rows()).toEqual([]);
  });

  test("isi permintaan yang rusak tidak diperiksa sebelum rahasia: jawabannya tetap 401, bukan 400 (tidak membocorkan apa pun)", async () => {
    const base = await start();
    expect((await register(base, "{rusak", { authorization: "Bearer salah" })).status).toBe(401);
  });
});

describe("POST /admin/machines: pembatasan laju", () => {
  test("rahasia salah berulang dari satu alamat: setelah jatah habis, SEMUA permintaan (juga yang rahasianya benar) ditolak 429", async () => {
    const base = await start();
    for (let i = 0; i < 5; i++) expect((await register(base, { id: ID, name: "X" }, { authorization: `Bearer salah-${i}` })).status).toBe(401);
    const blocked = await register(base, { id: ID, name: "X" }); // rahasia BENAR
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate-limited" });
    expect(await rows()).toEqual([]);
    const stillWrong = await register(base, { id: ID, name: "X" }, { authorization: "Bearer salah" });
    expect(stillWrong.status).toBe(429); // penebak tidak tahu bahwa tebakannya salah atau benar
  });

  test("jatah pulih seiring waktu", async () => {
    const base = await start();
    for (let i = 0; i < 5; i++) await register(base, { id: ID, name: "X" }, { authorization: "Bearer salah" });
    expect((await register(base, { id: ID, name: "X" })).status).toBe(429);
    clock.ms += 90_000; // lebih dari satu menit: satu jatah pulih
    expect((await register(base, { id: ID, name: "X" })).status).toBe(201);
  });

  test("penebak yang berganti-ganti alamat tetap dibatasi secara keseluruhan", async () => {
    const base = await start({ trustProxy: true, limits: { failureBurstGlobal: 6 } });
    for (let i = 0; i < 6; i++) {
      const res = await register(base, { id: ID, name: "X" }, { authorization: "Bearer salah", "x-forwarded-for": `10.0.0.${i}` });
      expect(res.status).toBe(401);
    }
    const fresh = await register(base, { id: ID, name: "X" }, { authorization: `Bearer ${SECRET}`, "x-forwarded-for": "10.9.9.9" });
    expect(fresh.status).toBe(429);
    expect(await rows()).toEqual([]);
  });

  test("pendaftaran yang berhasil juga dibatasi (rahasia bocor tidak bisa membanjiri tabel)", async () => {
    const base = await start({ limits: { successBurst: 2 } });
    expect((await register(base, { id: ID, name: "A" })).status).toBe(201);
    expect((await register(base, { id: ID2, name: "B" })).status).toBe(201);
    expect((await register(base, { id: "11111111-1111-4111-8111-111111111111", name: "C" })).status).toBe(429);
    expect(await rows()).toHaveLength(2);
  });

  test("tanpa trustProxy, X-Forwarded-For palsu tidak mengelabui pembatas per alamat", async () => {
    const base = await start();
    for (let i = 0; i < 5; i++) await register(base, { id: ID, name: "X" }, { authorization: "Bearer salah", "x-forwarded-for": `10.1.1.${i}` });
    const res = await register(base, { id: ID, name: "X" }, { authorization: `Bearer ${SECRET}`, "x-forwarded-for": "10.2.2.2" });
    expect(res.status).toBe(429);
  });
});

describe("POST /admin/machines: isi permintaan", () => {
  test.each([
    ["nomor bukan UUID", { id: "m1", name: "Laptop" }],
    ["tanpa nomor", { name: "Laptop" }],
    ["tanpa nama", { id: ID }],
    ["nama kosong", { id: ID, name: "   " }],
    ["nama terlalu panjang", { id: ID, name: "a".repeat(65) }],
    ["nama memuat karakter kontrol", { id: ID, name: "Lap\u001btop" }],
    ["nama memuat baris baru", { id: ID, name: "Lap\ntop" }],
    ["rotate bukan boolean", { id: ID, name: "Laptop", rotate: "ya" }],
    ["bukan objek", [1, 2]],
    ["teks", '"halo"'],
    ["bukan JSON", "{rusak"],
  ])("%s: 400 dan tidak ada yang tercatat", async (_name, body) => {
    const base = await start();
    const res = await register(base, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-request" });
    expect(await rows()).toEqual([]);
  });

  test("isi terlalu besar: 413", async () => {
    const base = await start();
    expect((await register(base, { id: ID, name: "Laptop", sampah: "x".repeat(5000) })).status).toBe(413);
    expect(await rows()).toEqual([]);
  });

  test("permintaan yang tidak sah tidak menghabiskan jatah pendaftaran yang berhasil", async () => {
    const base = await start({ limits: { successBurst: 1 } });
    for (let i = 0; i < 3; i++) expect((await register(base, { id: "bukan-uuid", name: "X" })).status).toBe(400);
    expect((await register(base, { id: ID, name: "A" })).status).toBe(201);
  });
});

describe("POST /admin/machines: nomor yang sudah terdaftar dan penggantian token", () => {
  test("mendaftar nomor yang sama lagi: 409, laptop yang ada tidak berubah dan tokennya tetap berlaku", async () => {
    const base = await start();
    const first = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "Asli" })).json());
    const again = await register(base, { id: ID, name: "Penyusup" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already-registered" });
    expect((await rows())[0]!.name).toBe("Asli");
    expect(await directory.authenticate("machine", first.token)).toBe(ID);
  });

  test("rotate: token baru berlaku, token lama langsung tidak berlaku, nama diperbarui", async () => {
    const base = await start();
    const first = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "Lama" })).json());
    const res = await register(base, { id: ID, name: "Baru", rotate: true });
    expect(res.status).toBe(201);
    const second = MachineRegisterResponseSchema.parse(await res.json());
    expect(second.token).not.toBe(first.token);
    expect(await directory.authenticate("machine", second.token)).toBe(ID);
    expect(await directory.authenticate("machine", first.token)).toBeUndefined();
    expect((await rows())[0]!.name).toBe("Baru");
    expect(await rows()).toHaveLength(1);
  });

  test("rotate untuk nomor yang belum terdaftar: 404, tidak membuat laptop baru", async () => {
    const base = await start();
    const res = await register(base, { id: ID, name: "Laptop", rotate: true });
    expect(res.status).toBe(404);
    expect(await rows()).toEqual([]);
  });

  test("rotate memutus sambungan lama seketika (token yang mungkin bocor tidak tetap hidup), dan sambungan ulang dengan token lama ditolak", async () => {
    const base = await start();
    const first = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "Laptop" })).json());
    const port = relay!.port;
    const old = connectWs(port, "machine", first.token);
    await vi.waitFor(() => expect(old.frames.some((f) => f.kind === "welcome")).toBe(true));

    const second = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "Laptop", rotate: true })).json());
    await vi.waitFor(() => expect(old.state.closeCode).toBe(CLOSE.unauthorized));

    const retry = connectWs(port, "machine", first.token);
    await vi.waitFor(() => expect(retry.state.closeCode).toBeDefined());
    expect(retry.frames.some((f) => f.kind === "welcome")).toBe(false);

    const fresh = connectWs(port, "machine", second.token);
    await vi.waitFor(() => expect(fresh.frames.some((f) => f.kind === "welcome")).toBe(true));
  });

  test("pendaftaran biasa (tanpa rotate) tidak memutus laptop yang lain", async () => {
    const base = await start();
    const first = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "A" })).json());
    const live = connectWs(relay!.port, "machine", first.token);
    await vi.waitFor(() => expect(live.frames.some((f) => f.kind === "welcome")).toBe(true));
    await register(base, { id: ID2, name: "B" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(live.state.closeCode).toBeUndefined();
  });
});

describe("ujung ke ujung: daftar, hubungkan laptop, pairing HP", () => {
  test("laptop yang baru didaftarkan bisa tersambung, meminta kode pairing, dan HP bisa memasangkan diri", async () => {
    const base = await start();

    // 1. Daftar (satu-satunya langkah yang butuh rahasia admin).
    const { machineId, token } = MachineRegisterResponseSchema.parse(await (await register(base, { id: ID, name: "Laptop Kantor" })).json());

    // 2. Daemon tersambung dengan token itu.
    const daemon = connectWs(relay!.port, "machine", token);
    await vi.waitFor(() => expect(daemon.frames.some((f) => f.kind === "welcome")).toBe(true));

    // 3. Laptop meminta kode pairing; HP menukarnya.
    const code = PairCodeResponseSchema.parse(await (await fetch(`${base}/pair/code`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).code;
    const redeemed = await fetch(`${base}/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "iPhone Budi" }) });
    expect(redeemed.status).toBe(200);
    const device = PairRedeemResponseSchema.parse(await redeemed.json());
    expect(device.machineId).toBe(machineId);
    expect(device.machineName).toBe("Laptop Kantor");

    // 4. Laptop melihat HP itu terpasang, dan HP bisa tersambung ke relay.
    const listed = PairedDevicesResponseSchema.parse(await (await fetch(`${base}/pair/devices`, { headers: { authorization: `Bearer ${token}` } })).json());
    expect(listed.devices.map((d) => d.name)).toEqual(["iPhone Budi"]);
    const phone = connectWs(relay!.port, "device", device.deviceToken as string);
    await vi.waitFor(() => expect(phone.frames.some((f) => f.kind === "welcome")).toBe(true));
  });

  test("tanpa pendaftaran, token buatan sendiri ditolak (laptop yang tidak terdaftar tidak bisa tersambung)", async () => {
    await start();
    const stranger = connectWs(relay!.port, "machine", "token-karangan-sendiri-00000000000000000000");
    await vi.waitFor(() => expect(stranger.state.closeCode).toBeDefined());
    expect(stranger.frames.some((f) => f.kind === "welcome")).toBe(false);
  });
});
