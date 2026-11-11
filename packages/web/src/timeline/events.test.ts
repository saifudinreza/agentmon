import type { Envelope, SessionSummary } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { applyEventToSessions, lastSeq, mergeEvents } from "./events";

let counter = 0;
const ev = (seq: number, extra: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  machineId: "m1",
  sessionId: "s1",
  seq,
  ts: `2026-11-11T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  agent: "claude-code",
  type: "tool.requested",
  payload: {},
  ...extra,
});
const seqs = (events: readonly Envelope[]) => events.map((e) => e.seq);

describe("mergeEvents", () => {
  test("daftar kosong digabung dengan event: terurut menurut seq", () => {
    expect(seqs(mergeEvents([], [ev(2), ev(0), ev(1)]))).toEqual([0, 1, 2]);
  });

  test("event baru yang berurutan ditempel di ujung (jalur cepat) tanpa mengubah yang lama", () => {
    const base = [ev(0), ev(1)];
    const merged = mergeEvents(base, [ev(2), ev(3)]);
    expect(seqs(merged)).toEqual([0, 1, 2, 3]);
    expect(merged.slice(0, 2)).toEqual(base);
  });

  test("event yang datang TERLAMBAT menyelip di tempat yang benar", () => {
    const merged = mergeEvents([ev(0), ev(1), ev(4), ev(5)], [ev(3), ev(2)]);
    expect(seqs(merged)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("event yang sama (id sama) dari dua jalur (dorongan dan riwayat) tidak ganda", () => {
    const shared = ev(1);
    const merged = mergeEvents([ev(0), shared], [shared, { ...shared }, ev(2)]);
    expect(seqs(merged)).toEqual([0, 1, 2]);
  });

  test("duplikat di dalam kiriman yang sama dibuang", () => {
    const e = ev(0);
    expect(mergeEvents([], [e, e, { ...e }])).toHaveLength(1);
  });

  test("tidak ada yang baru: mengembalikan array YANG SAMA (tampilan tidak digambar ulang)", () => {
    const base = [ev(0), ev(1)];
    expect(mergeEvents(base, [base[0] as Envelope])).toBe(base);
    expect(mergeEvents(base, [])).toBe(base);
  });

  test("tidak mengubah array masukan (tak bisa diubah)", () => {
    const base = Object.freeze([ev(0), ev(2)]);
    const incoming = Object.freeze([ev(1)]);
    expect(() => mergeEvents(base, incoming)).not.toThrow();
    expect(seqs(base)).toEqual([0, 2]);
  });

  test("seq yang sama: urutan pasti (cap waktu, lalu id), bukan acak", () => {
    const a = ev(5, { ts: "2026-11-11T10:00:01.000Z", id: "00000000-0000-4000-8000-0000000000aa" });
    const b = ev(5, { ts: "2026-11-11T10:00:02.000Z", id: "00000000-0000-4000-8000-0000000000bb" });
    expect(mergeEvents([], [b, a])).toEqual([a, b]);
    expect(mergeEvents([], [a, b])).toEqual([a, b]);
  });

  test("menggabungkan dalam urutan apa pun menghasilkan daftar yang sama (konvergen)", () => {
    const all = Array.from({ length: 50 }, (_, i) => ev(i));
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    const chunks = [shuffled.slice(0, 13), shuffled.slice(13, 30), shuffled.slice(30)];
    let merged: readonly Envelope[] = [];
    for (const chunk of chunks) merged = mergeEvents(merged, chunk);
    expect(seqs(merged)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  test("sesi besar tetap ringan: 5.000 event ditempel satu per satu dan sekali gabung", () => {
    const all = Array.from({ length: 5000 }, (_, i) => ev(i));
    const started = performance.now();
    let merged: readonly Envelope[] = [];
    for (const e of all.slice(0, 1000)) merged = mergeEvents(merged, [e]); // 1.000 kedatangan satu per satu
    merged = mergeEvents(merged, all.slice(1000)); // lalu 4.000 sekaligus
    merged = mergeEvents(merged, [all[2500] as Envelope]); // duplikat
    const elapsed = performance.now() - started;
    expect(merged).toHaveLength(5000);
    expect(seqs(merged).every((s, i) => s === i)).toBe(true);
    expect(elapsed).toBeLessThan(3000); // sangat longgar; yang dijaga: tidak kuadratik
  });
});

describe("lastSeq", () => {
  test("nomor terbesar, atau -1 bila kosong (mengambil dari awal)", () => {
    expect(lastSeq([])).toBe(-1);
    expect(lastSeq([ev(3), ev(9), ev(5)])).toBe(9);
  });
});

describe("applyEventToSessions", () => {
  const summary = (id: string, last: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    sessionId: id,
    agent: "claude-code",
    status: "active",
    startedAt: "2026-11-11T09:00:00.000Z",
    lastEventAt: last,
    endedAt: null,
    ...extra,
  });

  test("sesi baru muncul di daftar sebagai aktif", () => {
    const result = applyEventToSessions([], ev(0, { sessionId: "baru", ts: "2026-11-11T10:00:00.000Z" }));
    expect(result).toEqual([{ sessionId: "baru", agent: "claude-code", status: "active", startedAt: "2026-11-11T10:00:00.000Z", lastEventAt: "2026-11-11T10:00:00.000Z", endedAt: null }]);
  });

  test("waktu terakhir hanya maju, dan waktu mulai hanya mundur (event tidak berurutan)", () => {
    const existing = [summary("s1", "2026-11-11T10:00:00.000Z")];
    const older = applyEventToSessions(existing, ev(0, { ts: "2026-11-11T08:00:00.000Z" }));
    expect(older[0]).toMatchObject({ startedAt: "2026-11-11T08:00:00.000Z", lastEventAt: "2026-11-11T10:00:00.000Z" });
    const newer = applyEventToSessions(existing, ev(1, { ts: "2026-11-11T11:00:00.000Z" }));
    expect(newer[0]).toMatchObject({ startedAt: "2026-11-11T09:00:00.000Z", lastEventAt: "2026-11-11T11:00:00.000Z" });
  });

  test("rekap menandai sesi selesai", () => {
    const result = applyEventToSessions([summary("s1", "2026-11-11T10:00:00.000Z")], ev(9, { type: "session.recap", ts: "2026-11-11T10:30:00.000Z" }));
    expect(result[0]).toMatchObject({ status: "ended", endedAt: "2026-11-11T10:30:00.000Z" });
  });

  test("sesi yang terbaru aktif naik ke atas", () => {
    const existing = [summary("a", "2026-11-11T10:00:00.000Z"), summary("b", "2026-11-11T09:30:00.000Z")];
    expect(applyEventToSessions(existing, ev(0, { sessionId: "b", ts: "2026-11-11T11:00:00.000Z" })).map((s) => s.sessionId)).toEqual(["b", "a"]);
  });

  test("tidak ada perubahan: mengembalikan array yang sama", () => {
    const existing = [summary("s1", "2026-11-11T10:00:00.000Z")];
    expect(applyEventToSessions(existing, ev(0, { ts: "2026-11-11T09:30:00.000Z" }))).toBe(existing);
  });

  test("tidak mengubah array masukan", () => {
    const existing = Object.freeze([summary("s1", "2026-11-11T10:00:00.000Z")]);
    expect(() => applyEventToSessions(existing, ev(1, { ts: "2026-11-11T12:00:00.000Z" }))).not.toThrow();
  });
});

describe("mergeEvents: jalur cepat untuk event berurutan di ujung", () => {
  test("hasilnya sama persis dengan jalur umum untuk semua kombinasi (dibandingkan dengan acuan yang sederhana)", () => {
    // Acuan lambat tetapi jelas: gabung semua, buang id ganda, urutkan.
    const reference = (a: readonly Envelope[], b: readonly Envelope[]) => {
      const byId = new Map<string, Envelope>();
      for (const e of [...a, ...b]) if (!byId.has(e.id)) byId.set(e.id, e);
      return [...byId.values()].sort((x, y) => x.seq - y.seq || x.ts.localeCompare(y.ts) || x.id.localeCompare(y.id));
    };
    const all = Array.from({ length: 30 }, (_, i) => ev(i));
    for (let trial = 0; trial < 300; trial++) {
      const pick = () => all.filter(() => Math.random() < 0.5);
      const a = [...pick()].sort((x, y) => x.seq - y.seq);
      const b = pick().sort(() => Math.random() - 0.5);
      expect(mergeEvents(a, b).map((e) => e.id)).toEqual(reference(a, b).map((e) => e.id));
    }
  });

  test("event dengan seq SAMA dengan yang terakhir (id sama) dianggap sudah ada, bukan ditempel lagi", () => {
    const last = ev(5);
    const base = [ev(3), ev(4), last];
    expect(mergeEvents(base, [last])).toBe(base);
    expect(mergeEvents(base, [{ ...last }])).toBe(base);
  });

  test("event dengan seq yang sama tetapi id berbeda adalah event lain dan ikut masuk, urutan pasti", () => {
    const a = ev(5, { ts: "2026-11-11T10:00:01.000Z" });
    const b = ev(5, { ts: "2026-11-11T10:00:02.000Z" });
    expect(mergeEvents([a], [b])).toEqual([a, b]);
  });

  test("duplikat di dalam kiriman yang sama pada jalur cepat dibuang", () => {
    const e = ev(10);
    expect(mergeEvents([ev(0)], [e, e, { ...e }])).toHaveLength(2);
  });

  test("campuran: sebagian lebih besar dari yang terakhir dan sebagian yang sudah ada tidak memakai jalur cepat, dan tetap benar", () => {
    const base = [ev(0), ev(1), ev(2)];
    const merged = mergeEvents(base, [base[2] as Envelope, ev(3)]);
    expect(seqs(merged)).toEqual([0, 1, 2, 3]);
  });

  test("tidak mengubah array masukan pada jalur cepat", () => {
    const base = Object.freeze([ev(0), ev(1)]);
    expect(() => mergeEvents(base, Object.freeze([ev(2)]))).not.toThrow();
    expect(seqs(base)).toEqual([0, 1]);
  });

  test("sesi 40.000 event: 200 event langsung beruntun selesai jauh di bawah satu detik (biaya tidak naik menurut panjang sesi)", () => {
    let list: readonly Envelope[] = Array.from({ length: 40_000 }, (_, i) => ev(i));
    const started = performance.now();
    for (let i = 0; i < 200; i++) list = mergeEvents(list, [ev(40_000 + i)]);
    const elapsed = performance.now() - started;
    expect(list).toHaveLength(40_200);
    expect(seqs(list.slice(-3))).toEqual([40_197, 40_198, 40_199]);
    // Sebelumnya sekitar 7,8 ms per event (1,5 detik untuk 200). Batas longgar agar tidak rapuh di mesin sibuk.
    expect(elapsed).toBeLessThan(800);
  });
});
