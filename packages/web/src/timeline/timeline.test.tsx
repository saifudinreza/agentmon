import type { Envelope } from "@agentmon/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { I18nProvider } from "../i18n/react";
import { savePairing } from "../pairing/storage";
import { RelayApiError } from "../relay/api";
import type { DeviceConnectionOptions } from "../relay/connection";
import { ev, fakeRelay } from "../relay/fake-relay";
import type { RelayStoreFactory } from "../relay/RelayProvider";
import { createRelayStore, type RelayStore } from "../relay/relay-store";
import { stubMatchMedia } from "../testing";
import { WINDOW_SIZE } from "./TimelineList";

const TOKEN = "d".repeat(64);
let relay: ReturnType<typeof fakeRelay>;
let connection: DeviceConnectionOptions;
let stores: RelayStore[];
let metrics: { scrollHeight: number; innerHeight: number; scrollY: number };

const factory: RelayStoreFactory = (pairing) => {
  const store = createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: relay.api,
    connect: (options) => {
      connection = options;
      return { reconnectNow: vi.fn(), status: () => "online", close: vi.fn() };
    },
  });
  stores.push(store);
  return store;
};

function renderApp(path: string, locale?: "en") {
  window.history.replaceState(null, "", path);
  return render(
    <I18nProvider {...(locale ? { initialLocale: locale } : {})}>
      <App relayFactory={factory} />
    </I18nProvider>,
  );
}
const live = (event: Envelope) => act(() => connection.onEvent(event));
const rows = () => screen.queryAllByRole("listitem");
const seqs = (n: number) => Array.from({ length: n }, (_, i) => ev(i));
const timeline = (path = "/s/m1/s1") => renderApp(path);
const waitLoaded = () => waitFor(() => expect(stores[0]?.getState().load["m1/s1"]).toBe("ready"));

// Ukuran halaman tiruan (jsdom tidak punya tata letak): untuk menguji logika gulir.
function setMetrics(next: Partial<typeof metrics>) {
  Object.assign(metrics, next);
}
const scrollEvent = () => act(() => void window.dispatchEvent(new Event("scroll")));

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  stubMatchMedia(true);
  savePairing(window.localStorage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: TOKEN, machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
  relay = fakeRelay();
  stores = [];
  metrics = { scrollHeight: 1000, innerHeight: 800, scrollY: 200 }; // tepat di bawah
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => metrics.innerHeight });
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => metrics.scrollY });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("memuat dan menampilkan riwayat", () => {
  test("memuat riwayat sesi, berurutan, dengan judul dan jumlah event", async () => {
    relay.data.events["m1/s1"] = [
      ev(0, { type: "session.started", payload: { cwd: "/proyek/agentmon" } }),
      ev(1, { type: "tool.requested", payload: { toolName: "Write", toolInput: { file_path: "src/a.ts" } } }),
      ev(2, { type: "tool.completed", payload: { toolName: "Write", ok: true } }),
    ];
    timeline();
    expect(screen.getByText("Memuat riwayat…")).toBeTruthy();
    await act(async () => connection.onReady());
    await waitLoaded();

    expect(screen.getByRole("heading", { level: 2, name: "Sesi Claude Code" })).toBeTruthy();
    expect(screen.getByText(/3 event/)).toBeTruthy();
    expect(rows().map((r) => r.querySelector("span.font-medium")?.textContent)).toEqual(["Sesi dimulai", "Menjalankan Write", "Write selesai"]);
    expect(screen.getByText("/proyek/agentmon")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  test("setiap jenis event tampil dengan caranya sendiri dalam Bahasa Indonesia", async () => {
    const mk = (seq: number, type: string, payload: unknown) => ev(seq, { type, payload });
    relay.data.events["m1/s1"] = [
      mk(0, "approval.requested", { approvalId: "a", toolName: "Write", toolInput: {}, summary: "+3 -1 (2 hunk)", expiresAt: "2026-11-11T10:09:00.000Z", risk: { level: "high", reasons: [] } }),
      mk(1, "approval.resolved", { approvalId: "a", status: "denied", comment: "terlalu berisiko" }),
      mk(2, "approval.auto_resolved", { approvalId: "b", toolName: "Read", status: "auto_approved", policy: { action: "allow", ruleId: "aturan-baca" } }),
      mk(3, "tool.completed", { toolName: "Bash", ok: false }),
      mk(4, "agent.notification", { title: "Izin", message: "Perlu keputusan" }),
      mk(5, "turn.review_requested", { turnId: "t", files: ["a.ts", "b.ts"] }),
      mk(6, "checkpoint.created", { checkpointId: "c" }),
      mk(7, "checkpoint.restored", { checkpointId: "c" }),
      mk(8, "agent.stopped", { lastMessage: "Selesai." }),
      mk(9, "session.recap", { durationMs: 300_000, filesChanged: ["a", "b"], rejected: 1, autoApproved: 3 }),
      mk(10, "fitur.baru", { apa: "saja" }),
    ];
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    const text = document.body.textContent ?? "";
    for (const expected of [
      "Menunggu keputusan: Write",
      "+3 -1 (2 hunk)",
      "Ditolak",
      "terlalu berisiko",
      "Disetujui otomatis: Read",
      "aturan-baca",
      "Bash gagal",
      "Pemberitahuan agent",
      "Izin: Perlu keputusan",
      "2 berkas siap direview",
      "Checkpoint dibuat",
      "Checkpoint dipulihkan",
      "Agent berhenti",
      "Rekap: 5 menit, 2 berkas berubah, 1 ditolak, 3 otomatis",
      "Event fitur.baru",
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  test("bahasa Inggris", async () => {
    relay.data.events["m1/s1"] = [ev(0, { type: "tool.completed", payload: { toolName: "Write", ok: false } })];
    cleanup();
    renderApp("/s/m1/s1", "en");
    await act(async () => connection.onReady());
    await waitLoaded();
    expect(screen.getByRole("heading", { level: 2, name: "Claude Code session" })).toBeTruthy();
    expect(screen.getByText("Write failed")).toBeTruthy();
  });

  test("isi dari agent yang berbahaya dibersihkan: tidak ada escape, pembalik arah tulisan, atau baris palsu di layar", async () => {
    relay.data.events["m1/s1"] = [
      ev(0, { type: "tool.requested", payload: { toolName: "Bash", toolInput: { command: "echo a\u001b[2J\nPERINTAH PALSU‮gnp.exe" } } }),
      ev(1, { type: "agent.notification", payload: { message: "<img src=x onerror=alert(1)> <script>alert(2)</script>" } }),
    ];
    const { container } = timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    const text = container.textContent ?? "";
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("‮");
    expect(rows()).toHaveLength(2); // baris baru dalam perintah tidak membuat baris timeline palsu
    expect(container.querySelector("img")).toBeNull(); // markup dari agent tampil sebagai teks, bukan dijalankan
    expect(container.querySelector("script")).toBeNull();
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });

  test("sesi kosong: pesan 'belum ada event'", async () => {
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    expect(screen.getByText("Belum ada event di sesi ini.")).toBeTruthy();
  });

  test("laptop atau sesi tidak dikenal: pesan, dengan jalan kembali", () => {
    cleanup();
    renderApp("/s/laptop-asing/s1");
    expect(screen.getByRole("alert").textContent).toBe("Sesi atau laptop ini tidak ditemukan.");
    fireEvent.click(screen.getByRole("link", { name: "Kembali" }));
    expect(window.location.pathname).toBe("/");
  });

  test("alamat yang tidak bisa didekode jatuh ke beranda, bukan galat", () => {
    cleanup();
    renderApp("/s/%E0%A4%A/s1");
    expect(screen.getByRole("heading", { level: 2, name: "Laptop Kantor" })).toBeTruthy();
  });

  test("gagal memuat: pesan dan tombol coba lagi yang memulihkan", async () => {
    relay.data.events["m1/s1"] = [ev(0), ev(1)];
    relay.fail.events = new RelayApiError("unreachable");
    timeline();
    await act(async () => connection.onReady());
    expect((await screen.findByRole("alert")).textContent).toContain("Riwayat tidak bisa dimuat");

    relay.fail.events = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  test("sesi tidak ditemukan di relay: pesan tidak ditemukan", async () => {
    relay.fail.events = new RelayApiError("not-found");
    timeline();
    await act(async () => connection.onReady());
    expect((await screen.findByRole("alert")).textContent).toBe("Sesi atau laptop ini tidak ditemukan.");
  });
});

describe("real-time", () => {
  test("event langsung ditambahkan di bawah, tanpa ganda, dan yang terlambat menyelip di tempatnya; jumlah ikut berubah", async () => {
    relay.data.events["m1/s1"] = seqs(3);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    expect(rows()).toHaveLength(3);

    const e3 = ev(3, { type: "tool.completed", payload: { toolName: "Terlambat", ok: true } });
    live(ev(4, { type: "tool.completed", payload: { toolName: "Terbaru", ok: true } }));
    live(e3);
    live(e3); // dua jalur membawa event yang sama
    const titles = rows().map((r) => r.querySelector("span.font-medium")?.textContent);
    expect(titles.slice(-2)).toEqual(["Terlambat selesai", "Terbaru selesai"]);
    expect(rows()).toHaveLength(5);
    expect(screen.getByText(/5 event/)).toBeTruthy();
  });

  test("event dari sesi lain tidak masuk ke timeline ini", async () => {
    relay.data.events["m1/s1"] = seqs(2);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    live(ev(0, { sessionId: "sesi-lain" }));
    expect(rows()).toHaveLength(2);
  });

  test("HP dibuka dari kunci: event yang terlewat diambil dan timeline tetap lengkap dan berurutan", async () => {
    relay.data.events["m1/s1"] = seqs(5);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    expect(rows()).toHaveLength(5);

    relay.data.events["m1/s1"].push(...[5, 6, 7, 8, 9].map((s) => ev(s, { type: "tool.completed", payload: { toolName: `T${s}`, ok: true } })));
    live(ev(12, { type: "tool.completed", payload: { toolName: "T12", ok: true } })); // sempat tiba langsung
    await act(async () => connection.onReady()); // koneksi pulih
    await waitFor(() => expect(rows()).toHaveLength(11));
    const titles = rows().slice(5).map((r) => r.querySelector("span.font-medium")?.textContent);
    expect(titles).toEqual(["T5 selesai", "T6 selesai", "T7 selesai", "T8 selesai", "T9 selesai", "T12 selesai"]);
  });
});

describe("sesi besar tetap lancar: jendela event", () => {
  test("hanya event terbaru yang digambar; tombol memuat yang lebih awal bertahap sampai habis", async () => {
    relay.data.events["m1/s1"] = seqs(400);
    timeline();
    await act(async () => connection.onReady());
    await waitFor(() => expect(stores[0]?.getState().events["m1/s1"]).toHaveLength(400), { timeout: 10_000 });

    expect(rows()).toHaveLength(WINDOW_SIZE);
    expect(screen.getByText(/400 event/)).toBeTruthy(); // jumlah sebenarnya, bukan yang digambar
    const first = screen.getByRole("button", { name: "Muat 150 event sebelumnya" });
    fireEvent.click(first);
    expect(rows()).toHaveLength(300);
    fireEvent.click(screen.getByRole("button", { name: "Muat 100 event sebelumnya" })); // sisa 100
    expect(rows()).toHaveLength(400);
    expect(screen.queryByRole("button", { name: /Muat .* event sebelumnya/ })).toBeNull();
  }, 20_000);

  test("sesi 1.500 event: DOM tetap kecil dan event baru ditambahkan tanpa menggambar ulang semuanya", async () => {
    relay.data.events["m1/s1"] = seqs(1500);
    timeline();
    await act(async () => connection.onReady());
    await waitFor(() => expect(stores[0]?.getState().events["m1/s1"]).toHaveLength(1500), { timeout: 20_000 });
    expect(rows()).toHaveLength(WINDOW_SIZE);

    // 100 event langsung beruntun
    const started = performance.now();
    for (let seq = 1500; seq < 1600; seq++) live(ev(seq));
    const elapsed = performance.now() - started;
    expect(rows()).toHaveLength(WINDOW_SIZE); // jendela mengikuti yang terbaru
    expect(elapsed).toBeLessThan(5000); // sangat longgar; yang dijaga: tidak menggambar ulang 1.600 baris tiap kali
    expect(screen.getByText(/1600 event/)).toBeTruthy();
  }, 40_000);

  test("memuat event lebih awal menjaga posisi baca: layar digeser sebesar tambahan isi di atas (tidak melompat)", async () => {
    relay.data.events["m1/s1"] = seqs(400);
    timeline();
    await act(async () => connection.onReady());
    await waitFor(() => expect(stores[0]?.getState().events["m1/s1"]).toHaveLength(400), { timeout: 10_000 });

    // Tinggi halaman: 5.000 piksel saat tombol diketuk, lalu 8.000 setelah 150 baris ditambahkan di atas.
    let armed = false;
    let reads = 0;
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => (armed ? (reads++ === 0 ? 5000 : 8000) : metrics.scrollHeight) });
    (window.scrollBy as ReturnType<typeof vi.fn>).mockClear();
    armed = true;
    fireEvent.click(screen.getByRole("button", { name: "Muat 150 event sebelumnya" }));
    armed = false;

    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(window.scrollBy).toHaveBeenCalledWith(0, 3000); // 8000 - 5000
  }, 20_000);
});

describe("mengikuti event baru atau tidak", () => {
  test("sedang di bawah: layar ikut turun mengikuti event baru, tanpa tombol", async () => {
    relay.data.events["m1/s1"] = seqs(3);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    (window.scrollTo as ReturnType<typeof vi.fn>).mockClear();

    setMetrics({ scrollHeight: 1200 });
    live(ev(3));
    expect(window.scrollTo).toHaveBeenCalledWith(0, 1200);
    expect(screen.queryByRole("button", { name: /event baru/ })).toBeNull();
  });

  test("sedang membaca ke atas: layar TIDAK ditarik; muncul tombol 'N event baru' yang membawa ke bawah", async () => {
    relay.data.events["m1/s1"] = seqs(3);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();

    setMetrics({ scrollHeight: 5000, scrollY: 0 }); // pengguna menggulir ke atas
    scrollEvent();
    (window.scrollTo as ReturnType<typeof vi.fn>).mockClear();

    live(ev(3));
    live(ev(4));
    expect(window.scrollTo).not.toHaveBeenCalled(); // tidak mengganggu yang sedang dibaca
    const pill = screen.getByRole("button", { name: "2 event baru" });

    fireEvent.click(pill);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 5000, behavior: "smooth" });
    expect(screen.queryByRole("button", { name: /event baru/ })).toBeNull();
  });

  test("tombol hilang sendiri bila pengguna menggulir kembali ke bawah", async () => {
    relay.data.events["m1/s1"] = seqs(3);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    setMetrics({ scrollHeight: 5000, scrollY: 0 });
    scrollEvent();
    live(ev(3));
    expect(screen.queryByRole("button", { name: /event baru/ })).not.toBeNull();

    setMetrics({ scrollY: 4200 }); // 4200 + 800 = 5000: di dasar
    scrollEvent();
    expect(screen.queryByRole("button", { name: /event baru/ })).toBeNull();
  });
});

describe("keluar masuk layar", () => {
  test("membuka timeline dari beranda lewat tautan, fokus pindah ke judul, dan kembali membebaskan event dari memori", async () => {
    relay.data.events["m1/s1"] = seqs(3);
    renderApp("/");
    await act(async () => connection.onReady());
    await waitFor(() => expect(stores[0]?.getState().machinesLoaded).toBe(true));

    fireEvent.click(screen.getByRole("link", { name: /Claude Code/ }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Sesi Claude Code")); // efek fokus berjalan sesudah render
    expect(document.activeElement?.tagName).toBe("H2");
    expect(stores[0]?.getState().events["m1/s1"]).toHaveLength(3);

    fireEvent.click(screen.getByRole("link", { name: "Kembali" }));
    expect(window.location.pathname).toBe("/");
    expect(stores[0]?.getState().events).toEqual({}); // dibebaskan
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
  });

  test("perangkat dicabut saat timeline terbuka: pesan jelas", async () => {
    relay.data.events["m1/s1"] = seqs(2);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    relay.fail.machines = new RelayApiError("unauthorized");
    await act(async () => connection.onReady());
    await waitFor(() => expect(screen.getByText(/Pasangkan ulang dengan QR baru/)).toBeTruthy());
  });

  test("peringatan muncul bila pembaruan gagal tetapi event yang ada tetap tampil", async () => {
    relay.data.events["m1/s1"] = seqs(2);
    timeline();
    await act(async () => connection.onReady());
    await waitLoaded();
    relay.fail.machines = new RelayApiError("unreachable");
    await act(async () => connection.onReady());
    await waitFor(() => expect(screen.getByText(/Tidak bisa memperbarui daftar/)).toBeTruthy());
    expect(rows()).toHaveLength(2);
    expect(within(screen.getByRole("list", { name: "Riwayat event sesi" })).getAllByRole("listitem")).toHaveLength(2);
  });
});
