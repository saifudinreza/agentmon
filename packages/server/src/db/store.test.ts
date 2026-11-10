import type { Envelope } from "@agentmon/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "./connect";
import { events, machines, pairingCodes, sessions } from "./schema";
import { createStore, DEFAULT_RETENTION_DAYS, MAX_PAGE_SIZE, startRetention, type Store } from "./store";
import { createTestDatabase, query, resetDatabase } from "./testing";

const DAY = 24 * 60 * 60 * 1000;
const HASH = (c: string) => c.repeat(64);

let handle: DatabaseHandle;
const clock = { ms: Date.parse("2026-11-11T00:00:00Z") };
let store: Store;

beforeAll(async () => {
  handle = await createTestDatabase();
}, 60_000);
afterAll(() => handle.close());
beforeEach(async () => {
  await resetDatabase(handle.db);
  clock.ms = Date.parse("2026-11-11T00:00:00Z");
  store = createStore(handle.db, { now: () => new Date(clock.ms) });
  await handle.db.insert(machines).values([
    { id: "m1", name: "Laptop satu", tokenHash: HASH("a") },
    { id: "m2", name: "Laptop dua", tokenHash: HASH("b") },
  ]);
});

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const event = (extra: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: uuid(),
  machineId: "m1",
  sessionId: "s1",
  seq: 0,
  ts: "2026-11-10T10:00:00.000Z",
  agent: "claude-code",
  type: "tool.requested",
  payload: { toolName: "Write", toolInput: {} },
  ...extra,
});
const count = async (table: string) => Number((await query(handle.db, sql.raw(`select count(*)::int as n from ${table}`)))[0]?.n);

describe("saveEvent", () => {
  test("menyimpan event, dan membuat sesinya", async () => {
    expect(await store.saveEvent(event())).toEqual({ inserted: true });
    expect(await count("events")).toBe(1);
    const list = await store.listSessions("m1");
    expect(list).toEqual([
      { sessionId: "s1", agent: "claude-code", status: "active", startedAt: "2026-11-10T10:00:00.000Z", lastEventAt: "2026-11-10T10:00:00.000Z", endedAt: null },
    ]);
  });

  test("event yang dikirim ulang TIDAK tersimpan dua kali", async () => {
    const e = event();
    expect(await store.saveEvent(e)).toEqual({ inserted: true });
    expect(await store.saveEvent(e)).toEqual({ inserted: false });
    expect(await store.saveEvent(e)).toEqual({ inserted: false });
    expect(await count("events")).toBe(1);
  });

  test("pengiriman ulang dengan isi berbeda tidak menimpa: event pertama yang berlaku", async () => {
    const original = event({ payload: { toolName: "Write", toolInput: { content: "asli" } } });
    await store.saveEvent(original);
    await store.saveEvent({ ...original, payload: { toolName: "Write", toolInput: { content: "DIPALSUKAN" } } });
    const [stored] = await store.listEvents({ machineId: "m1", sessionId: "s1" });
    expect(JSON.stringify(stored?.payload)).toContain("asli");
    expect(JSON.stringify(stored?.payload)).not.toContain("DIPALSUKAN");
  });

  test("sepuluh pengiriman identik bersamaan menghasilkan tepat satu penyimpanan", async () => {
    const e = event();
    const results = await Promise.all(Array.from({ length: 10 }, () => store.saveEvent(e)));
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(await count("events")).toBe(1);
  });

  test("id yang sama dari laptop BERBEDA adalah event berbeda (unik per laptop)", async () => {
    const id = uuid();
    expect(await store.saveEvent(event({ id, machineId: "m1" }))).toEqual({ inserted: true });
    expect(await store.saveEvent(event({ id, machineId: "m2" }))).toEqual({ inserted: true });
    expect(await count("events")).toBe(2);
  });

  test("laptop tidak bisa menghalangi event laptop lain dengan memakai id yang sama lebih dulu", async () => {
    const id = uuid();
    await store.saveEvent(event({ id, machineId: "m2", sessionId: "milik-m2" }));
    // m1 memakai id yang sama; event m1 tetap tersimpan dan event m2 tetap utuh.
    await store.saveEvent(event({ id, machineId: "m1", sessionId: "milik-m1" }));
    expect(await store.listEvents({ machineId: "m2", sessionId: "milik-m2" })).toHaveLength(1);
    expect(await store.listEvents({ machineId: "m1", sessionId: "milik-m1" })).toHaveLength(1);
  });

  test("event untuk laptop yang tidak terdaftar ditolak dan tidak meninggalkan sisa", async () => {
    await expect(store.saveEvent(event({ machineId: "tidak-terdaftar" }))).rejects.toThrow();
    expect(await count("events")).toBe(0);
    expect(await count("sessions")).toBe(0); // transaksi dibatalkan seluruhnya
  });

  test("waktu sesi: terakhir hanya maju, mulai hanya mundur, walau event datang tidak berurutan", async () => {
    await store.saveEvent(event({ seq: 1, ts: "2026-11-10T10:05:00.000Z" }));
    await store.saveEvent(event({ seq: 2, ts: "2026-11-10T10:10:00.000Z" }));
    await store.saveEvent(event({ seq: 0, ts: "2026-11-10T10:00:00.000Z" })); // terlambat tiba
    const [session] = await store.listSessions("m1");
    expect(session?.startedAt).toBe("2026-11-10T10:00:00.000Z");
    expect(session?.lastEventAt).toBe("2026-11-10T10:10:00.000Z");
  });

  test("karakter NUL di kolom pengenal ditolak tanpa meninggalkan sisa, dan event berikutnya tetap tersimpan", async () => {
    // Postgres tidak bisa menyimpan NUL di kolom teks. Penyimpan menolaknya dengan galat (pemanggil
    // memperlakukan kegagalan simpan sebagai tidak fatal), dan transaksi dibatalkan seluruhnya.
    await expect(store.saveEvent(event({ sessionId: "sesi\u0000jahat" }))).rejects.toThrow();
    await expect(store.saveEvent(event({ type: "jenis\u0000jahat" }))).rejects.toThrow();
    expect(await count("events")).toBe(0);
    expect(await count("sessions")).toBe(0);

    expect(await store.saveEvent(event())).toEqual({ inserted: true });
    expect(await count("events")).toBe(1);
  });

  test("rekap sesi menandai sesinya selesai", async () => {
    await store.saveEvent(event({ seq: 0 }));
    await store.saveEvent(
      event({ seq: 1, ts: "2026-11-10T11:00:00.000Z", type: "session.recap", payload: { durationMs: 1, filesChanged: [], rejected: 0, autoApproved: 0 } }),
    );
    const [session] = await store.listSessions("m1");
    expect(session).toMatchObject({ status: "ended", endedAt: "2026-11-10T11:00:00.000Z" });
  });

  test("rekap yang dikirim ulang tidak mengubah apa pun", async () => {
    const recap = event({ type: "session.recap", ts: "2026-11-10T11:00:00.000Z", payload: {} });
    await store.saveEvent(recap);
    await store.saveEvent({ ...recap, ts: "2026-11-10T12:00:00.000Z" });
    const [session] = await store.listSessions("m1");
    expect(session?.endedAt).toBe("2026-11-10T11:00:00.000Z");
  });
});

describe("isi payload", () => {
  test.each([
    ["objek", { toolName: "Write", nested: { a: [1, 2, 3] } }],
    ["teks terenkripsi (tahap 4)", "Y2lwaGVydGV4dC1iYXNlNjQ="],
    ["daftar", [1, "dua", { tiga: 3 }]],
    ["angka", 42],
    ["karakter khusus dan unicode", { teks: "kutip \" garis miring \\ 日本語 ✓ \u0000-bukan-nul" }],
  ])("%s tersimpan dan terbaca persis sama", async (_name, payload) => {
    const e = event({ payload });
    await store.saveEvent(e);
    const [stored] = await store.listEvents({ machineId: "m1", sessionId: "s1" });
    expect(stored?.payload).toEqual(payload);
  });

  test("amplop tanpa isi tersimpan sebagai JSON null", async () => {
    const { payload: _drop, ...withoutPayload } = event();
    void _drop;
    await store.saveEvent(withoutPayload as Envelope);
    const [stored] = await store.listEvents({ machineId: "m1", sessionId: "s1" });
    expect(stored?.payload).toBeNull();
  });

  test("isi besar (1 MiB) tersimpan utuh", async () => {
    const big = { isi: "x".repeat(1024 * 1024) };
    await store.saveEvent(event({ payload: big }));
    const [stored] = await store.listEvents({ machineId: "m1", sessionId: "s1" });
    expect((stored?.payload as { isi: string }).isi).toHaveLength(1024 * 1024);
  });
});

describe("listEvents (riwayat per sesi)", () => {
  async function seed(n: number, sessionId = "s1", machineId = "m1") {
    for (let seq = 0; seq < n; seq++) await store.saveEvent(event({ seq, sessionId, machineId }));
  }

  test("berurutan menurut nomor urut, walau tersimpan tidak berurutan", async () => {
    // Jam maju tiap penyimpanan, sehingga urutan WAKTU TERIMA (3, 0, 2, 1, 4) berbeda dari urutan
    // nomor. Hanya implementasi yang benar-benar mengurutkan menurut nomor yang menghasilkan 0 sampai 4.
    for (const seq of [3, 0, 2, 1, 4]) {
      clock.ms += 1000;
      await store.saveEvent(event({ seq }));
    }
    const list = await store.listEvents({ machineId: "m1", sessionId: "s1" });
    expect(list.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  test("bentuknya kembali menjadi amplop yang sah", async () => {
    const e = event({ seq: 7 });
    await store.saveEvent(e);
    const [stored] = await store.listEvents({ machineId: "m1", sessionId: "s1" });
    expect(stored).toEqual(e);
  });

  test("afterSeq melanjutkan dari event setelah nomor itu (untuk HP yang menyambung ulang)", async () => {
    await seed(10);
    const list = await store.listEvents({ machineId: "m1", sessionId: "s1", afterSeq: 6 });
    expect(list.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(await store.listEvents({ machineId: "m1", sessionId: "s1", afterSeq: 9 })).toEqual([]);
  });

  test("limit membatasi jumlah, dan halaman berikutnya dilanjutkan dengan afterSeq", async () => {
    await seed(25);
    const page1 = await store.listEvents({ machineId: "m1", sessionId: "s1", limit: 10 });
    const page2 = await store.listEvents({ machineId: "m1", sessionId: "s1", limit: 10, afterSeq: page1.at(-1)?.seq as number });
    const page3 = await store.listEvents({ machineId: "m1", sessionId: "s1", limit: 10, afterSeq: page2.at(-1)?.seq as number });
    expect([page1.length, page2.length, page3.length]).toEqual([10, 10, 5]);
    expect([...page1, ...page2, ...page3].map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test("limit dibatasi paling banyak MAX_PAGE_SIZE, dan nilai aneh dirapikan", async () => {
    await handle.db.insert(sessions).values({ machineId: "m1", sessionId: "besar", agent: "claude-code", startedAt: new Date(), lastEventAt: new Date() });
    await handle.db.insert(events).values(
      Array.from({ length: MAX_PAGE_SIZE + 100 }, (_, seq) => ({
        machineId: "m1", id: uuid(), sessionId: "besar", seq, ts: new Date(), agent: "claude-code", type: "x", payload: "{}",
      })),
    );
    expect(await store.listEvents({ machineId: "m1", sessionId: "besar", limit: 1_000_000 })).toHaveLength(MAX_PAGE_SIZE);
    expect(await store.listEvents({ machineId: "m1", sessionId: "besar", limit: 0 })).toHaveLength(1); // minimal 1
    expect(await store.listEvents({ machineId: "m1", sessionId: "besar", limit: -5 })).toHaveLength(1);
  });

  test("hanya sesi dan laptop yang diminta (tidak bocor ke yang lain)", async () => {
    await seed(3, "s1", "m1");
    await seed(2, "s2", "m1");
    await seed(4, "s1", "m2"); // nama sesi sama, laptop berbeda
    expect(await store.listEvents({ machineId: "m1", sessionId: "s1" })).toHaveLength(3);
    expect(await store.listEvents({ machineId: "m1", sessionId: "s2" })).toHaveLength(2);
    expect(await store.listEvents({ machineId: "m2", sessionId: "s1" })).toHaveLength(4);
    expect(await store.listEvents({ machineId: "m1", sessionId: "tidak-ada" })).toEqual([]);
    expect(await store.listEvents({ machineId: "tidak-ada", sessionId: "s1" })).toEqual([]);
  });
});

describe("listSessions", () => {
  test("yang terbaru aktif di atas, dan terpisah per laptop", async () => {
    await store.saveEvent(event({ sessionId: "lama", ts: "2026-11-01T00:00:00.000Z" }));
    await store.saveEvent(event({ sessionId: "baru", ts: "2026-11-09T00:00:00.000Z" }));
    await store.saveEvent(event({ sessionId: "tengah", ts: "2026-11-05T00:00:00.000Z" }));
    await store.saveEvent(event({ sessionId: "milik-m2", machineId: "m2" }));
    expect((await store.listSessions("m1")).map((s) => s.sessionId)).toEqual(["baru", "tengah", "lama"]);
    expect((await store.listSessions("m2")).map((s) => s.sessionId)).toEqual(["milik-m2"]);
    expect(await store.listSessions("tidak-ada")).toEqual([]);
  });

  test("limit diterapkan", async () => {
    for (let i = 0; i < 5; i++) await store.saveEvent(event({ sessionId: `s${i}`, ts: `2026-11-0${i + 1}T00:00:00.000Z` }));
    expect(await store.listSessions("m1", { limit: 2 })).toHaveLength(2);
  });
});

describe("purge (penghapusan sesuai masa simpan)", () => {
  // Menyimpan event seolah-olah DITERIMA `daysAgo` hari lalu.
  async function receivedDaysAgo(daysAgo: number, extra: Partial<Envelope> = {}) {
    const real = clock.ms;
    clock.ms = real - daysAgo * DAY;
    await store.saveEvent(event(extra));
    clock.ms = real;
  }
  const cutoff = () => new Date(clock.ms - DEFAULT_RETENTION_DAYS * DAY);

  test("menghapus event yang diterima sebelum batas, dan mempertahankan yang lebih baru", async () => {
    await receivedDaysAgo(40, { sessionId: "lama", seq: 0 });
    await receivedDaysAgo(31, { sessionId: "lama", seq: 1 });
    await receivedDaysAgo(29, { sessionId: "baru", seq: 0 });
    await receivedDaysAgo(1, { sessionId: "baru", seq: 1 });

    const result = await store.purge({ olderThan: cutoff() });
    expect(result).toMatchObject({ events: 2, sessions: 1 });
    expect(await store.listEvents({ machineId: "m1", sessionId: "lama" })).toEqual([]);
    expect(await store.listEvents({ machineId: "m1", sessionId: "baru" })).toHaveLength(2);
  });

  test("sesi yang masih punya event tersisa tidak dihapus, sedangkan yang kosong dihapus", async () => {
    await receivedDaysAgo(40, { sessionId: "campur", seq: 0 }); // akan dihapus
    await receivedDaysAgo(2, { sessionId: "campur", seq: 1 }); // tersisa
    await receivedDaysAgo(40, { sessionId: "kosong", seq: 0 }); // seluruhnya lama
    await store.purge({ olderThan: cutoff() });
    expect((await store.listSessions("m1")).map((s) => s.sessionId)).toEqual(["campur"]);
    expect(await store.listEvents({ machineId: "m1", sessionId: "campur" })).toHaveLength(1);
  });

  test("dasarnya waktu DITERIMA relay, bukan waktu pengirim (yang bisa keliru atau dipalsukan)", async () => {
    // Waktu pengirim sangat lama, tetapi baru saja diterima: harus tetap ada.
    await receivedDaysAgo(0, { sessionId: "ts-kuno", ts: "2020-01-01T00:00:00.000Z" });
    // Waktu pengirim di masa depan, tetapi diterima 40 hari lalu: harus dihapus.
    await receivedDaysAgo(40, { sessionId: "ts-masa-depan", ts: "2099-01-01T00:00:00.000Z" });
    await store.purge({ olderThan: cutoff() });
    expect((await store.listSessions("m1")).map((s) => s.sessionId)).toEqual(["ts-kuno"]);
  });

  test("kode pairing yang sudah dipakai atau kedaluwarsa dihapus, yang masih berlaku dipertahankan", async () => {
    const now = new Date(clock.ms);
    await handle.db.insert(pairingCodes).values([
      { codeHash: HASH("1"), machineId: "m1", expiresAt: new Date(now.getTime() - 60_000) }, // kedaluwarsa
      { codeHash: HASH("2"), machineId: "m1", expiresAt: new Date(now.getTime() + 60_000), usedAt: now }, // sudah dipakai
      { codeHash: HASH("3"), machineId: "m1", expiresAt: new Date(now.getTime() + 60_000) }, // masih berlaku
    ]);
    const result = await store.purge({ olderThan: cutoff() });
    expect(result.pairingCodes).toBe(2);
    expect((await query(handle.db, sql`select code_hash from pairing_codes`)).map((r) => String(r.code_hash)[0])).toEqual(["3"]);
  });

  test("tidak ada yang perlu dihapus -> semua nol, dan aman diulang", async () => {
    await receivedDaysAgo(1);
    expect(await store.purge({ olderThan: cutoff() })).toEqual({ events: 0, sessions: 0, pairingCodes: 0 });
    expect(await store.purge({ olderThan: cutoff() })).toEqual({ events: 0, sessions: 0, pairingCodes: 0 });
    expect(await count("events")).toBe(1);
  });

  test("laptop dan HP yang terdaftar tidak ikut terhapus (hanya riwayat)", async () => {
    await receivedDaysAgo(40);
    await store.purge({ olderThan: cutoff() });
    expect(await count("machines")).toBe(2);
  });
});

describe("startRetention (penghapusan berkala)", () => {
  test("berjalan segera saat dimulai, dan menghapus yang sudah lewat 30 hari", async () => {
    const real = clock.ms;
    clock.ms = real - 40 * DAY;
    await store.saveEvent(event({ sessionId: "lama" }));
    clock.ms = real;
    await store.saveEvent(event({ sessionId: "baru" }));

    const job = startRetention({ store, now: () => new Date(clock.ms), intervalMs: 3_600_000 });
    try {
      await vi.waitFor(async () => expect((await store.listSessions("m1")).map((s) => s.sessionId)).toEqual(["baru"]));
    } finally {
      job.stop();
    }
  });

  test("berjalan berulang sesuai jadwal, dan berhenti setelah stop()", async () => {
    const job = startRetention({ store, now: () => new Date(clock.ms), intervalMs: 30 });
    try {
      await job.runNow(); // pastikan putaran pertama selesai
      // Event lama muncul belakangan: putaran berikutnya harus menghapusnya.
      const real = clock.ms;
      clock.ms = real - 40 * DAY;
      await store.saveEvent(event({ sessionId: "muncul-belakangan" }));
      clock.ms = real;
      await vi.waitFor(async () => expect(await store.listSessions("m1")).toEqual([]), { timeout: 3000 });
    } finally {
      job.stop();
    }

    // Setelah berhenti, jadwal tidak berjalan lagi.
    const real = clock.ms;
    clock.ms = real - 40 * DAY;
    await store.saveEvent(event({ sessionId: "setelah-stop" }));
    clock.ms = real;
    await new Promise((r) => setTimeout(r, 150));
    expect(await store.listSessions("m1")).toHaveLength(1);
  });

  test("kegagalan hanya dicatat dan tidak menghentikan jadwal, tanpa melempar error", async () => {
    const logs: string[] = [];
    let calls = 0;
    const broken = {
      purge: async () => {
        calls++;
        throw new Error("database putus");
      },
    } as unknown as Store;
    const job = startRetention({ store: broken, intervalMs: 20, logger: { info: () => undefined, error: (m) => logs.push(m) } });
    try {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    } finally {
      job.stop();
    }
    expect(logs.join("\n")).toContain("retensi gagal: database putus");
  });

  test("masa simpan bawaan 30 hari, dan bisa diatur", async () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    const real = clock.ms;
    clock.ms = real - 10 * DAY;
    await store.saveEvent(event({ sessionId: "sepuluh-hari" }));
    clock.ms = real;
    const job = startRetention({ store, now: () => new Date(clock.ms), retentionDays: 7, intervalMs: 3_600_000 });
    try {
      await vi.waitFor(async () => expect(await store.listSessions("m1")).toEqual([]));
    } finally {
      job.stop();
    }
  });
});
