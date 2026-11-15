import { describe, expect, test, vi } from "vitest";
import { NAVIGATE_MESSAGE } from "./notification";
import { handlePush, openNotificationTarget, STALE_APPROVAL_MS, type ClientsLike, type WindowClientLike } from "./sw-logic";

const ORIGIN = "https://agentmon.contoh.com";

describe("handlePush", () => {
  test("menampilkan satu notifikasi dengan judul, isi, tag, dan tujuan dari push", async () => {
    const show = vi.fn(async () => undefined);
    await handlePush(JSON.stringify({ v: 1, kind: "approval", machineId: "m1", approvalId: "a1" }), "id-ID", show);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("Izin dibutuhkan", expect.objectContaining({ body: "Agent menunggu keputusan Anda. Ketuk untuk melihat.", tag: "approval:m1:a1", data: { path: "/a/m1/a1" } }));
  });

  test("bahasa perangkat Inggris memakai teks Inggris", async () => {
    const show = vi.fn(async () => undefined);
    await handlePush(JSON.stringify({ v: 1, kind: "done", machineId: "m1", sessionId: "s1" }), "en-US", show);
    expect(show).toHaveBeenCalledWith("Agent finished", expect.anything());
  });

  test.each([undefined, "", "bukan json", "null", '{"kind":"aneh"}', "x".repeat(10_000)])("isi %j: SELALU menampilkan satu notifikasi umum", async (raw) => {
    const show = vi.fn(async () => undefined);
    await handlePush(raw, undefined, show);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("AgentMon", expect.objectContaining({ tag: "agentmon", data: { path: "/" } }));
  });

  test("galat saat menampilkan dilempar ke pemanggil (browser perlu tahu tugasnya gagal)", async () => {
    await expect(handlePush("{}", "id", async () => Promise.reject(new Error("izin dicabut")))).rejects.toThrow("izin dicabut");
  });
});

describe("handlePush: menutup notifikasi izin usang", () => {
  const NOW = 1_000_000_000_000;
  const mk = (tag: string, ageMs: number) => ({ tag, timestamp: NOW - ageMs, close: vi.fn() });
  const raw = JSON.stringify({ v: 1, kind: "done", machineId: "m1", sessionId: "s1" });

  test("menutup izin yang lebih tua dari batas, membiarkan yang baru, yang bukan izin, dan yang tidak tampil", async () => {
    const old = mk("approval:m1:s0", STALE_APPROVAL_MS + 1);
    const fresh = mk("approval:m1:s2", STALE_APPROVAL_MS - 1000);
    const done = mk("done:m1:s9", STALE_APPROVAL_MS * 5);
    const show = vi.fn(async () => undefined);
    await handlePush(raw, "id", show, async () => [old, fresh, done], NOW);
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(fresh.close).not.toHaveBeenCalled();
    expect(done.close).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
  });

  test("daftar yang gagal dibaca tidak menghalangi notifikasi baru", async () => {
    const show = vi.fn(async () => undefined);
    await handlePush(raw, "id", show, async () => Promise.reject(new Error("tidak bisa")), NOW);
    expect(show).toHaveBeenCalledTimes(1);
  });

  test("tag yang sama dengan yang akan tampil tidak ditutup (akan diganti sendiri)", async () => {
    const same = mk("approval:m1:s1", STALE_APPROVAL_MS * 2);
    const show = vi.fn(async () => undefined);
    await handlePush(JSON.stringify({ v: 1, kind: "approval", machineId: "m1", sessionId: "s1", count: 1 }), "id", show, async () => [same], NOW);
    expect(same.close).not.toHaveBeenCalled();
  });
});

function fakeClients(windows: WindowClientLike[]) {
  const opened: string[] = [];
  const clients: ClientsLike = {
    matchAll: vi.fn(async () => windows),
    openWindow: vi.fn(async (url: string) => void opened.push(url)),
  };
  return { clients, opened };
}
const win = (url: string, extra: Partial<WindowClientLike> = {}) => {
  const messages: unknown[] = [];
  const client: WindowClientLike = { url, focus: vi.fn(async () => undefined), postMessage: (m) => void messages.push(m), ...extra };
  return { client, messages };
};

describe("openNotificationTarget", () => {
  test("aplikasi sedang terbuka: jendelanya difokuskan dan diminta pindah layar, tanpa membuka jendela baru", async () => {
    const open = win(`${ORIGIN}/`);
    const { clients, opened } = fakeClients([open.client]);
    await openNotificationTarget(clients, { path: "/a/m1/a1" }, ORIGIN);
    expect(open.client.focus).toHaveBeenCalledTimes(1);
    expect(open.messages).toEqual([{ type: NAVIGATE_MESSAGE, path: "/a/m1/a1" }]);
    expect(opened).toEqual([]);
    expect(clients.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
  });

  test("aplikasi tertutup: jendela baru dibuka LANGSUNG di layar tujuan (alamat penuh di situs ini)", async () => {
    const { clients, opened } = fakeClients([]);
    await openNotificationTarget(clients, { path: "/a/m1/a1" }, ORIGIN);
    expect(opened).toEqual([`${ORIGIN}/a/m1/a1`]);
  });

  test("jendela dari situs lain diabaikan: jendela baru dibuka", async () => {
    const foreign = win("https://situs-lain.example/");
    const { clients, opened } = fakeClients([foreign.client]);
    await openNotificationTarget(clients, { path: "/a/m1/a1" }, ORIGIN);
    expect(foreign.client.focus).not.toHaveBeenCalled();
    expect(foreign.messages).toEqual([]);
    expect(opened).toEqual([`${ORIGIN}/a/m1/a1`]);
  });

  test("beberapa jendela: yang sesuai situs dipilih", async () => {
    const foreign = win("https://situs-lain.example/");
    const mine = win(`${ORIGIN}/devices`);
    const { clients } = fakeClients([foreign.client, mine.client]);
    await openNotificationTarget(clients, { path: "/" }, ORIGIN);
    expect(mine.messages).toHaveLength(1);
    expect(foreign.messages).toEqual([]);
  });

  test("fokus ditolak browser: perpindahan layar tetap dikirim", async () => {
    const open = win(`${ORIGIN}/`, { focus: async () => Promise.reject(new Error("tidak diizinkan")) });
    const { clients } = fakeClients([open.client]);
    await openNotificationTarget(clients, { path: "/s/m1/s1" }, ORIGIN);
    expect(open.messages).toEqual([{ type: NAVIGATE_MESSAGE, path: "/s/m1/s1" }]);
  });

  test.each([
    ["tanpa data", undefined],
    ["data null", null],
    ["data bukan objek", "teks"],
    ["tanpa jalur", {}],
    ["jalur ke situs lain", { path: "//evil.example/x" }],
    ["jalur berupa alamat penuh", { path: "https://evil.example" }],
    ["jalur bukan teks", { path: 5 }],
  ])("%s: jatuh ke beranda, tidak pernah ke alamat dari data", async (_name, data) => {
    const open = win(`${ORIGIN}/a/m1/a1`);
    const closed = fakeClients([]);
    await openNotificationTarget(fakeClients([open.client]).clients, data, ORIGIN);
    expect(open.messages).toEqual([{ type: NAVIGATE_MESSAGE, path: "/" }]);
    await openNotificationTarget(closed.clients, data, ORIGIN);
    expect(closed.opened).toEqual([`${ORIGIN}/`]);
  });

  test("alamat jendela yang rusak tidak membuat gagal", async () => {
    const broken = win("bukan alamat");
    const { clients, opened } = fakeClients([broken.client]);
    await openNotificationTarget(clients, { path: "/" }, ORIGIN);
    expect(opened).toEqual([`${ORIGIN}/`]);
  });
});

describe("openNotificationTarget: jendela yang tidak terlihat (hasil review PR #58)", () => {
  test("jendela TERLIHAT: pesan dikirim, tanpa memuat ulang", async () => {
    const navigate = vi.fn(async () => undefined);
    const open = win(`${ORIGIN}/`, { visibilityState: "visible", navigate });
    const { clients } = fakeClients([open.client]);
    await openNotificationTarget(clients, { path: "/a/m1/a1" }, ORIGIN);
    expect(open.messages).toEqual([{ type: NAVIGATE_MESSAGE, path: "/a/m1/a1" }]);
    expect(navigate).not.toHaveBeenCalled();
  });

  test.each(["hidden", "prerender", undefined])("jendela %s: alamat dimuat langsung (pesan bisa hilang di tab yang dibekukan atau dibuang)", async (visibilityState) => {
    const navigate = vi.fn(async () => undefined);
    const open = win(`${ORIGIN}/`, { ...(visibilityState ? { visibilityState } : {}), navigate });
    const { clients, opened } = fakeClients([open.client]);
    await openNotificationTarget(clients, { path: "/a/m1/a1" }, ORIGIN);
    expect(open.client.focus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/a/m1/a1`);
    expect(open.messages).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("navigate ditolak (jendela tidak dikendalikan service worker): pesan dikirim sebagai cadangan", async () => {
    const open = win(`${ORIGIN}/`, { visibilityState: "hidden", navigate: async () => Promise.reject(new TypeError("tidak dikendalikan")) });
    const { clients } = fakeClients([open.client]);
    await openNotificationTarget(clients, { path: "/s/m1/s1" }, ORIGIN);
    expect(open.messages).toEqual([{ type: NAVIGATE_MESSAGE, path: "/s/m1/s1" }]);
  });

  test("tanpa navigate di jendelanya: pesan dikirim", async () => {
    const open = win(`${ORIGIN}/`, { visibilityState: "hidden" });
    const { clients } = fakeClients([open.client]);
    await openNotificationTarget(clients, { path: "/" }, ORIGIN);
    expect(open.messages).toHaveLength(1);
  });

  test("jalur tidak aman tidak pernah di-navigate: jatuh ke beranda", async () => {
    const navigate = vi.fn(async () => undefined);
    const open = win(`${ORIGIN}/`, { visibilityState: "hidden", navigate });
    const { clients } = fakeClients([open.client]);
    await openNotificationTarget(clients, { path: "//evil.example" }, ORIGIN);
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});
