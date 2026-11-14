import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { paths } from "./home";
import { defaultMachineName, runRegister, type RegisterOptions } from "./register";
import { loadRelayConfig, saveRelayConfig } from "./relay-config";

const SECRET = "rahasia-admin-yang-panjang-0123456789abcdef";
const TOKEN = "c".repeat(64);
const RELAY = "https://relay.contoh.com";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentmon-register-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };

// Pemeriksaan /health (membangunkan relay) dicatat terpisah dari pendaftarannya.
function setup(
  respond: (call: Call) => Response | Promise<Response> | Error,
  extra: Partial<RegisterOptions> = {},
  health: () => Response | Promise<Response> | Error = () => new Response("{}", { status: 200 }),
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const healthCalls: Array<{ method: string; signal: AbortSignal | undefined }> = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/health")) {
      healthCalls.push({ method: init?.method ?? "GET", signal: init?.signal ?? undefined });
      const reply = await health();
      if (reply instanceof Error) throw reply;
      return reply;
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const reply = await respond(call);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  const run = (overrides: Partial<RegisterOptions> = {}) =>
    runRegister({ relayUrl: RELAY, adminSecret: SECRET, home, out: (t) => out.push(t), err: (t) => err.push(t), fetch: fetchFake, hostname: () => "Laptop-Budi", ...extra, ...overrides });
  const all = () => [...out, ...err].join("\n");
  return { run, out, err, calls, healthCalls, all };
}

const created = (call: Call, token = TOKEN) => new Response(JSON.stringify({ machineId: call.body?.id, token }), { status: 201 });
const status = (code: number, body: unknown = {}) => new Response(JSON.stringify(body), { status: code });

describe("pendaftaran berhasil", () => {
  test("mengirim nomor dan nama ke relay dengan rahasia admin, menyimpan pengaturan, dan tidak menampilkan token", async () => {
    const t = setup((call) => created(call));
    expect(await t.run()).toBe(0);

    expect(t.calls).toHaveLength(1);
    const call = t.calls[0]!;
    expect(call.url).toBe(`${RELAY}/admin/machines`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ id: readFileSync(paths(home).machineId, "utf8").trim(), name: "Laptop-Budi" });
    expect(call.body?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect(loadRelayConfig(home)).toEqual({ relayUrl: RELAY, token: TOKEN });
    expect(t.all()).toContain("Laptop terdaftar di relay.contoh.com");
    expect(t.all()).not.toContain(TOKEN); // token tidak dicetak
    expect(t.all()).not.toContain(SECRET);
    expect(t.err).toEqual([]);
  });

  test("rahasia admin tidak ditulis ke berkas pengaturan", async () => {
    const t = setup((call) => created(call));
    await t.run();
    expect(readFileSync(paths(home).relay, "utf8")).not.toContain(SECRET);
  });

  test("nomor laptop memakai machine-id yang sama dengan daemon, dan stabil antar-perintah", async () => {
    const first = setup((call) => created(call));
    await first.run();
    const id = first.calls[0]!.body!.id;
    rmSync(paths(home).relay);
    const second = setup((call) => created(call));
    await second.run();
    expect(second.calls[0]!.body!.id).toBe(id);
  });

  test("alamat relay dengan garis miring di akhir dirapikan, dan yang disimpan alamat yang rapi", async () => {
    const t = setup((call) => created(call));
    expect(await t.run({ relayUrl: `${RELAY}//` })).toBe(0);
    expect(t.calls[0]!.url).toBe(`${RELAY}/admin/machines`);
    expect(loadRelayConfig(home)?.relayUrl).toBe(RELAY);
  });

  test("--print-token menampilkan alamat dan token, dengan peringatan", async () => {
    const t = setup((call) => created(call));
    expect(await t.run({ printToken: true })).toBe(0);
    expect(t.out).toContain(`  AGENTMON_RELAY_URL=${RELAY}`);
    expect(t.out).toContain(`  AGENTMON_RELAY_TOKEN=${TOKEN}`);
    expect(t.all()).toContain("Jangan dibagikan");
    expect(t.all()).not.toContain(SECRET);
  });

  test("nama dari --name dipakai (dipangkas), bukan nama komputer", async () => {
    const t = setup((call) => created(call));
    await t.run({ name: "  Laptop Kantor  " });
    expect(t.calls[0]!.body!.name).toBe("Laptop Kantor");
  });

  test("terdaftar di relay lain sebelumnya: pengaturan lama digantikan oleh yang baru", async () => {
    saveRelayConfig(home, { relayUrl: "https://relay-lama.example", token: "z".repeat(64) });
    const t = setup((call) => created(call));
    expect(await t.run()).toBe(0);
    expect(loadRelayConfig(home)).toEqual({ relayUrl: RELAY, token: TOKEN });
  });
});

describe("nama bawaan", () => {
  test.each([
    ["Laptop-Budi", "Laptop-Budi"],
    ["  spasi  ", "spasi"],
    ["Lap\u001btop‮", "Laptop"],
    ["", "Laptop"],
    ["\u001b\u001b", "Laptop"],
    ["a".repeat(100), "a".repeat(64)],
  ])("%j -> %j", (hostname, expected) => expect(defaultMachineName(hostname)).toBe(expected));
});

describe("sudah terdaftar dan penggantian token", () => {
  test("terdaftar di relay yang sama tanpa --rotate: ditolak lebih dulu, relay tidak dihubungi, dan pengaturan tidak berubah", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "z".repeat(64) });
    const t = setup((call) => created(call));
    expect(await t.run({ relayUrl: `${RELAY}/` })).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.err.join("\n")).toContain("--rotate");
    expect(loadRelayConfig(home)?.token).toBe("z".repeat(64));
  });

  test("--rotate mengirim rotate:true dan mengganti token yang tersimpan", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "z".repeat(64) });
    const t = setup((call) => created(call));
    expect(await t.run({ rotate: true })).toBe(0);
    expect(t.calls[0]!.body).toMatchObject({ rotate: true });
    expect(loadRelayConfig(home)?.token).toBe(TOKEN);
    expect(t.all()).toContain("Token laptop diganti");
    expect(t.all()).toContain("Jalankan ulang daemon");
  });

  test("tanpa --rotate, kolom rotate tidak dikirim sama sekali", async () => {
    const t = setup((call) => created(call));
    await t.run();
    expect("rotate" in t.calls[0]!.body!).toBe(false);
  });

  test("berkas pengaturan rusak: berhenti dengan penjelasan, relay tidak dihubungi", async () => {
    writeFileSync(paths(home).relay, "{rusak");
    const t = setup((call) => created(call));
    expect(await t.run()).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.err.join("\n")).toContain("rusak");
  });
});

describe("alamat relay dan enkripsi", () => {
  test.each([["bukan alamat"], ["ftp://relay.contoh.com"], [""]])("alamat tidak valid %j: kode 2, relay tidak dihubungi", async (relayUrl) => {
    const t = setup((call) => created(call));
    expect(await t.run({ relayUrl })).toBe(2);
    expect(t.calls).toEqual([]);
  });

  test("http ke host selain komputer ini: ditolak, dan rahasia admin TIDAK dikirim", async () => {
    const t = setup((call) => created(call));
    expect(await t.run({ relayUrl: "http://relay.contoh.com" })).toBe(2);
    expect(t.calls).toEqual([]);
    expect(t.err.join("\n")).toContain("teks biasa");
    expect(t.all()).not.toContain(SECRET);
  });

  test.each([["http://localhost:8787"], ["http://127.0.0.1:8787"], ["http://[::1]:8787"]])("http ke komputer ini (%s) boleh", async (relayUrl) => {
    const t = setup((call) => created(call));
    expect(await t.run({ relayUrl })).toBe(0);
  });

  test("http ke host lain boleh bila dinyalakan dengan sadar", async () => {
    const t = setup((call) => created(call));
    expect(await t.run({ relayUrl: "http://192.168.1.5:8787", allowInsecure: true })).toBe(0);
  });
});

describe("galat dari relay", () => {
  test.each([
    [401, {}, /menolak rahasia admin/],
    [404, {}, /tidak membuka pendaftaran/],
    [404, { error: "not-found" }, /belum terdaftar.*tanpa --rotate/s],
    [409, { error: "already-registered" }, /sudah terdaftar.*--rotate/s],
    [429, { error: "rate-limited" }, /Tunggu beberapa menit/],
    [400, { error: "bad-request" }, /menolak data/],
    [500, {}, /galat 500/],
    [503, {}, /galat 503/],
  ])("status %i %j: kode 1 dengan pesan yang jelas, dan tidak ada yang tersimpan", async (code, body, message) => {
    const t = setup(() => status(code, body));
    expect(await t.run()).toBe(1);
    expect(t.err.join("\n")).toMatch(message);
    expect(loadRelayConfig(home)).toBeUndefined();
    expect(t.all()).not.toContain(SECRET);
  });

  test("relay tidak terjangkau saat dibangunkan: kode 1, dan pendaftarannya tidak dikirim sama sekali", async () => {
    const t = setup((call) => created(call), {}, () => new TypeError("fetch failed"));
    expect(await t.run()).toBe(1);
    expect(t.err.join("\n")).toContain("tidak terjangkau");
    expect(t.calls).toEqual([]);
    expect(loadRelayConfig(home)).toBeUndefined();
    expect(t.all()).not.toContain(SECRET);
  });

  test("pendaftaran gagal di tengah jalan padahal relay sudah bangun: dijelaskan, dengan petunjuk --rotate bila ternyata sudah tercatat", async () => {
    const t = setup(() => new TypeError("fetch failed"));
    expect(await t.run()).toBe(1);
    expect(t.err.join("\n")).toContain("gagal di tengah jalan");
    expect(t.err.join("\n")).toContain("--rotate");
    expect(loadRelayConfig(home)).toBeUndefined();
  });

  test("jawaban 201 yang bentuknya salah: tidak disimpan, dan pengguna diarahkan memakai --rotate", async () => {
    const t = setup(() => status(201, { machineId: "x", token: "pendek" }));
    expect(await t.run()).toBe(1);
    expect(t.err.join("\n")).toContain("tidak dikenali");
    expect(t.err.join("\n")).toContain("--rotate");
    expect(loadRelayConfig(home)).toBeUndefined();
  });

  test("jawaban 201 untuk nomor yang berbeda dari yang dikirim: ditolak, tidak disimpan", async () => {
    const t = setup(() => status(201, { machineId: "11111111-1111-4111-8111-111111111111", token: TOKEN }));
    expect(await t.run()).toBe(1);
    expect(loadRelayConfig(home)).toBeUndefined();
  });

  test("jawaban bukan JSON: dianggap galat biasa, tidak melempar", async () => {
    const t = setup(() => new Response("bukan json", { status: 502 }));
    expect(await t.run()).toBe(1);
    expect(t.err.join("\n")).toContain("galat 502");
  });
});

describe("token hanya diberikan sekali", () => {
  test("berkas gagal ditulis: token DICETAK ke stderr supaya tidak hilang, dengan penjelasan, dan kode 1", async () => {
    const t = setup((call) => created(call), {
      save: () => {
        throw new Error("disk penuh");
      },
    });
    expect(await t.run()).toBe(1);
    expect(t.err.join("\n")).toContain("SUDAH terdaftar");
    expect(t.err.join("\n")).toContain("disk penuh");
    expect(t.err.join("\n")).toContain(`AGENTMON_RELAY_TOKEN=${TOKEN}`);
    expect(t.out).toEqual([]); // tidak ada pesan "berhasil"
    expect(t.all()).not.toContain(SECRET);
  });

  test("tidak ada galat lain yang mencetak token", async () => {
    for (const code of [401, 404, 409, 429, 400, 500]) {
      const t = setup(() => status(code, { token: TOKEN }));
      await t.run();
      expect(t.all()).not.toContain(TOKEN);
    }
    const t = setup(vi.fn(() => new TypeError("fetch failed")));
    await t.run();
    expect(t.all()).not.toContain(TOKEN);
  });
});

describe("membangunkan relay dulu (hasil review PR #59)", () => {
  test("GET /health dikirim SEBELUM pendaftaran, dengan batas waktu panjang untuk relay yang baru bangun", async () => {
    const order: string[] = [];
    const t = setup(
      (call) => (order.push("POST"), created(call)),
      {},
      () => (order.push("health"), new Response("{}", { status: 200 })),
    );
    expect(await t.run()).toBe(0);
    expect(order).toEqual(["health", "POST"]);
    expect(t.healthCalls).toHaveLength(1);
    expect(t.healthCalls[0]!.method).toBe("GET");
    // Batas waktu panjang (lebih dari waktu bangun terukur ~52 detik): sinyalnya belum batal, dan bukan batas 15 detik.
    expect(t.healthCalls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("jawaban HTTP apa pun dari /health (termasuk 404 atau 503) berarti relay sudah bangun: pendaftaran dilanjutkan", async () => {
    for (const code of [200, 404, 502, 503]) {
      rmSync(paths(home).relay, { force: true });
      const t = setup((call) => created(call), {}, () => new Response("x", { status: code }));
      expect(await t.run()).toBe(0);
    }
  });

  test("relay butuh waktu bangun: pengguna diberi tahu setelah beberapa detik (bukan layar kosong)", async () => {
    vi.useFakeTimers();
    try {
      const t = setup(
        (call) => created(call),
        {},
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}", { status: 200 })), 5000)),
      );
      const running = t.run();
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.out.join("\n")).not.toContain("sedang bangun");
      await vi.advanceTimersByTimeAsync(3000);
      expect(t.out.join("\n")).toContain("sedang bangun");
      await vi.advanceTimersByTimeAsync(2000);
      expect(await running).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("relay yang langsung menjawab: tidak ada pemberitahuan menunggu", async () => {
    const t = setup((call) => created(call));
    await t.run();
    expect(t.all()).not.toContain("sedang bangun");
  });
});

describe("rahasia admin yang tidak bisa dikirim (hasil review PR #59)", () => {
  test.each([
    ["spasi di dalam", "kata sandi yang panjang dengan spasi di dalamnya 123"],
    ["karakter non-ASCII", `rahasia-dengan-huruf-${"\u00e9"}-yang-cukup-panjang-12345`],
    ["baris baru", "rahasia\nyang-panjang-0123456789abcdef-xyz"],
    ["kosong", ""],
  ])("%s: kode 2, relay tidak dihubungi sama sekali, dan nilainya tidak dicetak", async (_name, adminSecret) => {
    const t = setup((call) => created(call));
    expect(await t.run({ adminSecret })).toBe(2);
    expect(t.calls).toEqual([]);
    expect(t.healthCalls).toEqual([]);
    expect(t.err.join("\n")).toContain("ASCII");
    if (adminSecret) expect(t.all()).not.toContain(adminSecret);
  });
});

describe("token lama di lingkungan (hasil review PR #59)", () => {
  test("lingkungan lengkap mengalahkan berkas: pengguna diperingatkan, dan pendaftaran tetap berhasil", async () => {
    const t = setup((call) => created(call));
    expect(await t.run({ envOverridesSaved: true })).toBe(0);
    expect(t.err.join("\n")).toContain("PERINGATAN");
    expect(t.err.join("\n")).toContain("MENGALAHKAN");
    expect(loadRelayConfig(home)?.token).toBe(TOKEN);
    expect(t.all()).not.toContain(TOKEN);
  });

  test("tanpa lingkungan yang mengalahkan: tidak ada peringatan", async () => {
    const t = setup((call) => created(call));
    await t.run({ envOverridesSaved: false });
    expect(t.err).toEqual([]);
    const u = setup((call) => created(call));
    rmSync(paths(home).relay, { force: true });
    await u.run();
    expect(u.err).toEqual([]);
  });
});
