import type { PairingLink } from "@agentmon/shared";
import { describe, expect, test, vi } from "vitest";
import { isSecureRelayUrl, redeemPairing, type RedeemDeps } from "./redeem";
import { loadPairings, PAIRINGS_STORAGE_KEY, savePairing } from "./storage";

const CODE = "abcDEF0123456789_-abcDEF0123456789";
const TOKEN = "d".repeat(64);
const OLD_TOKEN = "o".repeat(64);
const RELAY = "https://relay.contoh.com";
const link = (extra: Partial<PairingLink> = {}): PairingLink => ({ code: CODE, relayUrl: RELAY, ...extra });

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okBody = (extra: Record<string, unknown> = {}) => ({ deviceId: "d1", machineId: "m1", machineName: "Laptop Kantor", deviceToken: TOKEN, ...extra });

function setup(responses: Array<Response | Error | DOMException>, overrides: Partial<RedeemDeps> = {}) {
  const storage = memoryStorage();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue: Array<Response | Error | DOMException> = [...responses];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("tidak ada jawaban yang disiapkan");
    // Apa pun yang bukan Response dilempar (termasuk DOMException dari jsdom, yang bukan instance Error).
    if (!(next instanceof Response)) throw next;
    return next;
  });
  const deps: RedeemDeps = { storage, fetch: fetchMock as unknown as typeof fetch, now: () => new Date("2026-11-11T10:00:00.000Z"), ...overrides };
  return { storage, calls, fetchMock, deps };
}

describe("isSecureRelayUrl", () => {
  test.each([
    ["https://relay.contoh.com", true],
    ["http://localhost:8787", true],
    ["http://127.0.0.1:8787", true],
    ["http://[::1]:8787", true],
    ["http://relay.contoh.com", false],
    ["http://192.168.1.5:8787", false],
    ["http://127.0.0.1.evil.com", false],
    ["http://localhost.evil.com", false],
    ["ftp://x.com", false],
    ["bukan-alamat", false],
  ])("%s -> %s", (url, expected) => expect(isSecureRelayUrl(url)).toBe(expected));
});

describe("penukaran berhasil", () => {
  test("mengirim kode dan nama ke relay, menyimpan hasilnya, dan mengembalikan laptop yang terpasang", async () => {
    const { deps, calls, storage } = setup([reply(200, okBody())]);
    const outcome = await redeemPairing(link(), "iPhone Budi", deps);

    expect(outcome).toMatchObject({ status: "success", newDevice: true, machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-11T10:00:00.000Z" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${RELAY}/pair/redeem`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ code: CODE, name: "iPhone Budi" });
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(loadPairings(storage)).toEqual([{ relayUrl: RELAY, deviceId: "d1", deviceToken: TOKEN, machines: [expect.objectContaining({ id: "m1" })] }]);
  });

  test("perangkat baru: tanpa header Authorization", async () => {
    const { deps, calls } = setup([reply(200, okBody())]);
    await redeemPairing(link(), "HP", deps);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("garis miring di akhir alamat relay tidak menggandakan jalur", async () => {
    const { deps, calls } = setup([reply(200, okBody())]);
    await redeemPairing(link({ relayUrl: "https://relay.contoh.com//" }), "HP", deps);
    expect(calls[0]?.url).toBe("https://relay.contoh.com/pair/redeem");
  });

  test("meminta batas waktu supaya tidak menggantung selamanya", async () => {
    const { deps, calls } = setup([reply(200, okBody())]);
    await redeemPairing(link(), "HP", deps);
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("rahasia E2E dari tautan tidak dikirim ke relay dan tidak disimpan di perangkat pada tahap ini", async () => {
    const { deps, calls, storage } = setup([reply(200, okBody())]);
    await redeemPairing(link({ secret: "RAHASIA-E2E-JANGAN-BOCOR" }), "HP", deps);
    expect(JSON.stringify(calls)).not.toContain("RAHASIA-E2E");
    expect(storage.data.get(PAIRINGS_STORAGE_KEY)).not.toContain("RAHASIA-E2E");
  });

  test("hasil yang dikembalikan tidak memuat kode maupun token (aman dicatat atau ditampilkan)", async () => {
    const { deps } = setup([reply(200, okBody())]);
    const outcome = await redeemPairing(link(), "HP", deps);
    const failure = await redeemPairing(link(), "HP", setup([reply(400)]).deps);
    expect(JSON.stringify(failure)).not.toContain(CODE);
    // pairing (yang berisi token) memang dikembalikan untuk disimpan pemanggil; kodenya tidak.
    expect(JSON.stringify(outcome)).not.toContain(CODE);
  });
});

describe("HP yang sudah punya kredensial memasangkan laptop kedua", () => {
  function withExisting(responses: Array<Response | Error>) {
    const ctx = setup(responses);
    savePairing(ctx.storage, { relayUrl: RELAY, deviceId: "d1", deviceToken: OLD_TOKEN, machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
    return ctx;
  }

  test("mengirim token lama sebagai Bearer; tanpa token baru, tetap memakai yang lama, dan laptop ditambahkan", async () => {
    const { deps, calls, storage } = withExisting([reply(200, { deviceId: "d1", machineId: "m2", machineName: "Laptop Rumah" })]);
    const outcome = await redeemPairing(link(), "iPhone", deps);

    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${OLD_TOKEN}`);
    expect(outcome).toMatchObject({ status: "success", newDevice: false });
    const [saved] = loadPairings(storage);
    expect(saved?.deviceToken).toBe(OLD_TOKEN);
    expect(saved?.machines.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("relay yang berbeda tidak diberi token relay lain (token tidak bocor lintas relay)", async () => {
    const { deps, calls } = withExisting([reply(200, okBody())]);
    await redeemPairing(link({ relayUrl: "https://relay-lain.contoh.com" }), "HP", deps);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(OLD_TOKEN);
  });

  test("token lama sudah dicabut (401): dibuang, lalu ditukar ulang sebagai perangkat baru dengan kode yang SAMA", async () => {
    const { deps, calls, storage } = withExisting([reply(401, { error: "unauthorized" }), reply(200, okBody({ machineId: "m2", machineName: "Laptop Rumah" }))]);
    const outcome = await redeemPairing(link(), "iPhone", deps);

    expect(calls).toHaveLength(2);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${OLD_TOKEN}`);
    expect((calls[1]?.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(calls[1]?.init.body as string).code).toBe(CODE);
    expect(outcome).toMatchObject({ status: "success", newDevice: true });
    const [saved] = loadPairings(storage);
    expect(saved?.deviceToken).toBe(TOKEN);
    expect(saved?.machines.map((m) => m.id)).toEqual(["m2"]); // catatan lama dari perangkat yang dicabut ikut dibuang
  });

  test("token lama dicabut lalu penukaran kedua juga ditolak: tidak berputar tanpa akhir, hanya dua permintaan", async () => {
    const { deps, calls } = withExisting([reply(401), reply(400)]);
    expect(await redeemPairing(link(), "HP", deps)).toEqual({ status: "invalid-code" });
    expect(calls).toHaveLength(2);
  });

  test("relay menjawab tanpa token baru padahal HP tidak punya token lama: dianggap gagal, tidak ada yang disimpan", async () => {
    const { deps, storage } = setup([reply(200, { deviceId: "d1", machineId: "m1", machineName: "L" })]);
    expect(await redeemPairing(link(), "HP", deps)).toEqual({ status: "failed", httpStatus: 200 });
    expect(storage.data.size).toBe(0);
  });
});

describe("kegagalan", () => {
  test.each([
    [400, { status: "invalid-code" }],
    [429, { status: "rate-limited" }],
    [401, { status: "failed", httpStatus: 401 }], // tanpa token lama, 401 bukan kasus token basi
    [413, { status: "failed", httpStatus: 413 }],
    [500, { status: "failed", httpStatus: 500 }],
    [503, { status: "failed", httpStatus: 503 }],
    [404, { status: "failed", httpStatus: 404 }],
  ])("relay menjawab %s", async (status, expected) => {
    const { deps, storage } = setup([reply(status, { error: "x" })]);
    expect(await redeemPairing(link(), "HP", deps)).toEqual(expected);
    expect(storage.data.size).toBe(0); // gagal tidak menyimpan apa pun
  });

  test("jaringan putus (fetch menolak): relay tidak terjangkau", async () => {
    const { deps, storage } = setup([new TypeError("Failed to fetch")]);
    expect(await redeemPairing(link(), "HP", deps)).toEqual({ status: "unreachable" });
    expect(storage.data.size).toBe(0);
  });

  test("batas waktu habis (AbortError): relay tidak terjangkau", async () => {
    const { deps } = setup([new DOMException("The operation timed out.", "TimeoutError")]);
    expect(await redeemPairing(link(), "HP", deps)).toEqual({ status: "unreachable" });
  });

  test("jawaban 200 yang bukan JSON: gagal", async () => {
    const { deps } = setup([new Response("<html>bukan json</html>", { status: 200 })]);
    expect(await redeemPairing(link(), "HP", deps)).toEqual({ status: "failed", httpStatus: 200 });
  });

  test.each([
    ["bentuk salah", { aneh: true }],
    ["token terlalu pendek", okBody({ deviceToken: "pendek" })],
    ["tanpa nomor laptop", { deviceId: "d1", deviceToken: TOKEN }],
  ])("jawaban 200 yang tidak sesuai kontrak ditolak: %s", async (_name, body) => {
    const { deps, storage } = setup([reply(200, body)]);
    expect(await redeemPairing(link(), "HP", deps)).toEqual({ status: "failed", httpStatus: 200 });
    expect(storage.data.size).toBe(0);
  });

  test("alamat relay tanpa enkripsi ditolak SEBELUM menghubungi siapa pun", async () => {
    const { deps, fetchMock } = setup([reply(200, okBody())]);
    expect(await redeemPairing(link({ relayUrl: "http://relay.contoh.com" }), "HP", deps)).toEqual({ status: "insecure-relay" });
    expect(await redeemPairing(link({ relayUrl: "http://192.168.1.5:8787" }), "HP", deps)).toEqual({ status: "insecure-relay" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("http ke komputer sendiri (pengembangan) diizinkan", async () => {
    const { deps, calls } = setup([reply(200, okBody())]);
    expect((await redeemPairing(link({ relayUrl: "http://localhost:8787" }), "HP", deps)).status).toBe("success");
    expect(calls[0]?.url).toBe("http://localhost:8787/pair/redeem");
  });

  test("alamat relay yang tidak sah: gagal tanpa menghubungi siapa pun", async () => {
    const { deps, fetchMock } = setup([]);
    expect(await redeemPairing(link({ relayUrl: "bukan-alamat" }), "HP", deps)).toEqual({ status: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("relay berhasil tetapi perangkat tidak bisa menyimpan: dilaporkan jelas beserta nama laptop", async () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const { deps } = setup([reply(200, okBody())], { storage: full });
    expect(await redeemPairing(link(), "HP", deps)).toEqual({ status: "not-saved", machineName: "Laptop Kantor" });
  });

  test("tanpa penyimpanan sama sekali: not-saved", async () => {
    const { deps } = setup([reply(200, okBody())], { storage: undefined });
    expect((await redeemPairing(link(), "HP", deps)).status).toBe("not-saved");
  });
});
