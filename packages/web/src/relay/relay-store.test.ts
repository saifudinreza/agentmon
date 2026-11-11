import type { Envelope } from "@agentmon/shared";
import { describe, expect, test, vi } from "vitest";
import { RelayApiError } from "./api";
import type { DeviceConnectionOptions } from "./connection";
import { ev, fakeRelay, MACHINES, summary } from "./fake-relay";
import { createRelayStore, type RelayStore } from "./relay-store";

function setup(relay = fakeRelay()) {
  let options!: DeviceConnectionOptions;
  const connection = { reconnectNow: vi.fn(), send: vi.fn(() => true), status: vi.fn(() => "online" as const), close: vi.fn() };
  const store: RelayStore = createRelayStore({
    relayUrl: "https://relay.contoh.com",
    token: "t".repeat(64),
    api: relay.api,
    connect: (opts) => {
      options = opts;
      return connection;
    },
  });
  store.start();
  const ready = async () => {
    options.onReady();
    await vi.waitFor(() => expect(store.getState().machinesLoaded).toBe(true));
    await relay.api.machines; // memastikan sinkronisasi pertama sempat selesai
    await vi.waitFor(() => expect(store.getState().sessions.m1).toBeDefined());
  };
  return { store, relay, connection, live: (e: Envelope) => options.onEvent(e), setStatus: (s: Parameters<DeviceConnectionOptions["onStatus"]>[0]) => options.onStatus(s), onReady: () => options.onReady(), ready };
}
const seqsOf = (store: RelayStore, key = "m1/s1") => (store.getState().events[key] ?? []).map((e) => e.seq);

describe("sinkronisasi awal", () => {
  test("saat koneksi siap: laptop dan sesi diambil", async () => {
    const { store, ready } = setup();
    expect(store.getState()).toMatchObject({ status: "connecting", machines: [], machinesLoaded: false });
    await ready();
    expect(store.getState().machines).toEqual(MACHINES);
    expect(store.getState().sessions.m1?.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(store.getState().syncError).toBe(false);
  });

  test("status koneksi diteruskan ke keadaan", () => {
    const { store, setStatus } = setup();
    setStatus("online");
    expect(store.getState().status).toBe("online");
    setStatus("offline");
    expect(store.getState().status).toBe("offline");
  });
});

describe("event langsung", () => {
  test("sesi baru langsung muncul di daftar paling atas, tanpa menunggu pengambilan ulang", async () => {
    const { store, live, ready } = setup();
    await ready();
    live(ev(0, { sessionId: "baru", ts: "2026-11-11T12:00:00.000Z" }));
    expect(store.getState().sessions.m1?.map((s) => s.sessionId)).toEqual(["baru", "s1"]);
  });

  test("event dari laptop yang tidak dikenal tidak membuat sesi (bukan milik HP ini)", async () => {
    const { store, live, ready } = setup();
    await ready();
    live(ev(0, { machineId: "m-asing", sessionId: "x" }));
    expect(store.getState().sessions["m-asing"]).toBeUndefined();
  });

  test("event untuk sesi yang TIDAK dibuka hanya memperbarui ringkasan, tidak menyimpan event (hemat memori)", async () => {
    const { store, live, ready } = setup();
    await ready();
    live(ev(5, { ts: "2026-11-11T11:00:00.000Z" }));
    expect(store.getState().events).toEqual({});
    expect(store.getState().sessions.m1?.[0]?.lastEventAt).toBe("2026-11-11T11:00:00.000Z");
  });

  test("rekap menandai sesi selesai", async () => {
    const { store, live, ready } = setup();
    await ready();
    live(ev(9, { type: "session.recap", ts: "2026-11-11T11:00:00.000Z" }));
    expect(store.getState().sessions.m1?.[0]).toMatchObject({ status: "ended", endedAt: "2026-11-11T11:00:00.000Z" });
  });

  test("ringkasan lokal yang lebih baru menang atas daftar dari relay yang sedikit tertinggal", async () => {
    const relay = fakeRelay();
    const { store, live, ready } = setup(relay);
    await ready();
    live(ev(5, { ts: "2026-11-11T13:00:00.000Z" }));
    await store.refresh(); // relay masih mengembalikan versi lama (10:00)
    expect(store.getState().sessions.m1?.[0]?.lastEventAt).toBe("2026-11-11T13:00:00.000Z");
  });
});

describe("membuka sesi", () => {
  test("memuat riwayat bertahap, dengan status loading lalu ready, berurutan", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = [ev(0), ev(1), ev(2), ev(3), ev(4)];
    const { store, ready } = setup(relay);
    await ready();

    store.openSession("m1", "s1");
    expect(store.getState().load["m1/s1"]).toBe("loading");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));
    expect(seqsOf(store)).toEqual([0, 1, 2, 3, 4]);
  });

  test("event langsung selagi sesi terbuka ditambahkan; yang sama dari dua jalur tidak ganda; yang terlambat menyelip", async () => {
    const relay = fakeRelay();
    const stored = [ev(0), ev(1), ev(2)];
    relay.data.events["m1/s1"] = stored;
    const { store, live, ready } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));

    live(ev(4));
    live(stored[2] as Envelope); // sudah ada dari riwayat
    live(ev(3)); // datang terlambat
    expect(seqsOf(store)).toEqual([0, 1, 2, 3, 4]);
  });

  test("event langsung yang tiba SELAGI riwayat masih dimuat tidak hilang dan tidak ganda", async () => {
    const relay = fakeRelay();
    const stored = [ev(0), ev(1), ev(2), ev(3), ev(4), ev(5)];
    relay.data.events["m1/s1"] = stored;
    const { store, live, ready } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    live(stored[4] as Envelope); // tiba sebelum halaman riwayat yang memuatnya
    live(ev(6)); // dan satu yang belum ada di riwayat
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));
    expect(seqsOf(store)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("sesi besar (1.500 event) dimuat lengkap dan berurutan", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = Array.from({ length: 1500 }, (_, i) => ev(i));
    const { store, ready } = setup(relay);
    await ready();
    const started = performance.now();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"), { timeout: 10_000 });
    expect(seqsOf(store)).toEqual(Array.from({ length: 1500 }, (_, i) => i));
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("membuka sesi yang sama dua kali lalu menutup sekali: tetap terbuka (hitungan referensi)", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = [ev(0)];
    const { store, live, ready } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));
    expect(relay.calls.eventsAfter).toHaveLength(1); // tidak memuat dua kali
    store.closeSession("m1", "s1");
    live(ev(1));
    expect(seqsOf(store)).toEqual([0, 1]);
    store.closeSession("m1", "s1");
    expect(store.getState().events["m1/s1"]).toBeUndefined();
  });

  test("menutup sesi membebaskan event dari memori dan mengabaikan event berikutnya; membuka lagi memuat ulang dari awal", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = [ev(0), ev(1)];
    const { store, live, ready } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));
    store.closeSession("m1", "s1");
    expect(store.getState().events).toEqual({});
    expect(store.getState().load).toEqual({});
    live(ev(2));
    expect(store.getState().events).toEqual({});

    relay.calls.eventsAfter.length = 0;
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));
    expect(relay.calls.eventsAfter).toEqual([-1]); // dari awal, bukan dari sisa lama
  });

  test("menutup sesi yang tidak pernah dibuka tidak melempar", () => {
    const { store } = setup();
    expect(() => store.closeSession("m1", "tidak-ada")).not.toThrow();
  });
});

describe("menambal yang terlewat setelah koneksi pulih atau HP dibuka dari kunci", () => {
  test("sambung ulang mengambil HANYA event setelah nomor urut terakhir yang dimiliki, tanpa celah dan tanpa ganda", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = [ev(0), ev(1), ev(2), ev(3), ev(4)];
    const { store, ready, onReady } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));
    expect(seqsOf(store)).toEqual([0, 1, 2, 3, 4]);

    // HP dikunci: laptop terus bekerja dan event 5..11 tersimpan di relay.
    relay.data.events["m1/s1"].push(...[5, 6, 7, 8, 9, 10, 11].map((s) => ev(s)));
    relay.calls.eventsAfter.length = 0;
    onReady(); // HP dibuka, koneksi pulih
    await vi.waitFor(() => expect(seqsOf(store)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(relay.calls.eventsAfter).toEqual([4]); // hanya yang terlewat
  });

  test("event yang sempat diterima langsung sebelum penambalan tidak ganda", async () => {
    const relay = fakeRelay();
    const stored = [ev(0), ev(1), ev(2)];
    relay.data.events["m1/s1"] = stored;
    const { store, live, ready, onReady } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));

    const e3 = ev(3);
    const e4 = ev(4);
    relay.data.events["m1/s1"].push(e3, e4);
    live(e4); // sebagian tiba langsung (e3 terlewat)
    onReady();
    await vi.waitFor(() => expect(seqsOf(store)).toEqual([0, 1, 2, 3, 4]));
  });

  test("REGRESI: event langsung bernomor TINGGI yang tiba selagi penambalan menunggu tidak membuat event yang terlewat dilompati", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = [ev(0), ev(1), ev(2)];
    const { store, live, ready, onReady } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));

    // HP dikunci: event 3..11 tersimpan di relay. Begitu dibuka, koneksi pulih (onReady) dan penambalan mulai
    // dengan mengambil daftar laptop dulu (lambat). Selagi menunggu, event 12 sudah tiba secara langsung.
    const e12 = ev(12);
    relay.data.events["m1/s1"].push(...[3, 4, 5, 6, 7, 8, 9, 10, 11].map((s) => ev(s)), e12);
    const release = relay.hold();
    onReady();
    live(e12);
    expect(seqsOf(store)).toEqual([0, 1, 2, 12]); // sementara hanya ini
    release();
    await vi.waitFor(() => expect(seqsOf(store)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  });

  test("daftar laptop dan sesi diambil ulang, sehingga sesi baru yang dimulai saat HP offline muncul", async () => {
    const relay = fakeRelay();
    const { store, ready, onReady } = setup(relay);
    await ready();
    relay.data.sessions.m1?.push(summary("sesi-baru", "2026-11-11T14:00:00.000Z"));
    relay.data.machines[0] = { id: "m1", name: "Laptop Kantor", online: false };
    onReady();
    await vi.waitFor(() => expect(store.getState().sessions.m1?.map((s) => s.sessionId)).toEqual(["sesi-baru", "s1"]));
    expect(store.getState().machines[0]?.online).toBe(false);
  });

  test("permintaan sinkronisasi beruntun digabung: tidak membanjiri relay", async () => {
    const relay = fakeRelay();
    const { store, ready } = setup(relay);
    await ready();
    relay.calls.machines = 0;
    const release = relay.hold();
    const runs = [store.refresh(), store.refresh(), store.refresh(), store.refresh(), store.refresh()];
    release();
    await Promise.all(runs);
    expect(relay.calls.machines).toBeLessThanOrEqual(2); // satu berjalan, satu lagi untuk yang menumpuk
  });
});

describe("galat", () => {
  test("token ditolak (perangkat dicabut): status 'revoked', koneksi ditutup, dan status berikutnya tidak menimpanya", async () => {
    const relay = fakeRelay();
    relay.fail.machines = new RelayApiError("unauthorized");
    const { store, connection, onReady, setStatus } = setup(relay);
    onReady();
    await vi.waitFor(() => expect(store.getState().status).toBe("revoked"));
    expect(connection.close).toHaveBeenCalled();
    setStatus("online");
    expect(store.getState().status).toBe("revoked");
  });

  test("jaringan bermasalah saat memperbarui: data terakhir dipertahankan dan syncError menyala, lalu padam setelah berhasil", async () => {
    const relay = fakeRelay();
    const { store, ready, onReady } = setup(relay);
    await ready();
    relay.fail.machines = new RelayApiError("unreachable");
    onReady();
    await vi.waitFor(() => expect(store.getState().syncError).toBe(true));
    expect(store.getState().sessions.m1).toHaveLength(1); // data lama masih tampil

    relay.fail.machines = undefined;
    onReady();
    await vi.waitFor(() => expect(store.getState().syncError).toBe(false));
  });

  test("gagal memuat sesi yang belum punya apa pun: status error, dan retry memulihkannya", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = [ev(0), ev(1)];
    relay.fail.events = new RelayApiError("unreachable");
    const { store, ready } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("error"));

    relay.fail.events = undefined;
    store.retrySession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));
    expect(seqsOf(store)).toEqual([0, 1]);
  });

  test("sesi atau laptop tidak ditemukan: status not-found", async () => {
    const relay = fakeRelay();
    relay.fail.events = new RelayApiError("not-found");
    const { store, ready } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("not-found"));
  });

  test("gagal menambal saat event sudah tampil: yang tampil dipertahankan dan sesi tidak ditandai error", async () => {
    const relay = fakeRelay();
    relay.data.events["m1/s1"] = [ev(0), ev(1)];
    const { store, ready, onReady } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().load["m1/s1"]).toBe("ready"));

    relay.fail.events = new RelayApiError("unreachable");
    onReady();
    await vi.waitFor(() => expect(store.getState().syncError).toBe(true));
    expect(store.getState().load["m1/s1"]).toBe("ready");
    expect(seqsOf(store)).toEqual([0, 1]);
  });

  test("token ditolak saat memuat sesi: status 'revoked'", async () => {
    const relay = fakeRelay();
    relay.fail.events = new RelayApiError("unauthorized");
    const { store, ready } = setup(relay);
    await ready();
    store.openSession("m1", "s1");
    await vi.waitFor(() => expect(store.getState().status).toBe("revoked"));
  });
});

describe("berlangganan dan berhenti", () => {
  test("pendengar diberi tahu saat ada perubahan dan berhenti setelah berhenti berlangganan", async () => {
    const { store, live, ready } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await ready();
    const before = listener.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    unsubscribe();
    live(ev(0, { sessionId: "baru", ts: "2026-11-11T15:00:00.000Z" }));
    expect(listener.mock.calls.length).toBe(before);
  });

  test("event yang tidak mengubah apa pun tidak memicu pembaruan tampilan", async () => {
    const { store, live, ready } = setup();
    await ready();
    const listener = vi.fn();
    store.subscribe(listener);
    live(ev(0, { machineId: "m-asing" })); // tidak dikenal, tidak dibuka
    expect(listener).not.toHaveBeenCalled();
  });

  test("stop menutup koneksi dan mengabaikan apa pun sesudahnya", async () => {
    const { store, connection, live, ready } = setup();
    await ready();
    const listener = vi.fn();
    store.subscribe(listener);
    store.stop();
    expect(connection.close).toHaveBeenCalled();
    live(ev(0, { sessionId: "baru", ts: "2026-11-11T16:00:00.000Z" }));
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().sessions.m1?.map((s) => s.sessionId)).toEqual(["s1"]);
  });

  test("reconnectNow diteruskan ke koneksi", () => {
    const { store, connection } = setup();
    store.reconnectNow();
    expect(connection.reconnectNow).toHaveBeenCalled();
  });
});

describe("start dan stop (aman dijalankan ulang, seperti StrictMode di mode pengembangan)", () => {
  function counting() {
    const relay = fakeRelay();
    const opened: Array<{ close: ReturnType<typeof vi.fn>; options: DeviceConnectionOptions }> = [];
    const store = createRelayStore({
      relayUrl: "https://relay.contoh.com",
      token: "t".repeat(64),
      api: relay.api,
      connect: (options) => {
        const close = vi.fn();
        opened.push({ close, options });
        return { reconnectNow: vi.fn(), send: vi.fn(() => true), status: () => "online" as const, close };
      },
    });
    return { store, opened, relay };
  }

  test("tanpa start tidak ada koneksi; start berulang hanya membuka satu", () => {
    const { store, opened } = counting();
    expect(opened).toHaveLength(0);
    store.start();
    store.start();
    expect(opened).toHaveLength(1);
  });

  test("stop menutup koneksi; start lagi membuka koneksi baru dan data yang ada dipertahankan", async () => {
    const { store, opened } = counting();
    store.start();
    opened[0]?.options.onReady();
    await vi.waitFor(() => expect(store.getState().machinesLoaded).toBe(true));

    store.stop();
    expect(opened[0]?.close).toHaveBeenCalledTimes(1);
    store.start();
    expect(opened).toHaveLength(2);
    expect(store.getState().machines).toEqual(MACHINES); // tidak hilang

    opened[1]?.options.onReady();
    await vi.waitFor(() => expect(store.getState().syncError).toBe(false));
  });

  test("stop sebelum start dan stop berulang tidak melempar", () => {
    const { store } = counting();
    expect(() => store.stop()).not.toThrow();
    store.start();
    store.stop();
    expect(() => store.stop()).not.toThrow();
  });

  test("tanpa start, event yang tiba dari koneksi lama diabaikan", async () => {
    const { store, opened } = counting();
    store.start();
    opened[0]?.options.onReady();
    await vi.waitFor(() => expect(store.getState().machinesLoaded).toBe(true));
    store.stop();
    opened[0]?.options.onEvent(ev(0, { sessionId: "baru", ts: "2026-11-11T20:00:00.000Z" }));
    expect(store.getState().sessions.m1?.map((s) => s.sessionId)).toEqual(["s1"]);
  });
});
