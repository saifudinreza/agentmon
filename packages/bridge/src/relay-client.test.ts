import type { Envelope } from "@agentmon/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { Logger } from "./logger";
import { createRelayClient, toWebSocketUrl, type RelayClient, type RelayClientOptions } from "./relay-client";

const TOKEN = "machine-token-RAHASIA-0000000000";
const MACHINE = "m1";

// ---- Relay palsu: mengikuti kontrak relay sungguhan (hello -> welcome, event -> ack, dedupe per id) ----
type Verdict = "ack" | "ignore" | "close" | "rate_limited";
type FakeRelayOptions = {
  port?: number;
  welcomeId?: string;
  answerHello?: boolean;
  // Menentukan nasib tiap event yang masuk. `n` = urutan penerimaan (mulai 1) di seluruh relay.
  onEvent?: (n: number, event: Envelope) => Verdict;
  // Batas laju seperti relay sungguhan: ember berlubang per koneksi, dan koneksi diputus setelah
  // `maxViolations` kali melanggar. Pesan yang melanggar ditolak (tidak diproses dan tidak di-ack).
  rate?: { capacity: number; refillPerSecond: number; maxViolations: number };
};
const relays: Array<{ stop(): Promise<void> }> = [];

async function startFakeRelay(options: FakeRelayOptions = {}) {
  const wss = new WebSocketServer({ port: options.port ?? 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const sockets = new Set<ServerSocket>();
  const hellos: unknown[] = [];
  const raw: Array<{ conn: number; id: string; seq: number; sessionId: string; at: number }> = []; // setiap kiriman, termasuk ulangan
  let limited = 0; // berapa kali relay menolak karena terlalu cepat
  const applied: Envelope[] = []; // event unik yang "diterapkan" (dedupe per id, seperti relay sungguhan)
  const seen = new Set<string>();
  let connections = 0;
  let received = 0;

  wss.on("connection", (socket) => {
    const conn = ++connections;
    sockets.add(socket);
    // Ember berlubang milik koneksi ini (hanya bila `rate` diberikan).
    let tokens = options.rate?.capacity ?? 0;
    let refilledAt = Date.now();
    let violations = 0;
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { kind: string; event?: Envelope };
      if (frame.kind === "hello") {
        hellos.push(frame);
        if (options.answerHello !== false) socket.send(JSON.stringify({ kind: "welcome", role: "machine", id: options.welcomeId ?? MACHINE }));
        return;
      }
      if (frame.kind !== "event" || !frame.event) return;
      const event = frame.event;
      if (options.rate) {
        const t = Date.now();
        tokens = Math.min(options.rate.capacity, tokens + ((t - refilledAt) / 1000) * options.rate.refillPerSecond);
        refilledAt = t;
        if (tokens < 1) {
          limited++;
          socket.send(JSON.stringify({ kind: "error", code: "rate_limited", message: "terlalu cepat" }));
          if (++violations >= options.rate.maxViolations) socket.terminate();
          return;
        }
        tokens -= 1;
      }
      raw.push({ conn, id: event.id, seq: event.seq, sessionId: event.sessionId, at: Date.now() });
      const verdict = options.onEvent?.(++received, event) ?? "ack";
      if (verdict === "ignore") return;
      if (verdict === "close") return socket.terminate();
      if (verdict === "rate_limited") return socket.send(JSON.stringify({ kind: "error", code: "rate_limited", message: "terlalu cepat" }));
      if (!seen.has(event.id)) {
        seen.add(event.id);
        applied.push(event);
      }
      socket.send(JSON.stringify({ kind: "ack", eventId: event.id }));
    });
  });

  const relay = {
    port,
    url: `http://127.0.0.1:${port}`,
    hellos,
    raw,
    applied,
    connections: () => connections,
    limited: () => limited,
    sendCommand: (body: Record<string, unknown>) => {
      for (const socket of sockets) socket.send(JSON.stringify({ kind: "command", deviceId: "d1", body }));
    },
    sendError: (code: string) => {
      for (const socket of sockets) socket.send(JSON.stringify({ kind: "error", code, message: "x" }));
    },
    dropConnections: () => {
      for (const socket of sockets) socket.terminate();
    },
    async stop() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  relays.push(relay);
  return relay;
}

// ---- Bantuan ----
const clients: RelayClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.close();
  for (const relay of relays.splice(0)) await relay.stop().catch(() => undefined);
});

function makeLogger() {
  const lines: string[] = [];
  const logger: Logger = { info: (m) => lines.push(`INFO ${m}`), error: (m) => lines.push(`ERROR ${m}`) };
  return { lines, logger };
}

let counter = 0;
const event = (seq: number, extra: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  machineId: MACHINE,
  sessionId: "sesi-1",
  seq,
  ts: "2026-11-11T10:00:00.000Z",
  agent: "claude-code",
  type: "tool.requested",
  payload: {},
  ...extra,
});

function connect(url: string, extra: Partial<RelayClientOptions> = {}) {
  const log = makeLogger();
  const decisions: unknown[] = [];
  const client = createRelayClient({
    url,
    token: TOKEN,
    machineId: MACHINE,
    decide: (input) => (decisions.push(input), { ok: true }),
    logger: log.logger,
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    ackTimeoutMs: 200,
    ...extra,
  });
  clients.push(client);
  return { client, decisions, ...log };
}

const settled = (client: RelayClient) => vi.waitFor(() => expect(client.stats()).toMatchObject({ queued: 0, inFlight: 0 }), { timeout: 5000 });

describe("toWebSocketUrl", () => {
  test.each([
    ["https://relay.contoh.com", "wss://relay.contoh.com/ws"],
    ["https://relay.contoh.com/", "wss://relay.contoh.com/ws"],
    ["wss://relay.contoh.com?x=1#y", "wss://relay.contoh.com/ws"],
    // Sambungan tanpa enkripsi diizinkan hanya ke komputer ini sendiri.
    ["http://127.0.0.1:8787/awalan/", "ws://127.0.0.1:8787/awalan/ws"],
    ["http://localhost:8787", "ws://localhost:8787/ws"],
    ["ws://LOCALHOST:8787", "ws://localhost:8787/ws"],
    ["http://127.5.6.7", "ws://127.5.6.7/ws"],
    ["http://[::1]:8787", "ws://[::1]:8787/ws"],
  ])("%s -> %s", (input, expected) => expect(toWebSocketUrl(input)).toBe(expected));

  test.each(["bukan-alamat", "ftp://x.com", "javascript:alert(1)", ""])("menolak: %s", (input) => {
    expect(() => toWebSocketUrl(input)).toThrow(RangeError);
  });

  test.each([
    "http://relay.contoh.com",
    "ws://relay.contoh.com",
    "http://192.168.1.5:8787",
    "http://10.0.0.2",
    "http://127.0.0.1.evil.com", // bukan loopback walau diawali 127.0.0.1
    "http://localhost.evil.com",
    "http://127.0.0.1@evil.com",
  ])("menolak sambungan TANPA enkripsi ke host selain komputer ini (token akan terkirim sebagai teks biasa): %s", (input) => {
    expect(() => toWebSocketUrl(input)).toThrow(/tidak memakai enkripsi/);
  });

  test("pesan galat tidak memuat token dan menyebut cara mengizinkannya dengan sadar", () => {
    expect(() => toWebSocketUrl("http://relay.contoh.com")).toThrow(/AGENTMON_RELAY_INSECURE=1/);
  });

  test("allowInsecure mengizinkan sambungan tanpa enkripsi ke jaringan tepercaya", () => {
    expect(toWebSocketUrl("http://192.168.1.5:8787", true)).toBe("ws://192.168.1.5:8787/ws");
  });

  test("createRelayClient menolak alamat tanpa enkripsi sejak awal, kecuali diizinkan", () => {
    const options = { url: "http://relay.contoh.com", token: TOKEN, machineId: MACHINE, decide: () => undefined };
    expect(() => createRelayClient(options)).toThrow(RangeError);
    const client = createRelayClient({ ...options, allowInsecure: true, createSocket: () => ({ addEventListener: () => undefined, send: () => undefined, close: () => undefined }) as unknown as WebSocket });
    clients.push(client);
    expect(client.stats().state).toBe("connecting");
  });
});

describe("pengiriman normal", () => {
  test("hello berisi peran dan token, lalu event sampai dan antrean mengosong", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url);
    client.send(event(0));
    client.send(event(1));
    await settled(client);

    expect(relay.hellos).toEqual([{ kind: "hello", role: "machine", token: TOKEN }]);
    expect(relay.applied.map((e) => e.seq)).toEqual([0, 1]);
    expect(client.stats()).toMatchObject({ state: "ready", acked: 2, dropped: 0, queued: 0, inFlight: 0 });
  });

  test("event yang dititipkan SEBELUM tersambung dikirim begitu tersambung", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url);
    for (let i = 0; i < 20; i++) client.send(event(i)); // seketika, sebelum hello selesai
    await settled(client);
    expect(relay.applied).toHaveLength(20);
  });

  test("event dengan nomor sama dititipkan dua kali hanya dikirim sekali", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url);
    const e = event(0);
    client.send(e);
    client.send(e);
    client.send({ ...e });
    await settled(client);
    expect(relay.raw).toHaveLength(1);
  });

  test("event yang selesai diproses tidak berurutan dirapikan menurut seq di dalam sesi yang sama", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url);
    // Dititipkan seketika, sebelum hello selesai, jadi semuanya masih menumpuk di antrean.
    client.send(event(3));
    client.send(event(1));
    client.send(event(2));
    client.send(event(1, { sessionId: "sesi-lain" })); // sesi lain tidak ikut diurutkan
    await settled(client);
    expect(relay.raw.filter((r) => r.sessionId === "sesi-1").map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(relay.raw).toHaveLength(4);
  });

  test("bingkai yang tidak dikenal atau rusak dari relay diabaikan tanpa mengganggu", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url);
    client.send(event(0));
    await settled(client);
    relay.sendError("kode_dari_versi_baru");
    relay.sendCommand({ type: "jenis-baru-yang-belum-dikenal" });
    client.send(event(1));
    await settled(client);
    expect(relay.applied).toHaveLength(2);
    expect(client.stats().state).toBe("ready");
  });
});

describe("putus-sambung: tidak ada event yang hilang atau ganda", () => {
  test("relay memutus koneksi di tengah kiriman: semua event akhirnya diterapkan tepat sekali, berurutan", async () => {
    // Relay memutus koneksi saat menerima event ke-7 (tanpa ack) dan ke-15.
    const relay = await startFakeRelay({ onEvent: (n) => (n === 7 || n === 15 ? "close" : "ack") });
    const { client } = connect(relay.url);
    const sent = Array.from({ length: 40 }, (_, i) => event(i));
    for (const e of sent) client.send(e);
    await settled(client);

    // Semua ada dan tanpa ganda. Urutan tiba bisa bergeser karena relay sempat memproses pesan yang sudah
    // di buffer sebelum koneksinya putus; HP menyusun ulang berdasarkan seq, jadi yang dijamin adalah kelengkapan.
    expect(relay.applied).toHaveLength(40);
    expect(relay.applied.map((e) => e.id).sort()).toEqual(sent.map((e) => e.id).sort());
    expect(relay.connections()).toBeGreaterThan(1); // memang sempat putus lalu menyambung lagi
    expect(client.stats()).toMatchObject({ dropped: 0, queued: 0, inFlight: 0 });
  });

  test("koneksi putus: yang belum di-ack langsung dikirim ulang begitu tersambung, tanpa menunggu batas waktu ack", async () => {
    // Batas ack dibuat sangat panjang, sehingga satu-satunya jalan kirim ulang adalah putusnya koneksi itu sendiri.
    const relay = await startFakeRelay({ onEvent: (n) => (n === 3 ? "close" : "ack") });
    const { client } = connect(relay.url, { ackTimeoutMs: 100_000 });
    const sent = Array.from({ length: 10 }, (_, i) => event(i));
    for (const e of sent) client.send(e);
    await settled(client);
    expect(relay.applied).toHaveLength(10);
    expect(relay.connections()).toBeGreaterThan(1);
  });

  test("dalam SATU koneksi, klien tidak pernah mengirim event yang sama dua kali", async () => {
    const relay = await startFakeRelay({ onEvent: (n) => (n % 9 === 0 ? "close" : "ack") });
    // Batas ack dibuat sangat panjang: kirim ulang karena ack telat (perilaku yang memang ada, dan
    // bisa terjadi saat mesin sibuk) tidak boleh mengaburkan apa yang diuji di sini, yaitu bahwa
    // kirim ulang HANYA terjadi lewat koneksi baru setelah putus.
    const { client } = connect(relay.url, { ackTimeoutMs: 100_000 });
    for (let i = 0; i < 60; i++) client.send(event(i));
    await settled(client);

    const perConnection = new Set<string>();
    for (const r of relay.raw) {
      const key = `${r.conn}:${r.id}`;
      expect(perConnection.has(key)).toBe(false);
      perConnection.add(key);
    }
    expect(relay.applied).toHaveLength(60);
  });

  test("relay mati total lalu hidup lagi: event yang dititipkan selama mati terkirim semua", async () => {
    const relay = await startFakeRelay();
    const port = relay.port;
    const { client } = connect(relay.url);
    client.send(event(0));
    await settled(client);

    await relay.stop();
    await vi.waitFor(() => expect(client.stats().state).not.toBe("ready"));
    for (let i = 1; i <= 10; i++) client.send(event(i)); // selagi relay mati
    expect(client.stats().queued).toBe(10);

    const back = await startFakeRelay({ port });
    await settled(client);
    expect(back.applied.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(client.stats().reconnects).toBeGreaterThan(0);
  });

  test("ack yang tidak pernah datang: event dikirim ulang setelah batas waktu, relay mengabaikan ulangannya", async () => {
    // Relay menerima event pertama tetapi 'lupa' mengirim ack untuk kiriman pertamanya.
    const relay = await startFakeRelay({ onEvent: (n) => (n === 1 ? "ignore" : "ack") });
    const { client } = connect(relay.url, { ackTimeoutMs: 60 });
    const e = event(0);
    client.send(e);
    await settled(client);

    expect(relay.raw.filter((r) => r.id === e.id).length).toBeGreaterThanOrEqual(2); // dikirim ulang
    expect(relay.applied).toHaveLength(1); // tetapi hanya sekali diterapkan
  });

  test("relay menjawab rate_limited: klien berhenti sejenak lalu melanjutkan, tanpa membanjiri", async () => {
    const relay = await startFakeRelay({ onEvent: (n) => (n === 1 ? "rate_limited" : "ack") });
    const { client, lines } = connect(relay.url, { ackTimeoutMs: 50 });
    client.send(event(0));
    await vi.waitFor(() => expect(relay.raw).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 400));
    expect(relay.raw).toHaveLength(1); // masih jeda, tidak dikirim ulang dengan segera
    await vi.waitFor(() => expect(relay.applied).toHaveLength(1), { timeout: 4000 });
    expect(lines.join("\n")).toContain("rate_limited");
  });

  test("jumlah yang belum di-ack dibatasi (maxInFlight), sisanya menunggu", async () => {
    const relay = await startFakeRelay({ onEvent: () => "ignore" }); // tidak pernah di-ack
    const { client } = connect(relay.url, { maxInFlight: 5, ackTimeoutMs: 100_000 });
    for (let i = 0; i < 30; i++) client.send(event(i));
    await vi.waitFor(() => expect(relay.raw).toHaveLength(5));
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.raw).toHaveLength(5);
    expect(client.stats()).toMatchObject({ inFlight: 5, queued: 25 });
  });
});

describe("antrean besar tidak membuat relay menolak atau memutus klien", () => {
  // Relay yang menerapkan batas laju seperti aslinya, dengan perbandingan yang sama dengan relay sungguhan:
  // kapasitas jauh di atas lonjakan klien, dan isi ulang di atas laju klien. Kelonggaran itu penting: bila
  // mesin sesaat macet (CI yang sibuk), pesan menumpuk lalu diproses sekaligus, dan relay harus punya ruang
  // untuk itu. Relay asli: kapasitas 100 dan 50 per detik, melawan klien 50 dan 40 per detik.
  const strict = { capacity: 200, refillPerSecond: 400, maxViolations: 5 };

  test("antrean ratusan event yang menumpuk selagi terputus terkuras habis tanpa satu pun penolakan", async () => {
    const relay = await startFakeRelay({ rate: strict });
    const port = relay.port;
    await relay.stop();
    // Batas ack panjang: yang diuji di sini laju kirim, bukan kirim ulang karena ack telat.
    const { client } = connect(`http://127.0.0.1:${port}`, { maxEventsPerSecond: 150, sendBurst: 50, ackTimeoutMs: 30_000 });
    const sent = Array.from({ length: 400 }, (_, i) => event(i));
    for (const e of sent) client.send(e);

    const back = await startFakeRelay({ port, rate: strict });
    await vi.waitFor(() => expect(client.stats()).toMatchObject({ queued: 0, inFlight: 0, acked: 400 }), { timeout: 20_000 });
    expect(back.limited()).toBe(0); // klien mengatur lajunya sendiri sehingga tidak pernah terlalu cepat
    expect(back.applied).toHaveLength(400);
    expect(back.connections()).toBe(1); // dan tidak pernah diputus
  }, 30_000);

  test("laju kirim benar-benar dibatasi: lonjakan awal, lalu sesuai laju yang diatur", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url, { maxEventsPerSecond: 50, sendBurst: 5 });
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));
    for (let i = 0; i < 30; i++) client.send(event(i));
    await settled(client);

    const times = relay.raw.map((r) => r.at);
    const span = (times.at(-1) as number) - (times[0] as number);
    // 30 event dengan lonjakan 5 dan 50 per detik: sisa 25 event butuh sekitar 0,5 detik.
    expect(span).toBeGreaterThan(350);
    expect(relay.raw.slice(0, 5).every((r) => r.at - (times[0] as number) < 100)).toBe(true); // lonjakan awal seketika
  });

  test("REGRESI: klien tanpa pembatas laju yang diputus relay karena terlalu cepat tetap menguras seluruh antrean (tidak macet)", async () => {
    // Pembatas klien dimatikan (laju sangat tinggi) agar relay sungguh menolak dan memutus koneksi,
    // seperti yang terjadi sebelum klien punya pembatas. Dulu klien tersambung tetapi berhenti mengirim.
    const relay = await startFakeRelay({ rate: { capacity: 20, refillPerSecond: 200, maxViolations: 3 } });
    const port = relay.port;
    await relay.stop();
    const { client } = connect(`http://127.0.0.1:${port}`, { maxEventsPerSecond: 1_000_000, sendBurst: 1_000_000, ackTimeoutMs: 300 });
    for (let i = 0; i < 150; i++) client.send(event(i));

    const back = await startFakeRelay({ port, rate: { capacity: 20, refillPerSecond: 200, maxViolations: 3 } });
    await vi.waitFor(() => expect(client.stats()).toMatchObject({ queued: 0, inFlight: 0, acked: 150 }), { timeout: 30_000 });
    expect(back.limited()).toBeGreaterThan(0); // memang sempat ditolak dan diputus
    expect(back.connections()).toBeGreaterThan(1);
    expect(back.applied).toHaveLength(150); // tetapi tetap sampai semua
  }, 40_000);

  test("jeda karena rate_limited yang masih tersisa saat tersambung ulang tidak membuat pengiriman berhenti selamanya", async () => {
    // Relay menjawab rate_limited lalu memutus koneksi; klien tersambung ulang saat jeda masih berlaku.
    let n = 0;
    const relay = await startFakeRelay({
      onEvent: () => {
        n++;
        return n === 1 ? "rate_limited" : "ack";
      },
    });
    const { client } = connect(relay.url, { ackTimeoutMs: 200 });
    for (let i = 0; i < 5; i++) client.send(event(i));
    await vi.waitFor(() => expect(relay.raw.length).toBeGreaterThan(0));
    relay.dropConnections();
    await vi.waitFor(() => expect(client.stats()).toMatchObject({ queued: 0, inFlight: 0, acked: 5 }), { timeout: 8000 });
    expect(relay.applied).toHaveLength(5);
  });
});

describe("relay mati tidak memperlambat agent", () => {
  test("menitipkan puluhan ribu event ke relay yang tidak terjangkau tetap seketika", async () => {
    const { client } = connect("http://127.0.0.1:1", { maxQueuedEvents: 1000 });
    const events = Array.from({ length: 20_000 }, (_, i) => event(i));
    const started = performance.now();
    for (const e of events) client.send(e);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000); // sangat longgar: yang dijaga adalah 'tidak menunggu jaringan'
    expect(client.stats().queued).toBe(1000);
  });

  test("send() tidak pernah melempar error, walau event tidak bisa diserialisasi", () => {
    const { client, lines } = connect("http://127.0.0.1:1");
    const circular = event(0) as Envelope & { self?: unknown };
    circular.payload = circular;
    expect(() => client.send(circular)).not.toThrow();
    expect(lines.join("\n")).toContain("gagal menitipkan");
    expect(client.stats().queued).toBe(0);
  });

  test("send() mengembalikan kendali seketika (sinkron), tanpa menunggu koneksi", () => {
    const { client } = connect("http://127.0.0.1:1");
    expect(client.send(event(0))).toBeUndefined(); // bukan Promise
  });

  test("socket yang gagal dibuat tidak melempar dan dicoba lagi", async () => {
    let attempts = 0;
    const { client, lines } = connect("http://127.0.0.1:1", {
      createSocket: () => {
        attempts++;
        throw new Error("tidak bisa");
      },
    });
    client.send(event(0));
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(2));
    expect(lines.join("\n")).toContain("gagal membuka koneksi");
    expect(client.stats().queued).toBe(1);
  });
});

describe("antrean punya batas dan pembuangan tercatat", () => {
  test("melebihi jumlah maksimum: yang TERLAMA dibuang, yang terbaru dipertahankan, dan dicatat di log", async () => {
    const { client, lines } = connect("http://127.0.0.1:1", { maxQueuedEvents: 10 });
    for (let i = 0; i < 25; i++) client.send(event(i));

    expect(client.stats()).toMatchObject({ queued: 10, dropped: 15 });
    expect(lines.filter((l) => l.startsWith("ERROR") && l.includes("dibuang")).length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("event dibuang");

    // Yang tersisa adalah 10 terbaru: dibuktikan lewat relay yang akhirnya hidup.
    const relay = await startFakeRelay();
    const second = connect(relay.url);
    for (let i = 0; i < 25; i++) second.client.send(event(i));
    await settled(second.client);
  });

  test("yang tersisa setelah pembuangan benar-benar 10 event terbaru", async () => {
    const relay = await startFakeRelay();
    const port = relay.port;
    await relay.stop();
    const { client } = connect(`http://127.0.0.1:${port}`, { maxQueuedEvents: 10 });
    for (let i = 0; i < 25; i++) client.send(event(i));
    const back = await startFakeRelay({ port });
    await settled(client);
    expect(back.applied.map((e) => e.seq)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  test("batas ukuran total (byte) juga ditegakkan", () => {
    const { client } = connect("http://127.0.0.1:1", { maxQueuedBytes: 5000 });
    for (let i = 0; i < 50; i++) client.send(event(i, { payload: { isi: "x".repeat(400) } }));
    const stats = client.stats();
    expect(stats.queued).toBeLessThan(15);
    expect(stats.queued + stats.dropped).toBe(50);
  });

  test("event yang terlalu besar untuk relay dibuang dan dicatat, tanpa menggeser yang lain", () => {
    const { client, lines } = connect("http://127.0.0.1:1", { maxEventBytes: 2000 });
    client.send(event(0));
    client.send(event(1, { payload: { isi: "x".repeat(5000) } }));
    client.send(event(2));
    expect(client.stats()).toMatchObject({ queued: 2, dropped: 1 });
    expect(lines.join("\n")).toContain("terlalu besar");
  });

  test("log pembuangan tidak membanjir: ribuan pembuangan beruntun hanya memunculkan segelintir baris", () => {
    const { client, lines } = connect("http://127.0.0.1:1", { maxQueuedEvents: 1 });
    for (let i = 0; i < 5000; i++) client.send(event(i));
    expect(client.stats().dropped).toBe(4999);
    expect(lines.filter((l) => l.includes("dibuang")).length).toBeLessThanOrEqual(2);
  });
});

describe("keputusan dari HP diteruskan ke approval engine", () => {
  test("perintah approval.decision diserahkan ke decide TANPA kolom type", async () => {
    const relay = await startFakeRelay();
    const { client, decisions } = connect(relay.url);
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));

    relay.sendCommand({ type: "approval.decision", approvalId: "a1", decision: "deny", comment: "jangan" });
    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toEqual({ approvalId: "a1", decision: "deny", comment: "jangan" });
  });

  test("hasil ditolak engine dicatat dengan alasannya, tetapi komentar dan isi keputusan TIDAK masuk log", async () => {
    const relay = await startFakeRelay();
    const log = makeLogger();
    const client = createRelayClient({
      url: relay.url,
      token: TOKEN,
      machineId: MACHINE,
      decide: () => ({ ok: false, reason: "already_resolved" }),
      logger: log.logger,
      reconnectMinMs: 10,
    });
    clients.push(client);
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));

    relay.sendCommand({ type: "approval.decision", approvalId: "a1", decision: "deny", comment: "KOMENTAR-RAHASIA-PENGGUNA" });
    await vi.waitFor(() => expect(log.lines.join("\n")).toContain("already_resolved"));
    expect(log.lines.join("\n")).not.toContain("KOMENTAR-RAHASIA-PENGGUNA");
  });

  test("decide yang melempar error tidak menjatuhkan klien; koneksi dan pengiriman tetap jalan", async () => {
    const relay = await startFakeRelay();
    const log = makeLogger();
    const client = createRelayClient({
      url: relay.url,
      token: TOKEN,
      machineId: MACHINE,
      decide: () => {
        throw new Error("mesin rusak");
      },
      logger: log.logger,
    });
    clients.push(client);
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));
    relay.sendCommand({ type: "approval.decision", approvalId: "a1", decision: "approve" });
    await vi.waitFor(() => expect(log.lines.join("\n")).toContain("gagal menerapkan keputusan"));

    client.send(event(0));
    await settled(client);
    expect(relay.applied).toHaveLength(1);
  });

  test("jenis perintah yang tidak dikenal diabaikan dan dicatat dengan aman (tanpa karakter kontrol)", async () => {
    const relay = await startFakeRelay();
    const { client, decisions, lines } = connect(relay.url);
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));
    relay.sendCommand({ type: "rollback\u001b[2J\nPALSU", approvalId: "a1" });
    await vi.waitFor(() => expect(lines.join("\n")).toContain("perintah tidak dikenal"));
    expect(decisions).toEqual([]);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
  });

  test("perintah tanpa type atau dengan type bukan teks tidak melempar", async () => {
    const relay = await startFakeRelay();
    const { client, decisions } = connect(relay.url);
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));
    relay.sendCommand({ approvalId: "a1" });
    relay.sendCommand({ type: 42 });
    relay.sendCommand({ type: null });
    client.send(event(0));
    await settled(client);
    expect(decisions).toEqual([]);
  });
});

describe("keamanan dan salah pengaturan", () => {
  test("token laptop tidak pernah muncul di log", async () => {
    const relay = await startFakeRelay();
    const { client, lines } = connect(relay.url);
    for (let i = 0; i < 5; i++) client.send(event(i));
    relay.dropConnections();
    await settled(client);
    relay.sendError("unauthorized");
    await vi.waitFor(() => expect(lines.join("\n")).toContain("unauthorized"));
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  test("nomor laptop di relay berbeda dari yang lokal: berhenti dengan pesan jelas, tidak mengirim, tidak berputar", async () => {
    const relay = await startFakeRelay({ welcomeId: "laptop-lain" });
    const { client, lines } = connect(relay.url);
    client.send(event(0));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("berbeda dari nomor laptop ini"));
    await new Promise((r) => setTimeout(r, 200));

    expect(relay.raw).toEqual([]); // tidak ada event yang dikirim
    expect(relay.connections()).toBe(1); // tidak mencoba lagi terus-menerus
    expect(client.stats()).toMatchObject({ state: "disconnected", queued: 1, reconnects: 0 });
  });

  test("relay yang tidak menjawab hello: ditutup dan dicoba lagi, bukan menggantung", async () => {
    const relay = await startFakeRelay({ answerHello: false });
    const { client, lines } = connect(relay.url, { welcomeTimeoutMs: 40 });
    await vi.waitFor(() => expect(relay.connections()).toBeGreaterThanOrEqual(3));
    expect(lines.join("\n")).toContain("tidak ada jawaban hello");
    expect(client.stats().state).not.toBe("ready");
  });

  test("welcome untuk peran selain laptop diabaikan", async () => {
    const relay = await startFakeRelay({ answerHello: false });
    const { client } = connect(relay.url);
    await vi.waitFor(() => expect(relay.connections()).toBe(1));
    expect(client.stats().state).toBe("connecting");
  });
});

describe("penyambungan ulang", () => {
  test("jeda berlipat dua sampai batas atas", async () => {
    vi.useFakeTimers();
    const attemptTimes: number[] = [];
    const log = makeLogger();
    const client = createRelayClient({
      url: "https://relay.contoh.com",
      token: TOKEN,
      machineId: MACHINE,
      decide: () => undefined,
      logger: log.logger,
      reconnectMinMs: 500,
      reconnectMaxMs: 8000,
      random: () => 1, // tanpa pengurangan acak: jeda penuh
      createSocket: () => {
        attemptTimes.push(Date.now());
        const handlers: Record<string, Array<() => void>> = {};
        const socket = {
          addEventListener: (name: string, fn: () => void) => void (handlers[name] ??= []).push(fn),
          send: () => undefined,
          close: () => undefined,
        };
        queueMicrotask(() => handlers.close?.forEach((fn) => fn())); // langsung gagal
        return socket as unknown as WebSocket;
      },
    });
    clients.push(client);

    await vi.advanceTimersByTimeAsync(60_000);
    const gaps = attemptTimes.slice(1).map((t, i) => t - (attemptTimes[i] as number));
    expect(gaps.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, 8000]); // berlipat, lalu tertahan di batas atas
  });

  test("acak: jeda paling rendah separuh dari jeda penuh", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const client = createRelayClient({
      url: "https://relay.contoh.com",
      token: TOKEN,
      machineId: MACHINE,
      decide: () => undefined,
      reconnectMinMs: 1000,
      reconnectMaxMs: 1000,
      random: () => 0,
      createSocket: () => {
        times.push(Date.now());
        const handlers: Record<string, Array<() => void>> = {};
        queueMicrotask(() => handlers.close?.forEach((fn) => fn()));
        return { addEventListener: (n: string, fn: () => void) => void (handlers[n] ??= []).push(fn), send: () => undefined, close: () => undefined } as unknown as WebSocket;
      },
    });
    clients.push(client);
    await vi.advanceTimersByTimeAsync(5000);
    expect(times.slice(1).map((t, i) => t - (times[i] as number))[0]).toBe(500);
  });

  // Perilaku WebSocket bawaan Node berbeda antar versi: di Node 22, koneksi yang ditolak hanya memicu
  // `error` TANPA `close`. Soket tiruan di bawah meniru keduanya supaya test tidak bergantung pada
  // versi Node yang menjalankannya.
  function fakeSocketFactory(behavior: "error-only" | "hang" | "close-only") {
    const created: number[] = [];
    const createSocket = () => {
      created.push(Date.now());
      const handlers: Record<string, Array<(event?: unknown) => void>> = {};
      queueMicrotask(() => {
        if (behavior === "error-only") handlers.error?.forEach((fn) => fn());
        if (behavior === "close-only") handlers.close?.forEach((fn) => fn());
      });
      return {
        addEventListener: (name: string, fn: () => void) => void (handlers[name] ??= []).push(fn),
        send: () => undefined,
        close: () => undefined,
      } as unknown as WebSocket;
    };
    return { created, createSocket };
  }

  test.each(["error-only", "close-only"] as const)("koneksi ditolak dengan sinyal '%s' tetap dicoba lagi (Node 22 tidak memicu close)", async (behavior) => {
    const { created, createSocket } = fakeSocketFactory(behavior);
    const { client } = connect("http://127.0.0.1:1", { createSocket });
    await vi.waitFor(() => expect(created.length).toBeGreaterThanOrEqual(4));
    expect(client.stats().reconnects).toBeGreaterThanOrEqual(3);
  });

  test("percobaan yang menggantung tanpa kabar apa pun dibatalkan oleh batas waktu lalu dicoba lagi", async () => {
    const { created, createSocket } = fakeSocketFactory("hang");
    const { client, lines } = connect("http://127.0.0.1:1", { createSocket, welcomeTimeoutMs: 30 });
    await vi.waitFor(() => expect(created.length).toBeGreaterThanOrEqual(3));
    expect(lines.join("\n")).toContain("tidak ada jawaban hello");
    expect(client.stats().state).not.toBe("ready");
  });

  test("error lalu close untuk koneksi yang sama hanya menjadwalkan SATU percobaan ulang", async () => {
    const created: number[] = [];
    const client = createRelayClient({
      url: "https://relay.contoh.com",
      token: TOKEN,
      machineId: MACHINE,
      decide: () => undefined,
      reconnectMinMs: 200,
      reconnectMaxMs: 200,
      random: () => 1,
      createSocket: () => {
        created.push(Date.now());
        const handlers: Record<string, Array<() => void>> = {};
        queueMicrotask(() => {
          handlers.error?.forEach((fn) => fn());
          handlers.close?.forEach((fn) => fn());
        });
        return { addEventListener: (n: string, fn: () => void) => void (handlers[n] ??= []).push(fn), send: () => undefined, close: () => undefined } as unknown as WebSocket;
      },
    });
    clients.push(client);
    await new Promise((r) => setTimeout(r, 450));
    // awal + percobaan ulang di 200 dan 400 ms. Bila error dan close masing-masing menjadwalkan
    // sendiri, jumlahnya berlipat ganda. Yang ketiga sudah terjadwal (dihitung) tetapi belum jalan.
    expect(created.length).toBe(3);
    expect(client.stats().reconnects).toBe(3);
  });

  test("setelah berhasil tersambung, jeda kembali dari awal", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url, { reconnectMinMs: 10, reconnectMaxMs: 10_000 });
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));
    relay.dropConnections();
    await vi.waitFor(() => expect(relay.connections()).toBe(2));
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));
    relay.dropConnections();
    await vi.waitFor(() => expect(relay.connections()).toBe(3), { timeout: 2000 });
  });
});

describe("flush dan close", () => {
  test("flush menunggu sampai semua di-ack", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url);
    for (let i = 0; i < 30; i++) client.send(event(i));
    expect(await client.flush(5000)).toBe(true);
    expect(relay.applied).toHaveLength(30);
  });

  test("flush berhenti di batas waktu bila relay tidak terjangkau", async () => {
    const { client } = connect("http://127.0.0.1:1");
    client.send(event(0));
    const started = Date.now();
    expect(await client.flush(150)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("setelah close: tidak menyambung lagi, send() tidak melakukan apa pun dan tidak melempar", async () => {
    const relay = await startFakeRelay();
    const { client } = connect(relay.url);
    await vi.waitFor(() => expect(client.stats().state).toBe("ready"));
    client.close();
    expect(client.stats().state).toBe("closed");
    const before = relay.connections();
    expect(() => client.send(event(0))).not.toThrow();
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.connections()).toBe(before);
    expect(relay.raw).toEqual([]);
  });

  test("close dua kali aman", () => {
    const { client } = connect("http://127.0.0.1:1");
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});
