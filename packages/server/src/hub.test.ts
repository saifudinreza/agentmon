import type { ServerFrame } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { createMemoryDirectory, type RelayDirectory } from "./directory";
import { CLOSE, createRelayHub, type RelayHub, type RelayHubOptions, type RelaySession } from "./hub";
import type { Logger } from "./logger";

const TOKENS = {
  m1: "machine-token-satu-0000000000000000",
  m2: "machine-token-dua-00000000000000000",
  d1: "device-token-satu-00000000000000000",
  d2: "device-token-dua-000000000000000000",
  d3: "device-token-tiga-00000000000000000",
};

// Tiga HP dan dua laptop. m1 dipasangkan dengan d1 dan d2; m2 hanya dengan d3.
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

// Koneksi tiruan: mencatat apa yang dikirim hub kepadanya dan bagaimana ia ditutup.
function fakeConnection() {
  const sent: ServerFrame[] = [];
  const state: { closed?: { code: number; reason: string }; throwOnSend: boolean; buffered: number } = { throwOnSend: false, buffered: 0 };
  return {
    sent,
    state,
    conn: {
      send(text: string) {
        if (state.throwOnSend) throw new Error("soket putus");
        sent.push(JSON.parse(text) as ServerFrame);
      },
      close(code: number, reason: string) {
        state.closed = { code, reason };
      },
      // Antrean kirim yang bisa diatur test, untuk meniru penerima yang membaca lambat.
      bufferedAmount: () => state.buffered,
    },
    errors: () => sent.filter((f): f is Extract<ServerFrame, { kind: "error" }> => f.kind === "error").map((f) => f.code),
    events: () => sent.filter((f) => f.kind === "event"),
    commands: () => sent.filter((f) => f.kind === "command"),
  };
}
function setup(options: Partial<RelayHubOptions> = {}) {
  const logs: string[] = [];
  const logger: Logger = { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) };
  const clock = { ms: 1_000_000 };
  const memory = makeDirectory(); // untuk test yang mencabut pemasangan di tengah jalan
  const hub = createRelayHub({ directory: options.directory ?? memory, logger, now: () => clock.ms, ...options });
  return { hub, logs, clock, directory: memory };
}

const send = (session: RelaySession, frame: unknown) => session.receive(JSON.stringify(frame));

// Menyambungkan satu pihak dan menyelesaikan `hello`.
async function connect(hub: RelayHub, role: "machine" | "device", token: string) {
  const fake = fakeConnection();
  const session = hub.accept(fake.conn);
  await send(session, { kind: "hello", role, token });
  return { fake, session };
}

// Tiap event mendapat nomor unik, seperti event sungguhan. Relay mengabaikan nomor yang sama
// sebagai kiriman ulang, jadi test yang ingin meniru kiriman ulang harus memberi `id` yang sama.
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

describe("autentikasi", () => {
  test("hello dengan token benar -> welcome berisi peran dan nomor", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    expect(m1.fake.sent).toEqual([{ kind: "welcome", role: "machine", id: "m1" }]);
    expect(d1.fake.sent).toEqual([{ kind: "welcome", role: "device", id: "d1" }]);
    expect(hub.stats()).toEqual({ connections: 2, machines: 1, devices: 1 });
  });

  test("token salah -> unauthorized dan koneksi ditutup", async () => {
    const { hub } = setup();
    const bad = await connect(hub, "machine", "token-yang-salah-0000000000000000");
    expect(bad.fake.errors()).toEqual(["unauthorized"]);
    expect(bad.fake.state.closed?.code).toBe(CLOSE.unauthorized);
    expect(hub.stats().connections).toBe(0);
  });

  test("token HP tidak bisa dipakai sebagai laptop, dan sebaliknya", async () => {
    const { hub } = setup();
    expect((await connect(hub, "machine", TOKENS.d1)).fake.errors()).toEqual(["unauthorized"]);
    expect((await connect(hub, "device", TOKENS.m1)).fake.errors()).toEqual(["unauthorized"]);
  });

  test("mengirim pesan sebelum hello -> unauthenticated dan koneksi ditutup", async () => {
    const { hub } = setup();
    const fake = fakeConnection();
    await send(hub.accept(fake.conn), { kind: "event", event: envelope("m1") });
    expect(fake.errors()).toEqual(["unauthenticated"]);
    expect(fake.state.closed?.code).toBe(CLOSE.unauthenticated);
  });

  test("hello dua kali -> ditolak, koneksi pertama tetap hidup", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, { kind: "hello", role: "machine", token: TOKENS.m1 });
    expect(m1.fake.errors()).toEqual(["already_authenticated"]);
    expect(m1.fake.state.closed).toBeUndefined();
  });

  test("direktori yang error diperlakukan sebagai DITOLAK (gagal tertutup), bukan diloloskan", async () => {
    const broken: RelayDirectory = {
      authenticate: () => Promise.reject(new Error("database mati")),
      devicesOf: () => Promise.resolve([]),
      isPaired: () => Promise.resolve(true),
    };
    const { hub, logs } = setup({ directory: broken });
    const result = await connect(hub, "machine", TOKENS.m1);
    expect(result.fake.errors()).toEqual(["unauthorized"]);
    expect(result.fake.state.closed).toBeDefined();
    expect(logs.join("\n")).toContain("database mati");
  });

  test("koneksi yang putus selagi token diperiksa tidak terdaftar", async () => {
    let release: (id: string | undefined) => void = () => undefined;
    const slow: RelayDirectory = {
      authenticate: () => new Promise((resolve) => (release = resolve)),
      devicesOf: () => Promise.resolve([]),
      isPaired: () => Promise.resolve(true),
    };
    const { hub } = setup({ directory: slow });
    const fake = fakeConnection();
    const session = hub.accept(fake.conn);
    const pending = send(session, { kind: "hello", role: "machine", token: TOKENS.m1 });
    session.closed(); // putus sebelum pemeriksaan selesai
    release("m1");
    await pending;
    expect(hub.stats()).toEqual({ connections: 0, machines: 0, devices: 0 });
    expect(fake.sent).toEqual([]);
  });

  test("koneksi baru dari pihak yang sama menggantikan yang lama", async () => {
    const { hub } = setup();
    const first = await connect(hub, "device", TOKENS.d1);
    const second = await connect(hub, "device", TOKENS.d1);
    expect(first.fake.errors()).toEqual(["replaced"]);
    expect(first.fake.state.closed?.code).toBe(CLOSE.replaced);
    expect(second.fake.state.closed).toBeUndefined();
    expect(hub.stats().devices).toBe(1);

    // Hanya koneksi baru yang menerima.
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(first.fake.events()).toHaveLength(0);
    expect(second.fake.events()).toHaveLength(1);
  });
});

describe("meneruskan event: hanya ke pihak yang dipasangkan", () => {
  test("event dari laptop sampai ke SEMUA HP yang dipasangkan dengannya", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const d2 = await connect(hub, "device", TOKENS.d2);

    await send(m1.session, { kind: "event", event: envelope("m1") });

    for (const device of [d1, d2]) {
      expect(device.fake.events()).toEqual([{ kind: "event", event: expect.objectContaining({ machineId: "m1", type: "tool.requested" }) }]);
    }
  });

  test("HP yang TIDAK dipasangkan tidak menerima apa pun, walau tersambung", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1); // dipasangkan dengan m1
    const d3 = await connect(hub, "device", TOKENS.d3); // dipasangkan dengan m2, BUKAN m1

    await send(m1.session, { kind: "event", event: envelope("m1") });
    await send(m1.session, { kind: "event", event: envelope("m1", { seq: 1 }) });

    expect(d1.fake.events()).toHaveLength(2);
    expect(d3.fake.sent).toEqual([{ kind: "welcome", role: "device", id: "d3" }]); // hanya sambutan
  });

  test("dua laptop dengan HP masing-masing tidak saling bocor", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const m2 = await connect(hub, "machine", TOKENS.m2);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const d3 = await connect(hub, "device", TOKENS.d3);

    await send(m1.session, { kind: "event", event: envelope("m1", { sessionId: "milik-m1" }) });
    await send(m2.session, { kind: "event", event: envelope("m2", { sessionId: "milik-m2" }) });

    expect(JSON.stringify(d1.fake.events())).toContain("milik-m1");
    expect(JSON.stringify(d1.fake.events())).not.toContain("milik-m2");
    expect(JSON.stringify(d3.fake.events())).toContain("milik-m2");
    expect(JSON.stringify(d3.fake.events())).not.toContain("milik-m1");
  });

  test("laptop tidak bisa menyamar sebagai laptop lain (machineId harus sama dengan identitasnya)", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d3 = await connect(hub, "device", TOKENS.d3);

    await send(m1.session, { kind: "event", event: envelope("m2") }); // berpura-pura m2

    expect(m1.fake.errors()).toEqual(["forbidden"]);
    expect(d3.fake.events()).toHaveLength(0);
  });

  test("HP tidak boleh mengirim event", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(d1.session, { kind: "event", event: envelope("m1") });
    expect(d1.fake.errors()).toEqual(["forbidden"]);
    expect(m1.fake.events()).toHaveLength(0);
  });

  test("tanpa HP yang tersambung, event dibuang tanpa galat", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(m1.fake.errors()).toEqual([]);
  });

  test("pencabutan pemasangan langsung berlaku pada pesan berikutnya", async () => {
    const { hub, directory } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(d1.fake.events()).toHaveLength(1);

    directory.unpair("m1", "d1");
    await send(m1.session, { kind: "event", event: envelope("m1", { seq: 1 }) });
    expect(d1.fake.events()).toHaveLength(1); // tidak bertambah
  });

  test("isi terenkripsi (payload bukan objek) diteruskan apa adanya tanpa dibuka", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(m1.session, { kind: "event", event: envelope("m1", { payload: "Y2lwaGVydGV4dA==" }) });
    expect(d1.fake.events()[0]).toMatchObject({ event: { payload: "Y2lwaGVydGV4dA==" } });
  });

  test("urutan pesan dari satu koneksi dipertahankan", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await Promise.all([0, 1, 2, 3, 4].map((seq) => send(m1.session, { kind: "event", event: envelope("m1", { seq }) })));
    expect(d1.fake.events().map((f) => (f as { event: { seq: number } }).event.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("meneruskan perintah dari HP ke laptop", () => {
  test("perintah dari HP sampai ke laptop yang dipasangkan, lengkap dengan nomor pengirim", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(d1.session, { kind: "command", machineId: "m1", body: { decision: "approve" } });
    expect(m1.fake.commands()).toEqual([{ kind: "command", deviceId: "d1", body: { decision: "approve" } }]);
  });

  test("perintah ke laptop yang TIDAK dipasangkan ditolak, dan laptop itu tidak menerima apa pun", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d3 = await connect(hub, "device", TOKENS.d3); // dipasangkan dengan m2, bukan m1
    await send(d3.session, { kind: "command", machineId: "m1", body: { decision: "approve" } });
    expect(d3.fake.errors()).toEqual(["forbidden"]);
    expect(m1.fake.commands()).toHaveLength(0);
  });

  test("laptop yang tidak ada dan laptop yang tidak dipasangkan dijawab SAMA (tidak membocorkan keberadaan)", async () => {
    const { hub } = setup();
    const d3 = await connect(hub, "device", TOKENS.d3);
    await send(d3.session, { kind: "command", machineId: "m1", body: {} }); // ada, tidak dipasangkan
    await send(d3.session, { kind: "command", machineId: "tidak-ada", body: {} }); // tidak ada
    const errors = d3.fake.sent.filter((f) => f.kind === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual(errors[1]);
  });

  test("laptop yang dipasangkan tetapi sedang offline -> target_offline", async () => {
    const { hub } = setup();
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(d1.session, { kind: "command", machineId: "m1", body: {} });
    expect(d1.fake.errors()).toEqual(["target_offline"]);
  });

  test("laptop tidak boleh mengirim perintah", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, { kind: "command", machineId: "m1", body: {} });
    expect(m1.fake.errors()).toEqual(["forbidden"]);
  });

  test("pencabutan pemasangan langsung menghentikan perintah", async () => {
    const { hub, directory } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    directory.unpair("m1", "d1");
    await send(d1.session, { kind: "command", machineId: "m1", body: {} });
    expect(d1.fake.errors()).toEqual(["forbidden"]);
    expect(m1.fake.commands()).toHaveLength(0);
  });
});

describe("validasi, ukuran, dan laju", () => {
  test("JSON rusak -> invalid_json; koneksi yang sudah terautentikasi tetap hidup", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await m1.session.receive("{bukan json");
    expect(m1.fake.errors()).toEqual(["invalid_json"]);
    expect(m1.fake.state.closed).toBeUndefined();
  });

  test("bingkai yang tidak dikenal -> invalid_frame; koneksi tetap hidup", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, { kind: "terbang" });
    await send(m1.session, { kind: "event", event: { ...envelope("m1"), id: "bukan-uuid" } });
    expect(m1.fake.errors()).toEqual(["invalid_frame", "invalid_frame"]);
    expect(m1.fake.state.closed).toBeUndefined();
  });

  test("koneksi yang BELUM terautentikasi dan mengirim sampah langsung diputus", async () => {
    const { hub } = setup();
    const fake = fakeConnection();
    await hub.accept(fake.conn).receive("sampah");
    expect(fake.state.closed?.code).toBe(CLOSE.policy);
  });

  test("pesan biner ditolak (hanya teks)", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await m1.session.receive(new Uint8Array([1, 2, 3]));
    expect(m1.fake.errors()).toEqual(["invalid_frame"]);
  });

  test("pesan yang terlalu besar ditolak, koneksinya ditutup, dan koneksi lain tidak terganggu", async () => {
    const { hub } = setup({ limits: { maxMessageBytes: 2048 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);

    const huge = JSON.stringify({ kind: "event", event: envelope("m1", { payload: { isi: "x".repeat(5000) } }) });
    await m1.session.receive(huge);
    expect(m1.fake.errors()).toEqual(["too_large"]);
    expect(m1.fake.state.closed?.code).toBe(CLOSE.tooLarge);
    expect(d1.fake.events()).toHaveLength(0); // tidak diteruskan

    // Hub tetap sehat: laptop lain dan HP yang sudah ada tetap bisa dipakai.
    const m1Again = await connect(hub, "machine", TOKENS.m1);
    await send(m1Again.session, { kind: "event", event: envelope("m1") });
    expect(d1.fake.events()).toHaveLength(1);
  });

  test("ukuran dihitung dalam byte, bukan karakter (huruf non-ASCII)", async () => {
    const { hub } = setup({ limits: { maxMessageBytes: 100 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const fake = fakeConnection();
    const session = hub.accept(fake.conn);
    await session.receive("日".repeat(40)); // 40 karakter, 120 byte
    expect(fake.errors()).toEqual(["too_large"]);
    void m1;
  });

  test("terlalu banyak pesan -> rate_limited, lalu koneksi diputus bila berturut-turut", async () => {
    const { hub, clock } = setup({ limits: { rateCapacity: 3, rateRefillPerSecond: 1, maxRateViolations: 3 } });
    const m1 = await connect(hub, "machine", TOKENS.m1); // hello memakai 1 token (sisa 2)
    for (let i = 0; i < 2; i++) await send(m1.session, { kind: "terbang" }); // habiskan sisa
    expect(m1.fake.errors()).toEqual(["invalid_frame", "invalid_frame"]);

    await send(m1.session, { kind: "terbang" });
    await send(m1.session, { kind: "terbang" });
    expect(m1.fake.errors().slice(2)).toEqual(["rate_limited", "rate_limited"]);
    expect(m1.fake.state.closed).toBeUndefined();

    await send(m1.session, { kind: "terbang" }); // pelanggaran ketiga berturut-turut
    expect(m1.fake.state.closed?.code).toBe(CLOSE.policy);
    void clock;
  });

  test("laju kembali normal setelah menunggu (ember terisi lagi)", async () => {
    const { hub, clock } = setup({ limits: { rateCapacity: 2, rateRefillPerSecond: 1, maxRateViolations: 100 } });
    const m1 = await connect(hub, "machine", TOKENS.m1); // sisa 1
    await send(m1.session, { kind: "terbang" }); // sisa 0
    await send(m1.session, { kind: "terbang" });
    expect(m1.fake.errors().at(-1)).toBe("rate_limited");

    clock.ms += 2000; // dua detik: ember terisi lagi
    await send(m1.session, { kind: "terbang" });
    expect(m1.fake.errors().at(-1)).toBe("invalid_frame");
  });

  test("satu koneksi yang membanjiri tidak memengaruhi koneksi lain", async () => {
    const { hub } = setup({ limits: { rateCapacity: 2, rateRefillPerSecond: 0.001, maxRateViolations: 1000 } });
    const flooder = await connect(hub, "machine", TOKENS.m2);
    for (let i = 0; i < 50; i++) await send(flooder.session, { kind: "terbang" });
    const d3 = await connect(hub, "device", TOKENS.d3);
    expect(d3.fake.sent).toEqual([{ kind: "welcome", role: "device", id: "d3" }]);
  });
});

describe("menyapu koneksi yang mati", () => {
  test("belum menyebut hello dalam batas waktu -> ditutup", async () => {
    const { hub, clock } = setup({ limits: { helloTimeoutMs: 5000 } });
    const fake = fakeConnection();
    hub.accept(fake.conn);
    clock.ms += 4000;
    hub.sweep();
    expect(fake.state.closed).toBeUndefined();
    clock.ms += 2000;
    hub.sweep();
    expect(fake.errors()).toEqual(["hello_timeout"]);
    expect(fake.state.closed?.code).toBe(CLOSE.helloTimeout);
    expect(hub.stats().connections).toBe(0);
  });

  test("tidak ada tanda hidup terlalu lama -> dianggap mati dan ditutup", async () => {
    const { hub, clock } = setup({ limits: { idleTimeoutMs: 10_000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    clock.ms += 11_000;
    hub.sweep();
    expect(m1.fake.errors()).toEqual(["idle_timeout"]);
    expect(m1.fake.state.closed?.code).toBe(CLOSE.idle);
    expect(hub.stats()).toEqual({ connections: 0, machines: 0, devices: 0 });
  });

  test("tanda hidup (pong) mempertahankan koneksi", async () => {
    const { hub, clock } = setup({ limits: { idleTimeoutMs: 10_000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    for (let i = 0; i < 5; i++) {
      clock.ms += 8_000;
      m1.session.touch(); // pong tiba
      hub.sweep();
    }
    expect(m1.fake.state.closed).toBeUndefined();
  });

  test("pesan biasa juga dianggap tanda hidup", async () => {
    const { hub, clock } = setup({ limits: { idleTimeoutMs: 10_000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    clock.ms += 8_000;
    await send(m1.session, { kind: "terbang" });
    clock.ms += 8_000;
    hub.sweep();
    expect(m1.fake.state.closed).toBeUndefined();
  });

  test("koneksi yang ditutup dibersihkan dari catatan, dan tidak menerima kiriman lagi", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    d1.session.closed();
    expect(hub.stats()).toEqual({ connections: 1, machines: 1, devices: 0 });
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(d1.fake.events()).toHaveLength(0);
  });

  test("closed() boleh dipanggil berulang tanpa galat", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    m1.session.closed();
    expect(() => m1.session.closed()).not.toThrow();
  });

  test("closeAll menutup semuanya", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    hub.closeAll(1001, "server berhenti");
    expect(m1.fake.state.closed).toEqual({ code: 1001, reason: "server berhenti" });
    expect(d1.fake.state.closed).toEqual({ code: 1001, reason: "server berhenti" });
    expect(hub.stats().connections).toBe(0);
  });
});

describe("ketahanan", () => {
  test("soket penerima yang putus saat dikirimi tidak menjatuhkan hub dan tidak menghalangi penerima lain", async () => {
    const { hub, logs } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const d2 = await connect(hub, "device", TOKENS.d2);
    d1.fake.state.throwOnSend = true;

    await send(m1.session, { kind: "event", event: envelope("m1") });

    expect(d2.fake.events()).toHaveLength(1); // penerima lain tetap menerima
    expect(logs.join("\n")).toContain("gagal meneruskan");
  });
});

describe("penerima yang membaca lambat", () => {
  test("penerima yang antreannya melewati batas diputus, dan penerima lain tetap menerima", async () => {
    const { hub, logs } = setup({ limits: { maxBufferedBytes: 1000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const slow = await connect(hub, "device", TOKENS.d1);
    const fast = await connect(hub, "device", TOKENS.d2);
    slow.fake.state.buffered = 5000; // antreannya menumpuk

    await send(m1.session, { kind: "event", event: envelope("m1", { payload: { isi: "RAHASIA-ISI" } }) });

    expect(slow.fake.state.closed?.code).toBe(CLOSE.slowConsumer);
    expect(slow.fake.events()).toHaveLength(0); // tidak ditambahkan ke antrean yang sudah menumpuk
    expect(fast.fake.events()).toHaveLength(1);
    expect(hub.stats().devices).toBe(1);
    expect(logs.join("\n")).toContain("penerima lambat diputus");
    expect(logs.join("\n")).not.toContain("RAHASIA");
  });

  test("antrean tepat di batas belum diputus", async () => {
    const { hub } = setup({ limits: { maxBufferedBytes: 1000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    d1.fake.state.buffered = 1000;
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(d1.fake.state.closed).toBeUndefined();
    expect(d1.fake.events()).toHaveLength(1);
  });

  test("laptop yang lambat menerima perintah juga diputus", async () => {
    const { hub } = setup({ limits: { maxBufferedBytes: 1000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    m1.fake.state.buffered = 5000;
    await send(d1.session, { kind: "command", machineId: "m1", body: { decision: "approve" } });
    expect(m1.fake.state.closed?.code).toBe(CLOSE.slowConsumer);
    expect(hub.stats().machines).toBe(0);
  });

  test("penerima yang kemudian menyambung lagi dilayani seperti biasa", async () => {
    const { hub } = setup({ limits: { maxBufferedBytes: 1000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const slow = await connect(hub, "device", TOKENS.d1);
    slow.fake.state.buffered = 5000;
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(slow.fake.state.closed).toBeDefined();

    const again = await connect(hub, "device", TOKENS.d1);
    await send(m1.session, { kind: "event", event: envelope("m1", { seq: 1 }) });
    expect(again.fake.events()).toHaveLength(1);
  });

  test("koneksi yang tidak melaporkan antrean tetap berfungsi", async () => {
    const { hub } = setup({ limits: { maxBufferedBytes: 1 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const bare = fakeConnection();
    const session = hub.accept({ send: bare.conn.send, close: bare.conn.close }); // tanpa bufferedAmount
    await send(session, { kind: "hello", role: "device", token: TOKENS.d1 });
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(bare.events()).toHaveLength(1);
  });
});

describe("event diteruskan dalam bentuk aslinya", () => {
  test("kolom amplop yang belum dikenal (dari daemon versi lebih baru) tidak hilang di jalan", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(m1.session, { kind: "event", event: envelope("m1", { kolomBaru: "dari-versi-depan", bersarang: { a: 1 } }) });
    expect(d1.fake.events()[0]).toMatchObject({ event: { kolomBaru: "dari-versi-depan", bersarang: { a: 1 } } });
  });

  test("validasi amplop tetap berlaku walau yang diteruskan objek aslinya", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(m1.session, { kind: "event", event: envelope("m1", { id: "bukan-uuid", kolomBaru: "x" }) });
    expect(m1.fake.errors()).toEqual(["invalid_frame"]);
    expect(d1.fake.events()).toHaveLength(0);
  });
});

describe("log tidak memuat isi pesan maupun token", () => {
  test("seluruh jalur (hello, event, perintah, penolakan) tidak membocorkan isi", async () => {
    const { hub, logs } = setup({ limits: { maxMessageBytes: 4096 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);

    await send(m1.session, { kind: "event", event: envelope("m1", { payload: { toolInput: { content: "RAHASIA-ISI-EVENT" } } }) });
    await send(d1.session, { kind: "command", machineId: "m1", body: { comment: "RAHASIA-KOMENTAR" } });
    await send(d1.session, { kind: "command", machineId: "m2", body: { comment: "RAHASIA-DITOLAK" } });
    await m1.session.receive("RAHASIA-BUKAN-JSON");
    await m1.session.receive(JSON.stringify({ kind: "event", event: envelope("m1", { payload: "RAHASIA-BESAR-".repeat(1000) }) }));
    const bad = await connect(hub, "machine", "RAHASIA-TOKEN-SALAH-000000000000");
    void bad;

    const text = logs.join("\n");
    expect(text).not.toContain("RAHASIA");
    for (const token of Object.values(TOKENS)) expect(text).not.toContain(token);
    expect(text.length).toBeGreaterThan(0); // memang ada yang dicatat
  });
});

describe("konfirmasi (ack) dan kiriman ulang", () => {
  const acks = (fake: ReturnType<typeof fakeConnection>) => fake.sent.filter((f) => f.kind === "ack");

  test("laptop mendapat ack berisi nomor event yang baru diterima", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const event = envelope("m1");
    await send(m1.session, { kind: "event", event });
    expect(acks(m1.fake)).toEqual([{ kind: "ack", eventId: event.id }]);
  });

  test("ack dikirim juga bila tidak ada satu pun HP yang tersambung (relay sudah menerimanya)", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const event = envelope("m1");
    await send(m1.session, { kind: "event", event });
    expect(acks(m1.fake)).toHaveLength(1);
  });

  test("event yang dikirim ulang (nomor sama) dikonfirmasi lagi tetapi TIDAK diteruskan dua kali", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const event = envelope("m1");

    await send(m1.session, { kind: "event", event });
    await send(m1.session, { kind: "event", event }); // kiriman ulang
    await send(m1.session, { kind: "event", event }); // dan lagi

    expect(acks(m1.fake)).toHaveLength(3); // setiap kiriman dijawab, supaya laptop berhenti mengulang
    expect(d1.fake.events()).toHaveLength(1); // HP hanya melihat satu
  });

  test("kiriman ulang dari koneksi BARU laptop yang sama (setelah putus) juga dikenali", async () => {
    const { hub } = setup();
    const first = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const event = envelope("m1");
    await send(first.session, { kind: "event", event });
    first.session.closed();

    const second = await connect(hub, "machine", TOKENS.m1);
    await send(second.session, { kind: "event", event });

    expect(acks(second.fake)).toEqual([{ kind: "ack", eventId: event.id }]);
    expect(d1.fake.events()).toHaveLength(1);
  });

  test("nomor event yang sama dari LAPTOP LAIN adalah event lain, bukan kiriman ulang", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const m2 = await connect(hub, "machine", TOKENS.m2);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const d3 = await connect(hub, "device", TOKENS.d3);
    const shared = envelope("m1").id;

    await send(m1.session, { kind: "event", event: envelope("m1", { id: shared }) });
    await send(m2.session, { kind: "event", event: envelope("m2", { id: shared }) });

    expect(d1.fake.events()).toHaveLength(1);
    expect(d3.fake.events()).toHaveLength(1);
  });

  test("event yang DITOLAK tidak diberi ack (laptop tahu itu tidak diterima)", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, { kind: "event", event: envelope("m2") }); // menyamar sebagai laptop lain
    await send(m1.session, { kind: "event", event: { rusak: true } }); // bentuk salah
    expect(acks(m1.fake)).toEqual([]);
    expect(m1.fake.errors()).toEqual(["forbidden", "invalid_frame"]);
  });

  test("event yang ditolak tidak 'terpakai': versi yang benar dengan nomor yang sama tetap diterima", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const id = envelope("m1").id;
    await send(m1.session, { kind: "event", event: envelope("m2", { id }) }); // ditolak
    await send(m1.session, { kind: "event", event: envelope("m1", { id }) });
    expect(acks(m1.fake)).toEqual([{ kind: "ack", eventId: id }]);
    expect(d1.fake.events()).toHaveLength(1);
  });

  test("tidak ada ack bila koneksi putus saat relay masih memeriksa pemasangan", async () => {
    const memory = makeDirectory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: RelayDirectory = { ...memory, devicesOf: async (id) => (await gate, memory.devicesOf(id)) };
    const { hub } = setup({ directory: slow });
    const m1 = await connect(hub, "machine", TOKENS.m1);

    const pending = send(m1.session, { kind: "event", event: envelope("m1") });
    m1.session.closed(); // putus selagi menunggu
    release();
    await pending;
    expect(acks(m1.fake)).toEqual([]);
  });

  test("ingatan nomor event dibatasi: yang sangat lama dilupakan, yang baru-baru ini tetap dikenali", async () => {
    const { hub } = setup({ limits: { rateCapacity: 1_000_000, rateRefillPerSecond: 1_000_000 } });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const first = envelope("m1");
    await send(m1.session, { kind: "event", event: first });
    for (let i = 0; i < 2000; i++) await send(m1.session, { kind: "event", event: envelope("m1", { seq: i + 1 }) });

    await send(m1.session, { kind: "event", event: first }); // sudah dilupakan: diteruskan lagi
    expect(d1.fake.events()).toHaveLength(2002);
    const recent = envelope("m1");
    await send(m1.session, { kind: "event", event: recent });
    await send(m1.session, { kind: "event", event: recent }); // baru saja: dikenali
    expect(d1.fake.events()).toHaveLength(2003);
  }, 30_000);
});

describe("menyimpan event sebelum diteruskan dan di-ack (persist)", () => {
  const acks = (fake: ReturnType<typeof fakeConnection>) => fake.sent.filter((f) => f.kind === "ack");

  test("ack hanya dikirim SETELAH event tersimpan, dan urutannya: simpan, lalu teruskan ke HP", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { hub } = setup({
      persist: async () => {
        order.push("mulai simpan");
        await gate;
        order.push("selesai simpan");
        return { inserted: true };
      },
    });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);

    const pending = send(m1.session, { kind: "event", event: envelope("m1") });
    await Promise.resolve();
    // Selagi menyimpan: belum ada ack dan belum diteruskan.
    expect(acks(m1.fake)).toEqual([]);
    expect(d1.fake.events()).toEqual([]);
    release();
    await pending;
    expect(order).toEqual(["mulai simpan", "selesai simpan"]);
    expect(acks(m1.fake)).toHaveLength(1);
    expect(d1.fake.events()).toHaveLength(1);
  });

  test("yang disimpan adalah event yang sama dengan yang diterima", async () => {
    const stored: unknown[] = [];
    const { hub } = setup({ persist: async (event) => void stored.push(event) });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const event = envelope("m1", { seq: 7, type: "tool.completed", payload: { toolName: "Write", ok: true } });
    await send(m1.session, { kind: "event", event });
    expect(stored).toEqual([expect.objectContaining({ id: event.id, machineId: "m1", seq: 7, type: "tool.completed" })]);
  });

  test("gagal menyimpan: TIDAK di-ack dan TIDAK diteruskan, lalu kiriman ulang diproses lagi (bukan dianggap sudah selesai)", async () => {
    let fail = true;
    const attempts: string[] = [];
    const { hub, logs } = setup({
      persist: async (event) => {
        attempts.push(event.id);
        if (fail) throw new Error("database mati");
        return { inserted: true };
      },
    });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const event = envelope("m1");

    await send(m1.session, { kind: "event", event });
    expect(acks(m1.fake)).toEqual([]);
    expect(d1.fake.events()).toEqual([]);
    expect(logs.join("\n")).toContain("gagal menyimpan event: database mati");

    fail = false;
    await send(m1.session, { kind: "event", event }); // laptop mengirim ulang
    expect(attempts).toEqual([event.id, event.id]); // diproses lagi, tidak diabaikan
    expect(acks(m1.fake)).toHaveLength(1);
    expect(d1.fake.events()).toHaveLength(1);
  });

  test("event yang sudah tersimpan sebelumnya (inserted: false, mis. relay dimulai ulang): di-ack tetapi tidak diteruskan lagi", async () => {
    const { hub } = setup({ persist: async () => ({ inserted: false }) });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const event = envelope("m1");
    await send(m1.session, { kind: "event", event });
    expect(acks(m1.fake)).toEqual([{ kind: "ack", eventId: event.id }]);
    expect(d1.fake.events()).toEqual([]);
  });

  test("kiriman ulang yang baru saja berhasil dikenali di memori tanpa menyentuh penyimpanan lagi", async () => {
    let calls = 0;
    const { hub } = setup({
      persist: async () => {
        calls++;
        return { inserted: true };
      },
    });
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const event = envelope("m1");
    await send(m1.session, { kind: "event", event });
    await send(m1.session, { kind: "event", event });
    await send(m1.session, { kind: "event", event });
    expect(calls).toBe(1);
    expect(acks(m1.fake)).toHaveLength(3);
  });

  test("koneksi putus selagi menyimpan: tidak di-ack; kiriman ulang dari koneksi baru di-ack tanpa diteruskan dua kali", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const persistStarted = new Promise<void>((resolve) => (started = resolve));
    let inserted = true;
    const { hub } = setup({
      persist: async () => {
        started();
        await gate;
        const result = { inserted };
        inserted = false; // pemanggilan berikutnya: sudah ada
        return result;
      },
    });
    const first = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const event = envelope("m1");

    const pending = send(first.session, { kind: "event", event });
    await persistStarted; // koneksi putus TEPAT selagi menyimpan, bukan sebelumnya
    first.session.closed();
    release();
    await pending;
    expect(acks(first.fake)).toEqual([]);
    expect(d1.fake.events()).toEqual([]); // tersimpan, tetapi tidak diteruskan karena pengirimnya sudah putus

    const second = await connect(hub, "machine", TOKENS.m1);
    await send(second.session, { kind: "event", event });
    expect(acks(second.fake)).toEqual([{ kind: "ack", eventId: event.id }]);
    expect(d1.fake.events()).toEqual([]); // sudah tersimpan oleh percobaan pertama; tidak diteruskan lagi
  });

  test("tanpa persist, perilaku lama tidak berubah: diteruskan dan di-ack", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(m1.session, { kind: "event", event: envelope("m1") });
    expect(acks(m1.fake)).toHaveLength(1);
    expect(d1.fake.events()).toHaveLength(1);
  });
});

describe("isMachineOnline", () => {
  test("benar hanya selama laptop tersambung dan sudah lolos hello", async () => {
    const { hub } = setup();
    expect(hub.isMachineOnline("m1")).toBe(false);
    const m1 = await connect(hub, "machine", TOKENS.m1);
    expect(hub.isMachineOnline("m1")).toBe(true);
    expect(hub.isMachineOnline("m2")).toBe(false);
    m1.session.closed();
    expect(hub.isMachineOnline("m1")).toBe(false);
  });

  test("HP dengan nomor yang sama dengan laptop tidak dihitung sebagai laptop", async () => {
    const { hub } = setup();
    await connect(hub, "device", TOKENS.d1);
    expect(hub.isMachineOnline("d1")).toBe(false);
  });
});

describe("balasan dari laptop ke HP (reply)", () => {
  const reply = (deviceId: string, body: Record<string, unknown> = { type: "approval.result" }) => ({ kind: "reply", deviceId, body });
  const replies = (fake: ReturnType<typeof fakeConnection>) => fake.sent.filter((f) => f.kind === "reply");

  test("diteruskan ke HP yang dituju, dengan nomor laptop pengirim", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    const d2 = await connect(hub, "device", TOKENS.d2);
    await send(m1.session, reply("d1", { type: "approval.result", outcome: "applied" }));
    expect(replies(d1.fake)).toEqual([{ kind: "reply", machineId: "m1", body: { type: "approval.result", outcome: "applied" } }]);
    expect(replies(d2.fake)).toEqual([]); // HP lain yang dipasangkan tidak ikut menerima
  });

  test("HP yang TIDAK dipasangkan dengan laptop itu tidak menerima apa pun, dan laptop tidak mendapat galat (tidak bisa mengintai)", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d3 = await connect(hub, "device", TOKENS.d3); // dipasangkan dengan m2, bukan m1
    await send(m1.session, reply("d3"));
    expect(replies(d3.fake)).toEqual([]);
    expect(m1.fake.errors()).toEqual([]);
  });

  test("HP yang tidak sedang tersambung: dibuang diam-diam", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, reply("d1"));
    expect(m1.fake.errors()).toEqual([]);
  });

  test("HP tidak boleh membalas (hanya laptop)", async () => {
    const { hub } = setup();
    const d1 = await connect(hub, "device", TOKENS.d1);
    await send(d1.session, reply("d2"));
    expect(d1.fake.errors()).toEqual(["forbidden"]);
  });

  test("HP yang pairing-nya dicabut sesudah tersambung tidak menerima balasan lagi", async () => {
    const { hub, directory } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    const d1 = await connect(hub, "device", TOKENS.d1);
    directory.unpair("m1", "d1");
    await send(m1.session, reply("d1"));
    expect(replies(d1.fake)).toEqual([]);
  });

  test("bentuk balasan yang salah ditolak sebagai bingkai tidak sah", async () => {
    const { hub } = setup();
    const m1 = await connect(hub, "machine", TOKENS.m1);
    await send(m1.session, { kind: "reply", body: {} });
    expect(m1.fake.errors()).toEqual(["invalid_frame"]);
  });
});
