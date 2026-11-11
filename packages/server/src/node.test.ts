import type { ServerFrame } from "@agentmon/shared";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket, { type ClientOptions } from "ws";
import { createMemoryDirectory } from "./directory";
import { CLOSE, type RelayLimits } from "./hub";
import type { Logger } from "./logger";
import { startRelayServer, sweepIntervalMs, type RunningRelay } from "./node";

const TOKENS = {
  m1: "machine-token-satu-0000000000000000",
  m2: "machine-token-dua-00000000000000000",
  d1: "device-token-satu-00000000000000000",
  d2: "device-token-dua-000000000000000000",
  d3: "device-token-tiga-00000000000000000",
};

let relay: RunningRelay | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  await relay?.stop();
  relay = undefined;
});

// m1 dipasangkan dengan d1 dan d2. m2 hanya dengan d3.
function makeDirectory() {
  const directory = createMemoryDirectory();
  directory.addMachine("m1", TOKENS.m1);
  directory.addMachine("m2", TOKENS.m2);
  directory.addDevice("d1", TOKENS.d1);
  directory.addDevice("d2", TOKENS.d2);
  directory.addDevice("d3", TOKENS.d3);
  directory.pair("m1", "d1");
  directory.pair("m1", "d2");
  directory.pair("m2", "d3");
  return directory;
}

async function start(options: { limits?: Partial<RelayLimits>; heartbeatMs?: number } = {}) {
  const logs: string[] = [];
  const logger: Logger = { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) };
  const directory = makeDirectory();
  relay = await startRelayServer({ directory, port: 0, host: "127.0.0.1", logger, ...options });
  return { relay, logs, directory };
}

// Klien WebSocket sungguhan yang mencatat semua yang diterimanya.
class Client {
  readonly messages: ServerFrame[] = [];
  closed: { code: number; reason: string } | undefined;
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => this.messages.push(JSON.parse(String(data)) as ServerFrame));
    ws.on("close", (code, reason) => (this.closed = { code, reason: String(reason) }));
    ws.on("error", () => undefined);
  }
  static async open(port: number, options: ClientOptions = {}, path = "/ws"): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
    const client = new Client(ws);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return client;
  }
  send(frame: unknown) {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  kinds() {
    return this.messages.map((m) => m.kind);
  }
  errors() {
    return this.messages.filter((m): m is Extract<ServerFrame, { kind: "error" }> => m.kind === "error").map((m) => m.code);
  }
  async waitFor(what: string, probe: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (probe()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waktu habis menunggu: ${what}. Diterima: ${JSON.stringify(this.messages)} Ditutup: ${JSON.stringify(this.closed)}`);
  }
}

// Menyambung dan menyelesaikan `hello`.
async function join(port: number, role: "machine" | "device", token: string, options: ClientOptions = {}) {
  const client = await Client.open(port, options);
  client.send({ kind: "hello", role, token });
  await client.waitFor("welcome", () => client.kinds().includes("welcome"));
  return client;
}

// Nomor unik per event: relay mengabaikan nomor yang sama sebagai kiriman ulang.
let eventCounter = 0;
const nextEventId = () => `00000000-0000-4000-8000-${String(++eventCounter).padStart(12, "0")}`;

const envelope = (machineId: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  id: nextEventId(),
  machineId,
  sessionId: "sesi-1",
  seq: 0,
  ts: "2026-11-11T10:00:00.000Z",
  agent: "claude-code",
  type: "tool.requested",
  payload: { toolName: "Write", toolInput: {} },
  ...extra,
});

describe("HTTP", () => {
  test("/health hanya menjawab ok, tanpa membuka jumlah koneksi (bahan pengintaian)", async () => {
    const { relay } = await start();
    await join(relay.port, "machine", TOKENS.m1);
    const reply = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ status: "ok" });
    expect(relay.hub.stats().machines).toBe(1); // statistik tetap tersedia di dalam proses
  });

  test("alamat lain -> 404", async () => {
    const { relay } = await start();
    expect((await fetch(`http://127.0.0.1:${relay.port}/lain`)).status).toBe(404);
  });

  test("sambungan WebSocket ke alamat selain /ws ditolak", async () => {
    const { relay } = await start();
    await expect(Client.open(relay.port, {}, "/lain")).rejects.toThrow(/404/);
  });
});

describe("meneruskan pesan lewat soket sungguhan", () => {
  test("laptop dan HP yang dipasangkan saling bertukar pesan", async () => {
    const { relay } = await start();
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const d1 = await join(relay.port, "device", TOKENS.d1);

    m1.send({ kind: "event", event: envelope("m1") });
    await d1.waitFor("event", () => d1.kinds().includes("event"));
    expect(d1.messages.find((m) => m.kind === "event")).toMatchObject({ event: { machineId: "m1", type: "tool.requested" } });

    d1.send({ kind: "command", machineId: "m1", body: { decision: "approve" } });
    await m1.waitFor("command", () => m1.kinds().includes("command"));
    expect(m1.messages.find((m) => m.kind === "command")).toEqual({ kind: "command", deviceId: "d1", body: { decision: "approve" } });
  });

  test("pesan TIDAK sampai ke pihak yang tidak dipasangkan", async () => {
    const { relay } = await start();
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const d1 = await join(relay.port, "device", TOKENS.d1); // dipasangkan
    const d3 = await join(relay.port, "device", TOKENS.d3); // tersambung, tetapi bukan pasangan m1
    const m2 = await join(relay.port, "machine", TOKENS.m2); // laptop lain, bukan pasangan d1

    // Laptop dan HP yang dipasangkan bertukar pesan, dan HP asing mencoba memerintah laptop m1.
    m1.send({ kind: "event", event: envelope("m1", { sessionId: "RAHASIA-MILIK-M1" }) });
    d3.send({ kind: "command", machineId: "m1", body: { rahasia: "serangan-dari-d3" } });
    d1.send({ kind: "command", machineId: "m1", body: { dari: "d1" } });

    // Penanda: urutan di hub bersifat deterministik, jadi begitu pesan yang sah tiba, pesan
    // yang seharusnya tidak sampai pun sudah pasti diproses.
    await d1.waitFor("event milik m1", () => d1.kinds().includes("event"));
    await m1.waitFor("perintah d1", () => m1.kinds().includes("command"));
    await d3.waitFor("galat untuk d3", () => d3.errors().length > 0);

    expect(d3.kinds()).toEqual(["welcome", "error"]); // tidak menerima event m1
    expect(d3.errors()).toEqual(["forbidden"]);
    expect(JSON.stringify(m1.messages)).not.toContain("serangan-dari-d3"); // perintah d3 tidak sampai
    expect(m1.messages.filter((m) => m.kind === "command")).toHaveLength(1); // hanya dari d1
    expect(m2.kinds()).toEqual(["welcome", "presence"]); // laptop lain tidak menerima event (hanya laporan kehadiran HP-nya)
    expect(JSON.stringify(d1.messages)).not.toContain("serangan");
  });

  test("satu laptop dengan banyak HP yang dipasangkan: semuanya menerima", async () => {
    const { relay } = await start();
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const d1 = await join(relay.port, "device", TOKENS.d1);
    const d2 = await join(relay.port, "device", TOKENS.d2);
    m1.send({ kind: "event", event: envelope("m1") });
    await Promise.all([d1, d2].map((d) => d.waitFor("event", () => d.kinds().includes("event"))));
  });

  test("pencabutan pemasangan langsung berlaku pada soket yang sedang tersambung", async () => {
    const { relay, directory } = await start();
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const d1 = await join(relay.port, "device", TOKENS.d1);
    const d2 = await join(relay.port, "device", TOKENS.d2);

    directory.unpair("m1", "d1");
    m1.send({ kind: "event", event: envelope("m1") });
    await d2.waitFor("event untuk d2", () => d2.kinds().includes("event"));
    expect(d1.kinds()).toEqual(["welcome"]); // d1 sudah dicabut
  });

  test("koneksi baru dari pihak yang sama menggantikan yang lama", async () => {
    const { relay } = await start();
    const first = await join(relay.port, "device", TOKENS.d1);
    await join(relay.port, "device", TOKENS.d1);
    await first.waitFor("ditutup", () => first.closed !== undefined);
    expect(first.closed?.code).toBe(CLOSE.replaced);
    expect(first.errors()).toEqual(["replaced"]);
  });
});

describe("ketahanan terhadap pesan buruk", () => {
  test("pesan yang terlalu besar ditolak, koneksinya ditutup (1009), dan server tetap hidup", async () => {
    const { relay } = await start({ limits: { maxMessageBytes: 2048 } });
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const d1 = await join(relay.port, "device", TOKENS.d1);

    m1.send(JSON.stringify({ kind: "event", event: envelope("m1", { payload: { isi: "x".repeat(10_000) } }) }));
    await m1.waitFor("ditutup", () => m1.closed !== undefined);
    expect(m1.closed?.code).toBe(CLOSE.tooLarge);
    expect(d1.kinds()).toEqual(["welcome"]); // pesan besar tidak diteruskan

    // Server tidak jatuh: masih menjawab, dan koneksi lain tetap berfungsi.
    expect((await fetch(`http://127.0.0.1:${relay.port}/health`)).status).toBe(200);
    const m1Again = await join(relay.port, "machine", TOKENS.m1);
    m1Again.send({ kind: "event", event: envelope("m1") });
    await d1.waitFor("event setelah pesan besar", () => d1.kinds().includes("event"));
  });

  test("pesan biner ditolak, koneksi tetap hidup", async () => {
    const { relay } = await start();
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    m1.ws.send(Buffer.from([1, 2, 3]));
    await m1.waitFor("galat", () => m1.errors().length > 0);
    expect(m1.errors()).toEqual(["invalid_frame"]);
    expect(m1.closed).toBeUndefined();
  });

  test("JSON rusak dan bingkai tak dikenal ditolak tanpa memutus koneksi yang sah", async () => {
    const { relay } = await start();
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    m1.send("{rusak");
    m1.send({ kind: "terbang" });
    await m1.waitFor("dua galat", () => m1.errors().length === 2);
    expect(m1.errors()).toEqual(["invalid_json", "invalid_frame"]);
    expect(m1.closed).toBeUndefined();
  });

  test("banjir pesan dibatasi dan diputus, tanpa mengganggu koneksi lain", async () => {
    const { relay } = await start({ limits: { rateCapacity: 5, rateRefillPerSecond: 1, maxRateViolations: 5 } });
    const d1 = await join(relay.port, "device", TOKENS.d1);
    const flooder = await join(relay.port, "device", TOKENS.d3);
    for (let i = 0; i < 100; i++) flooder.send({ kind: "terbang" });
    await flooder.waitFor("diputus", () => flooder.closed !== undefined);
    expect(flooder.errors()).toContain("rate_limited");
    expect(flooder.closed?.code).toBe(CLOSE.policy);

    expect(d1.closed).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${relay.port}/health`)).status).toBe(200);
  });

  test("token salah -> unauthorized dan diputus", async () => {
    const { relay } = await start();
    const client = await Client.open(relay.port);
    client.send({ kind: "hello", role: "machine", token: "token-yang-salah-0000000000000000" });
    await client.waitFor("ditutup", () => client.closed !== undefined);
    expect(client.errors()).toEqual(["unauthorized"]);
    expect(client.closed?.code).toBe(CLOSE.unauthorized);
  });
});

describe("koneksi yang mati dibersihkan", () => {
  test("klien yang tidak menjawab ping dianggap mati dan ditutup, sedangkan klien normal tetap hidup", async () => {
    // Detak 40 ms, batas diam 200 ms.
    const { relay } = await start({ heartbeatMs: 40, limits: { idleTimeoutMs: 200 } });
    const dead = await join(relay.port, "device", TOKENS.d1, { autoPong: false }); // tidak menjawab ping
    const alive = await join(relay.port, "device", TOKENS.d2); // menjawab ping seperti biasa

    await dead.waitFor("ditutup karena mati", () => dead.closed !== undefined, 4000);
    expect(dead.closed?.code).toBe(CLOSE.idle);
    expect(dead.errors()).toEqual(["idle_timeout"]);
    expect(alive.closed).toBeUndefined();
    expect(relay.hub.stats().devices).toBe(1);
  });

  test("koneksi yang tidak pernah menyebut hello ditutup", async () => {
    const { relay } = await start({ heartbeatMs: 30, limits: { helloTimeoutMs: 100 } });
    const silent = await Client.open(relay.port);
    await silent.waitFor("ditutup", () => silent.closed !== undefined, 3000);
    expect(silent.closed?.code).toBe(CLOSE.helloTimeout);
    expect(silent.errors()).toEqual(["hello_timeout"]);
  });

  test("koneksi yang diputus klien dibersihkan dari hub", async () => {
    const { relay } = await start();
    const d1 = await join(relay.port, "device", TOKENS.d1);
    expect(relay.hub.stats().devices).toBe(1);
    d1.ws.close();
    await d1.waitFor("tertutup", () => d1.closed !== undefined);
    const deadline = Date.now() + 2000;
    while (relay.hub.stats().connections > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(relay.hub.stats()).toEqual({ connections: 0, machines: 0, devices: 0 });
  });
});

describe("log tidak memuat isi pesan", () => {
  test("isi event, perintah, token, dan pesan yang ditolak tidak muncul di log", async () => {
    const { relay, logs } = await start({ limits: { maxMessageBytes: 4096 } });
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const d1 = await join(relay.port, "device", TOKENS.d1);

    m1.send({ kind: "event", event: envelope("m1", { payload: { toolInput: { content: "RAHASIA-ISI-EVENT" } } }) });
    await d1.waitFor("event", () => d1.kinds().includes("event"));
    d1.send({ kind: "command", machineId: "m1", body: { comment: "RAHASIA-KOMENTAR" } });
    await m1.waitFor("perintah", () => m1.kinds().includes("command"));
    m1.send("RAHASIA-BUKAN-JSON");
    await m1.waitFor("galat", () => m1.errors().length > 0);

    const bad = await Client.open(relay.port);
    bad.send({ kind: "hello", role: "machine", token: "RAHASIA-TOKEN-SALAH-0000000000" });
    await bad.waitFor("ditutup", () => bad.closed !== undefined);

    const big = await join(relay.port, "machine", TOKENS.m2);
    big.send(JSON.stringify({ kind: "event", event: envelope("m2", { payload: "RAHASIA-BESAR-".repeat(1000) }) }));
    await big.waitFor("ditutup", () => big.closed !== undefined);

    const text = logs.join("\n");
    expect(text).not.toContain("RAHASIA");
    for (const token of Object.values(TOKENS)) expect(text).not.toContain(token);
    expect(text).toContain("terautentikasi role=machine"); // memang ada yang dicatat
  });
});

describe("penyapuan lebih rapat daripada ping", () => {
  test("sweepIntervalMs: setengah batas hello, tidak lebih jarang dari ping, dengan batas bawah", () => {
    expect(sweepIntervalMs(30_000, 5_000)).toBe(2_500); // bawaan: disapu tiap 2,5 detik, bukan 30 detik
    expect(sweepIntervalMs(1_000, 5_000)).toBe(1_000); // ping lebih rapat: ikut ping
    expect(sweepIntervalMs(30_000, 4)).toBe(10); // batas bawah
  });

  test("koneksi yang tidak menyebut hello ditutup mendekati batasnya walau jarak ping sangat panjang", async () => {
    // Ping hanya tiap 60 detik. Tanpa penyapuan yang lebih rapat, koneksi diam ini bertahan sampai 60 detik.
    const { relay } = await start({ heartbeatMs: 60_000, limits: { helloTimeoutMs: 100 } });
    const started = Date.now();
    const silent = await Client.open(relay.port);
    await silent.waitFor("ditutup", () => silent.closed !== undefined, 3000);
    expect(silent.closed?.code).toBe(CLOSE.helloTimeout);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("penerima yang tidak membaca", () => {
  test("diputus saat antreannya membengkak, tanpa mengganggu penerima lain", async () => {
    // Batas antrean (2 MiB) jauh lebih besar daripada satu pesan (100 KiB), supaya penerima yang sehat
    // tidak ikut terhitung lambat hanya karena ada beberapa pesan yang sedang dalam perjalanan.
    const { relay } = await start({
      limits: { maxBufferedBytes: 2 * 1024 * 1024, maxMessageBytes: 512 * 1024, rateCapacity: 1000, rateRefillPerSecond: 1000 },
    });
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const slow = await join(relay.port, "device", TOKENS.d1);
    const fast = await join(relay.port, "device", TOKENS.d2);

    // `slow` berhenti membaca dari soketnya, seperti HP yang hang atau klien yang sengaja nakal.
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause();

    // Total 15 MiB, dikirim bergelombang kecil: cukup banyak untuk melampaui penyangga soket sistem
    // operasi pada penerima yang diam, tetapi cukup santai agar penerima yang membaca tetap mengimbangi.
    const payload = "x".repeat(100 * 1024);
    for (let i = 0; i < 150; i++) {
      m1.send({ kind: "event", event: envelope("m1", { seq: i, payload: { isi: payload } }) });
      if (i % 3 === 2) await new Promise((r) => setTimeout(r, 10));
    }

    // Relay memutus penerima yang lambat: ia hilang dari hub, sedangkan yang lain tetap ada.
    const deadline = Date.now() + 15_000;
    while (relay.hub.stats().devices > 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(relay.hub.stats().devices).toBe(1);

    expect(fast.closed).toBeUndefined();
    expect(fast.kinds().filter((k) => k === "event").length).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${relay.port}/health`)).status).toBe(200);
  }, 30_000);
});

describe("berhenti dengan rapi", () => {
  test("stop menutup semua koneksi dan port", async () => {
    const { relay } = await start();
    const m1 = await join(relay.port, "machine", TOKENS.m1);
    const port = relay.port;
    await relay.stop();
    await m1.waitFor("ditutup", () => m1.closed !== undefined);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
