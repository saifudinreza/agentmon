import { createServer, type Server } from "node:http";
import { parsePairingUrl } from "@agentmon/shared";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "./cli";
import { runPair, type PairOptions } from "./pairing";

const TOKEN = "machine-token-0000000000000000";
const CODE = "abcDEF0123456789_-abcDEF0123456789";

// Relay palsu: meniru kontrak /pair/* dan bisa diatur perilakunya per test.
type Fake = {
  devices: Array<{ id: string; name: string; pairedAt: string }>;
  codeStatus: number;
  devicesStatus: number;
  expiresAt: () => string;
  seen: Array<{ method: string; path: string; auth: string | undefined }>;
  onDevicesPoll?: (pollNumber: number) => void;
};
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function startFakeRelay(fake: Fake): Promise<string> {
  let polls = 0;
  server = createServer((req, res) => {
    fake.seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/pair/devices") {
      polls++;
      fake.onDevicesPoll?.(polls);
      res.statusCode = fake.devicesStatus;
      res.end(JSON.stringify({ devices: fake.devices }));
    } else if (req.url === "/pair/code") {
      res.statusCode = fake.codeStatus;
      res.end(JSON.stringify({ code: CODE, expiresAt: fake.expiresAt() }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

function setup(overrides: Partial<Fake> = {}) {
  const clock = { ms: Date.parse("2026-11-11T00:00:00Z") };
  const fake: Fake = {
    devices: [],
    codeStatus: 201,
    devicesStatus: 200,
    expiresAt: () => new Date(clock.ms + 5 * 60_000).toISOString(),
    seen: [],
    ...overrides,
  };
  const out: string[] = [];
  const err: string[] = [];
  const options = (relayUrl: string): PairOptions => ({
    relayUrl,
    machineToken: TOKEN,
    appUrl: "https://app.contoh.com",
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    // Jam palsu yang maju tiap "tidur", sehingga penantian 5 menit selesai seketika.
    now: () => clock.ms,
    sleep: async (ms) => void (clock.ms += ms),
    renderQr: async (text) => `[QR:${text}]`,
    pollMs: 2000,
  });
  return { clock, fake, out, err, options };
}

describe("runPair", () => {
  test("alur utama: menampilkan QR berisi alamat yang benar, menunggu, lalu memberi tahu ada HP baru", async () => {
    const t = setup({
      onDevicesPoll: (n) => {
        if (n === 4) t.fake.devices.push({ id: "d1", name: "iPhone Budi", pairedAt: "2026-11-11T00:00:07Z" });
      },
    });
    const base = await startFakeRelay(t.fake);

    expect(await runPair(t.options(base))).toBe(0);

    // QR berisi alamat pairing yang bisa dibaca PWA, dengan kode DAN alamat relay di fragmen.
    const qrLine = t.out.find((line) => line.startsWith("[QR:"));
    const url = qrLine?.slice(4, -1) as string;
    expect(parsePairingUrl(url)).toEqual({ code: CODE, relayUrl: base });
    expect(new URL(url).search).toBe(""); // tidak ada rahasia di bagian yang dikirim ke server hosting
    expect(t.out).toContain("Perangkat baru terpasang: iPhone Budi");
    expect(t.err).toEqual([]);
  });

  test("semua permintaan membawa token laptop sebagai Bearer", async () => {
    const t = setup({ devices: [{ id: "lama", name: "HP lama", pairedAt: "2026-11-01T00:00:00Z" }], onDevicesPoll: (n) => {
      if (n === 2) t.fake.devices.push({ id: "baru", name: "HP baru", pairedAt: "2026-11-11T00:00:01Z" });
    } });
    await runPair(t.options(await startFakeRelay(t.fake)));
    expect(t.fake.seen.length).toBeGreaterThanOrEqual(3);
    for (const request of t.fake.seen) expect(request.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("HP yang SUDAH terpasang sebelumnya tidak dianggap perangkat baru", async () => {
    const t = setup({ devices: [{ id: "lama", name: "HP lama", pairedAt: "2026-11-01T00:00:00Z" }] });
    const code = await runPair(t.options(await startFakeRelay(t.fake)));
    expect(t.out.join("\n")).not.toContain("Perangkat baru terpasang");
    expect(code).toBe(1); // tidak ada yang baru sampai kode kedaluwarsa
  });

  test("kode kedaluwarsa tanpa HP yang memindai: pesan jelas dan kode keluar 1", async () => {
    const t = setup();
    expect(await runPair(t.options(await startFakeRelay(t.fake)))).toBe(1);
    expect(t.err.join("\n")).toContain("Kode kedaluwarsa");
    expect(t.out.join("\n")).not.toContain("Perangkat baru terpasang");
  });

  test("berhenti bertanya setelah kedaluwarsa (jumlah pertanyaan terbatas, bukan selamanya)", async () => {
    const t = setup();
    await runPair(t.options(await startFakeRelay(t.fake)));
    const polls = t.fake.seen.filter((r) => r.path === "/pair/devices").length;
    expect(polls).toBeGreaterThan(100); // 5 menit / 2 detik, ditambah pengecekan awal
    expect(polls).toBeLessThan(200);
  });

  test("gangguan sesaat saat menunggu tidak menghentikan penantian", async () => {
    const t = setup({
      onDevicesPoll: (n) => {
        t.fake.devicesStatus = n >= 2 && n <= 4 ? 503 : 200; // beberapa pertanyaan gagal
        if (n === 6) t.fake.devices.push({ id: "d1", name: "HP", pairedAt: "2026-11-11T00:00:09Z" });
      },
    });
    expect(await runPair(t.options(await startFakeRelay(t.fake)))).toBe(0);
    expect(t.out).toContain("Perangkat baru terpasang: HP");
  });

  test("beberapa HP muncul bersamaan: semuanya disebut", async () => {
    const t = setup({
      onDevicesPoll: (n) => {
        if (n === 2) t.fake.devices.push({ id: "a", name: "HP A", pairedAt: "2026-11-11T00:00:01Z" }, { id: "b", name: "HP B", pairedAt: "2026-11-11T00:00:02Z" });
      },
    });
    expect(await runPair(t.options(await startFakeRelay(t.fake)))).toBe(0);
    expect(t.out).toContain("Perangkat baru terpasang: HP A");
    expect(t.out).toContain("Perangkat baru terpasang: HP B");
  });

  test.each([
    [401, "menolak token"],
    [500, "galat 500"],
  ])("relay menolak saat memeriksa daftar (%s): pesan jelas, tidak ada kode dibuat", async (status, text) => {
    const t = setup({ devicesStatus: status });
    expect(await runPair(t.options(await startFakeRelay(t.fake)))).toBe(1);
    expect(t.err.join("\n")).toContain(text);
    expect(t.fake.seen.some((r) => r.path === "/pair/code")).toBe(false);
  });

  test("terlalu banyak kode aktif (429): saran yang bisa ditindaklanjuti", async () => {
    const t = setup({ codeStatus: 429 });
    expect(await runPair(t.options(await startFakeRelay(t.fake)))).toBe(1);
    expect(t.err.join("\n")).toContain("Terlalu banyak kode");
  });

  test("relay tidak terjangkau: pesan jelas, tidak menggantung", async () => {
    const t = setup();
    const base = await startFakeRelay(t.fake);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await runPair(t.options(base))).toBe(1);
    expect(t.err.join("\n")).toContain("tidak terjangkau");
  });

  test("jawaban relay yang bentuknya aneh ditolak dengan pesan jelas", async () => {
    const t = setup();
    const base = await startFakeRelay(t.fake);
    const bad: PairOptions = { ...t.options(base), fetch: async () => new Response(JSON.stringify({ aneh: true }), { status: 200 }) };
    expect(await runPair(bad)).toBe(1);
    expect(t.err.join("\n")).toContain("tidak dikenali");
  });

  test.each([
    ["alamat relay salah", { relayUrl: "bukan-alamat" }],
    ["alamat relay bukan http", { relayUrl: "ftp://x.com" }],
    ["alamat aplikasi salah", { appUrl: "bukan-alamat" }],
  ])("%s dijelaskan di awal, tanpa menghubungi relay", async (_name, patch) => {
    const t = setup();
    const calls: string[] = [];
    const code = await runPair({ ...t.options("http://127.0.0.1:1"), ...patch, fetch: async (url) => (calls.push(String(url)), new Response("{}")) });
    expect(code).toBe(1);
    expect(t.err.join("\n")).toContain("Alamat tidak valid");
    expect(calls).toEqual([]);
  });

  test("garis miring di akhir alamat relay tidak menggandakan jalur", async () => {
    const t = setup();
    const base = await startFakeRelay(t.fake);
    await runPair(t.options(`${base}/`));
    expect(t.fake.seen.every((r) => r.path.startsWith("/pair/") && !r.path.startsWith("//"))).toBe(true);
  });
});

describe("perintah CLI `pair`", () => {
  test("variabel lingkungan yang kurang disebut satu per satu, tanpa menyentuh jaringan", async () => {
    const err: string[] = [];
    const code = await runCli(["pair"], { env: { AGENTMON_RELAY_URL: "https://r.example" }, out: () => undefined, err: (t) => err.push(t) });
    expect(code).toBe(1);
    expect(err[0]).toContain("AGENTMON_RELAY_TOKEN, AGENTMON_APP_URL");
    expect(err[0]).not.toContain("AGENTMON_RELAY_URL,");
  });

  test("tidak butuh daemon lokal (tidak ada berkas token), dan meneruskan lingkungan ke runPair", async () => {
    const t = setup({
      onDevicesPoll: (n) => {
        if (n === 2) t.fake.devices.push({ id: "d1", name: "HP", pairedAt: "2026-11-11T00:00:01Z" });
      },
    });
    const base = await startFakeRelay(t.fake);
    const out: string[] = [];
    const code = await runCli(["pair"], {
      env: { AGENTMON_HOME: "/folder/yang/tidak/ada", AGENTMON_RELAY_URL: base, AGENTMON_RELAY_TOKEN: TOKEN, AGENTMON_APP_URL: "https://app.contoh.com" },
      out: (text) => out.push(text),
      err: () => undefined,
      pair: { now: () => t.clock.ms, sleep: async (ms) => void (t.clock.ms += ms), renderQr: async () => "[QR]" },
    });
    expect(code).toBe(0);
    expect(out).toContain("Perangkat baru terpasang: HP");
    expect(t.fake.seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("muncul di bantuan", async () => {
    const err: string[] = [];
    await runCli(["perintah-tidak-ada"], { env: {}, out: () => undefined, err: (t) => err.push(t) });
    expect(err.join("\n")).toContain("pair");
  });
});
