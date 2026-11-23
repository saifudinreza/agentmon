// FILE INI: TEST jalur relay untuk pairing E2E (issue #033 bagian B).
// Relay hanya MENYIMPAN dan MENERUSKAN: bahan pairing dari HP (kunci publik dan bukti) ke laptop, dan pesan bertanda tangan dari laptop ke HP
// (kotak surat). Yang dijaga: hanya pihak yang berhak yang bisa menitipkan dan membaca, tidak ada kebocoran antar-laptop atau antar-HP,
// kotak surat berbatas, dan semuanya terhapus bersama pemiliknya.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DatabaseHandle } from "./db/connect";
import { createDbDirectory, type DbDirectory } from "./db/directory";
import { createPairingService, MAX_E2E_MESSAGES_PER_DEVICE, type PairingService } from "./db/pairing";
import { createStore } from "./db/store";
import { createTestDatabase, query, resetDatabase } from "./db/testing";
import { startRelayServer, type RunningRelay } from "./node";

const T = { m1: "machine-token-satu-000000000000000", m2: "machine-token-dua-0000000000000000", d1: "device-token-satu-00000000000000000", d2: "device-token-dua-000000000000000000" };
const MATERIAL = { kx: "K".repeat(43), sign: "S".repeat(43), proof: "P".repeat(43) };
const ORIGIN = "https://app.contoh.com";

let handle: DatabaseHandle;
let directory: DbDirectory;
let pairing: PairingService;
let relay: RunningRelay | undefined;

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);
afterAll(async () => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  directory = createDbDirectory(handle.db);
  pairing = createPairingService(handle.db);
  await directory.registerMachine({ id: "m1", name: "Laptop Satu", token: T.m1 });
  await directory.registerMachine({ id: "m2", name: "Laptop Dua", token: T.m2 });
});
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

async function start(): Promise<string> {
  relay = await startRelayServer({
    directory,
    port: 0,
    host: "127.0.0.1",
    pairing: { pairing, directory, allowedOrigins: [ORIGIN] },
    deviceApi: { directory, store: createStore(handle.db), devices: pairing, allowedOrigins: [ORIGIN] },
  });
  return `http://127.0.0.1:${relay.port}`;
}

const json = (base: string, method: string, path: string, token: string | null, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
const count = async (table: string) => Number((await query(handle.db, sql.raw(`select count(*)::int as n from ${table}`)))[0]?.n);

/** HP menukar kode laptop `m` dengan bahan E2E; mengembalikan nomor HP dan token. */
async function redeem(base: string, token: string, e2e: unknown, name = "iPhone Dono", existingToken?: string) {
  const code = await pairing.createCode(token === T.m1 ? "m1" : "m2");
  if (!code.ok) throw new Error("kode gagal");
  const res = await json(base, "POST", "/pair/redeem", existingToken ?? null, { code: code.code, name, ...(e2e !== undefined ? { e2e } : {}) });
  return { status: res.status, body: (await res.json()) as { deviceId: string; deviceToken?: string } };
}

describe("bahan pairing E2E dari HP", () => {
  test("disimpan saat penukaran kode dan DITERUSKAN ke laptop lewat /pair/devices (HP lama tanpa bahan: tidak ada kolom e2e)", async () => {
    const base = await start();
    const withE2e = await redeem(base, T.m1, MATERIAL);
    const legacy = await redeem(base, T.m1, undefined, "HP lama");
    expect(withE2e.status).toBe(200);
    const list = (await (await json(base, "GET", "/pair/devices", T.m1)).json()) as { devices: Array<{ id: string; name: string; e2e?: unknown }> };
    expect(list.devices.find((d) => d.id === withE2e.body.deviceId)?.e2e).toEqual(MATERIAL);
    expect(list.devices.find((d) => d.id === legacy.body.deviceId)).not.toHaveProperty("e2e");
  });

  test("bentuk yang salah ditolak (400) dan kode TIDAK hangus", async () => {
    const base = await start();
    const code = await pairing.createCode("m1");
    if (!code.ok) throw new Error("kode gagal");
    for (const bad of [{ ...MATERIAL, kx: "bukan base64!" }, { ...MATERIAL, extra: 1 }, { kx: MATERIAL.kx }, { ...MATERIAL, proof: "P".repeat(200) }, "x"]) {
      const res = await json(base, "POST", "/pair/redeem", null, { code: code.code, name: "HP", e2e: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await json(base, "POST", "/pair/redeem", null, { code: code.code, name: "HP" })).status).toBe(200); // kode masih berlaku
  });

  test("memasangkan HP yang sama ke laptop kedua: tiap laptop punya bahannya sendiri; memasangkan ulang menimpa", async () => {
    const base = await start();
    const first = await redeem(base, T.m1, MATERIAL);
    const second = await redeem(base, T.m2, { ...MATERIAL, kx: "Z".repeat(43) }, "iPhone Dono", first.body.deviceToken);
    expect(second.body.deviceId).toBe(first.body.deviceId);
    const forM1 = (await (await json(base, "GET", "/pair/devices", T.m1)).json()) as { devices: Array<{ e2e?: { kx: string } }> };
    const forM2 = (await (await json(base, "GET", "/pair/devices", T.m2)).json()) as { devices: Array<{ e2e?: { kx: string } }> };
    expect(forM1.devices[0]?.e2e?.kx).toBe(MATERIAL.kx);
    expect(forM2.devices[0]?.e2e?.kx).toBe("Z".repeat(43));
    // pasang ulang ke laptop pertama dengan kunci baru
    await redeem(base, T.m1, { ...MATERIAL, kx: "Y".repeat(43) }, "iPhone Dono", first.body.deviceToken);
    const again = (await (await json(base, "GET", "/pair/devices", T.m1)).json()) as { devices: Array<{ e2e?: { kx: string } }> };
    expect(again.devices[0]?.e2e?.kx).toBe("Y".repeat(43));
    expect(await count("device_e2e")).toBe(2);
  });
});

describe("kotak surat laptop ke HP", () => {
  async function paired(base: string) {
    const a = await redeem(base, T.m1, MATERIAL);
    return { deviceId: a.body.deviceId, deviceToken: a.body.deviceToken! };
  }
  const post = (base: string, token: string | null, deviceId: string, kind = "challenge", body: unknown = { r: "R".repeat(22), sig: "G".repeat(86) }) => json(base, "POST", "/pair/e2e/messages", token, { deviceId, kind, body });
  const read = async (base: string, token: string | null, machineId = "m1", after = 0) => {
    const res = await json(base, "GET", `/api/e2e/messages?machineId=${machineId}&after=${after}`, token);
    return { status: res.status, body: (await res.json()) as { messages?: Array<{ id: number; kind: string; body: Record<string, unknown> }> } };
  };

  test("laptop menitipkan, HP-nya membaca persis isinya berurutan; `after` menyaring yang sudah dilihat", async () => {
    const base = await start();
    const { deviceId, deviceToken } = await paired(base);
    expect((await post(base, T.m1, deviceId, "challenge", { r: "A".repeat(22), sig: "B".repeat(86) })).status).toBe(201);
    expect((await post(base, T.m1, deviceId, "keys", { kid: 2, wrapped: { n: "N".repeat(32), c: "C".repeat(64) }, sig: "S".repeat(86) })).status).toBe(201);
    const all = await read(base, deviceToken);
    expect(all.status).toBe(200);
    expect(all.body.messages?.map((m) => m.kind)).toEqual(["challenge", "keys"]);
    expect(all.body.messages?.[0]?.body).toEqual({ r: "A".repeat(22), sig: "B".repeat(86) });
    const lastId = all.body.messages![0]!.id;
    expect((await read(base, deviceToken, "m1", lastId)).body.messages?.map((m) => m.kind)).toEqual(["keys"]);
  });

  test("hanya pemegang token LAPTOP yang bisa menitipkan: tanpa token, token HP, atau token salah = 401", async () => {
    const base = await start();
    const { deviceId, deviceToken } = await paired(base);
    expect((await post(base, null, deviceId)).status).toBe(401);
    expect((await post(base, deviceToken, deviceId)).status).toBe(401);
    expect((await post(base, "salah-salah-salah-salah-salah", deviceId)).status).toBe(401);
    expect(await count("e2e_messages")).toBe(0);
  });

  test("HP yang bukan milik laptop ini, tidak ada, atau sudah dicabut: 404 yang sama dan tidak ada yang tersimpan", async () => {
    const base = await start();
    const { deviceId } = await paired(base);
    expect((await post(base, T.m2, deviceId)).status).toBe(404); // laptop lain
    expect((await post(base, T.m1, "tidak-ada")).status).toBe(404);
    expect(await pairing.revokeDevice({ machineId: "m1" }, deviceId)).toBe(true);
    expect((await post(base, T.m1, deviceId)).status).toBe(404);
    expect(await count("e2e_messages")).toBe(0);
  });

  test("bentuk salah: jenis asing, bidang asing, isi bukan objek, JSON rusak = 400; terlalu besar = 413", async () => {
    const base = await start();
    const { deviceId } = await paired(base);
    expect((await post(base, T.m1, deviceId, "rahasia")).status).toBe(400);
    expect((await post(base, T.m1, deviceId, "challenge", "teks")).status).toBe(400);
    expect((await post(base, T.m1, deviceId, "challenge", [1, 2])).status).toBe(400);
    expect((await json(base, "POST", "/pair/e2e/messages", T.m1, { deviceId, kind: "challenge", body: {}, lebih: 1 })).status).toBe(400);
    expect((await json(base, "POST", "/pair/e2e/messages", T.m1, "{rusak")).status).toBe(400);
    expect((await post(base, T.m1, deviceId, "challenge", { besar: "x".repeat(20_000) })).status).toBe(413);
    expect(await count("e2e_messages")).toBe(0);
  });

  test("HP lain, atau HP yang tidak dipasangkan dengan laptop itu, TIDAK melihat pesan; tanpa token 401", async () => {
    const base = await start();
    const { deviceId, deviceToken } = await paired(base);
    const other = await redeem(base, T.m1, MATERIAL, "HP kedua");
    await post(base, T.m1, deviceId);
    expect((await read(base, other.body.deviceToken!)).body.messages).toEqual([]); // HP kedua milik laptop yang sama, tetapi bukan penerima
    expect((await read(base, deviceToken, "m2")).body.messages).toEqual([]); // laptop yang tidak memasangkannya
    expect((await read(base, null)).status).toBe(401);
    expect((await read(base, T.m1)).status).toBe(401); // token laptop bukan token HP
    expect((await read(base, deviceToken)).body.messages).toHaveLength(1);
  });

  test("permintaan baca yang salah bentuk: machineId kosong atau after bukan angka = 400", async () => {
    const base = await start();
    const { deviceToken } = await paired(base);
    expect((await json(base, "GET", "/api/e2e/messages?after=0", deviceToken)).status).toBe(400);
    expect((await json(base, "GET", "/api/e2e/messages?machineId=m1&after=-1", deviceToken)).status).toBe(400);
    expect((await json(base, "GET", "/api/e2e/messages?machineId=m1&after=abc", deviceToken)).status).toBe(400);
  });

  test("kotak surat berbatas: lewat batas per HP, yang LAMA dibuang dan pesan baru tetap diterima (pairing tidak pernah gagal karena penuh)", async () => {
    const base = await start();
    const { deviceId } = await paired(base);
    for (let i = 0; i < MAX_E2E_MESSAGES_PER_DEVICE + 5; i++) expect(await pairing.postE2eMessage("m1", deviceId, "keys", JSON.stringify({ i }))).toBe(true);
    expect(await count("e2e_messages")).toBe(MAX_E2E_MESSAGES_PER_DEVICE);
    const rows = await query(handle.db, sql.raw("select body from e2e_messages order by id asc limit 1"));
    expect(JSON.parse(String(rows[0]?.body))).toEqual({ i: 5 }); // lima yang tertua sudah dibuang
  });

  test("HP dicabut: pesan lamanya tetap tidak bisa dibaca lewat token barunya yang tidak ada; menghapus laptop menghapus bahan dan pesan", async () => {
    const base = await start();
    const { deviceId, deviceToken } = await paired(base);
    await post(base, T.m1, deviceId);
    expect(await count("device_e2e")).toBe(1);
    expect(await pairing.revokeDevice({ machineId: "m1" }, deviceId)).toBe(true);
    expect((await read(base, deviceToken)).status).toBe(401); // token HP yang dicabut ditolak
    expect(await pairing.forgetMachine("m1")).toBe(true);
    expect(await count("device_e2e")).toBe(0);
    expect(await count("e2e_messages")).toBe(0);
  });
});

describe("orkestrasi pairing (temuan tinjauan PR #97)", () => {
  const list = async (base: string, token: string) => ((await (await json(base, "GET", "/pair/devices", token)).json()) as { devices: Array<{ id: string; name: string; codeHash?: string; e2e?: { kx: string } }> }).devices;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  test("melepas pasangan HP di SATU laptop (?scope=pairing) TIDAK mencabutnya di laptop lain; di laptop itu pairing dan bahan E2E hilang", async () => {
    const base = await start();
    const first = await redeem(base, T.m1, MATERIAL);
    await redeem(base, T.m2, { ...MATERIAL, kx: "Z".repeat(43) }, "iPhone Dono", first.body.deviceToken);
    expect((await json(base, "DELETE", `/pair/devices/${first.body.deviceId}?scope=pairing`, T.m2)).status).toBe(200);
    expect(await list(base, T.m2)).toEqual([]);
    expect((await list(base, T.m1)).map((d) => d.id)).toEqual([first.body.deviceId]); // laptop pertama utuh
    expect((await json(base, "GET", "/api/e2e/messages?machineId=m1", first.body.deviceToken!)).status).toBe(200); // token HP masih berlaku
    expect(await count("device_e2e")).toBe(1);
  });

  test("melepas pasangan terakhir sebuah HP mencabut perangkatnya sekalian (token tidak berguna); tanpa scope tetap mencabut di semua laptop", async () => {
    const base = await start();
    const solo = await redeem(base, T.m1, MATERIAL);
    expect((await json(base, "DELETE", `/pair/devices/${solo.body.deviceId}?scope=pairing`, T.m1)).status).toBe(200);
    expect((await json(base, "GET", "/api/e2e/messages?machineId=m1", solo.body.deviceToken!)).status).toBe(401);
    const shared = await redeem(base, T.m1, MATERIAL, "HP bersama");
    await redeem(base, T.m2, MATERIAL, "HP bersama", shared.body.deviceToken);
    expect((await json(base, "DELETE", `/pair/devices/${shared.body.deviceId}`, T.m2)).status).toBe(200); // pencabutan eksplisit
    expect(await list(base, T.m1)).toEqual([]);
    expect(await count("device_e2e")).toBe(0);
    expect(await count("e2e_messages")).toBe(0);
  });

  test("?scope=pairing: HP yang bukan milik laptop ini, 404; tanpa token, 401; pasangan yang sama dua kali, 404", async () => {
    const base = await start();
    const a = await redeem(base, T.m1, MATERIAL);
    expect((await json(base, "DELETE", `/pair/devices/${a.body.deviceId}?scope=pairing`, T.m2)).status).toBe(404);
    expect((await json(base, "DELETE", `/pair/devices/${a.body.deviceId}?scope=pairing`, null)).status).toBe(401);
    expect((await json(base, "DELETE", `/pair/devices/${a.body.deviceId}?scope=pairing`, T.m1)).status).toBe(200);
    expect((await json(base, "DELETE", `/pair/devices/${a.body.deviceId}?scope=pairing`, T.m1)).status).toBe(404);
  });

  test("HP yang sama memasangkan laptop kedua dengan NAMA BARU: laptop melihat nama yang dipakai untuk buktinya", async () => {
    const base = await start();
    const first = await redeem(base, T.m1, MATERIAL, "iPhone Dono");
    await redeem(base, T.m2, MATERIAL, "iPhone 16 Dono", first.body.deviceToken);
    expect((await list(base, T.m2))[0]?.name).toBe("iPhone 16 Dono");
    expect((await list(base, T.m1))[0]?.name).toBe("iPhone Dono");
  });

  test("nama yang tidak baku dengan bahan E2E ditolak (400) SEBELUM kode hangus; tanpa bahan E2E nama biasa tetap diterima", async () => {
    const base = await start();
    const code = await pairing.createCode("m1");
    if (!code.ok) throw new Error("kode gagal");
    for (const name of ["iPhone Dono\u200b", "Cafe\u0301"]) {
      expect((await json(base, "POST", "/pair/redeem", null, { code: code.code, name, e2e: MATERIAL })).status, name).toBe(400);
    }
    expect((await json(base, "POST", "/pair/redeem", null, { code: code.code, name: "iPhone Dono\u200b" })).status).toBe(200); // pairing lama: tidak berubah
  });

  test("daftar HP memuat hash kode yang dipakai: HP dari kode lain terbedakan, dan memasangkan ulang menggantinya", async () => {
    const base = await start();
    const codeA = await pairing.createCode("m1");
    const codeB = await pairing.createCode("m1");
    if (!codeA.ok || !codeB.ok) throw new Error("kode gagal");
    const a = (await (await json(base, "POST", "/pair/redeem", null, { code: codeA.code, name: "HP A", e2e: MATERIAL })).json()) as { deviceId: string; deviceToken: string };
    expect((await list(base, T.m1))[0]?.codeHash).toBe(sha(codeA.code));
    await json(base, "POST", "/pair/redeem", a.deviceToken, { code: codeB.code, name: "HP A", e2e: MATERIAL });
    expect((await list(base, T.m1))[0]?.codeHash).toBe(sha(codeB.code));
  });

  test("memasangkan ulang membersihkan pesan lama; memasangkan ulang TANPA bahan E2E menghapus bahan lama", async () => {
    const base = await start();
    const a = await redeem(base, T.m1, MATERIAL);
    await pairing.postE2eMessage("m1", a.body.deviceId, "challenge", JSON.stringify({ r: "x" }));
    await redeem(base, T.m1, MATERIAL, "iPhone Dono", a.body.deviceToken);
    expect(await count("e2e_messages")).toBe(0);
    await redeem(base, T.m1, undefined, "iPhone Dono", a.body.deviceToken);
    expect(await count("device_e2e")).toBe(0);
    expect((await list(base, T.m1))[0]).not.toHaveProperty("e2e");
  });

  test("mencabut HP (global) membersihkan bahan E2E dan semua pesannya", async () => {
    const base = await start();
    const a = await redeem(base, T.m1, MATERIAL);
    await pairing.postE2eMessage("m1", a.body.deviceId, "keys", "{}");
    expect(await pairing.revokeDevice({ machineId: "m1" }, a.body.deviceId)).toBe(true);
    expect(await count("device_e2e")).toBe(0);
    expect(await count("e2e_messages")).toBe(0);
  });
});
