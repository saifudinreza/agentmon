import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";
import { I18nProvider } from "./i18n/react";
import { savePairing } from "./pairing/storage";
import type { DeviceConnectionOptions } from "./relay/connection";
import { ev, fakeRelay, summary } from "./relay/fake-relay";
import type { RelayStoreFactory } from "./relay/RelayProvider";
import { aggregateStatus } from "./relay/ConnectionChip";
import { createRelayStore, type RelayStore } from "./relay/relay-store";
import { stubMatchMedia } from "./testing";

const RELAY_URL = "https://relay.contoh.com";
const TOKEN = "d".repeat(64);

let relay: ReturnType<typeof fakeRelay>;
let connection: DeviceConnectionOptions;
let stores: RelayStore[];

function pairLaptop(id = "m1", name = "Laptop Kantor") {
  savePairing(window.localStorage, { relayUrl: RELAY_URL, deviceId: "d1", deviceToken: TOKEN, machine: { id, name, pairedAt: "2026-11-01T00:00:00.000Z" } });
}

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

function renderApp(path = "/") {
  window.history.replaceState(null, "", path);
  return render(
    <I18nProvider>
      <App relayFactory={factory} />
    </I18nProvider>,
  );
}
const sync = async () => {
  await act(async () => connection.onReady());
  await waitFor(() => expect(stores[0]?.getState().machinesLoaded).toBe(true));
};
const live = (event: ReturnType<typeof ev>) => act(() => connection.onEvent(event));

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  stubMatchMedia(true);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
  relay = fakeRelay();
  stores = [];
  pairLaptop();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("aggregateStatus", () => {
  test.each([
    [[], undefined],
    [["online"], "online"],
    [["online", "connecting"], "connecting"],
    [["online", "offline", "connecting"], "offline"],
    [["online", "revoked"], "revoked"],
  ] as const)("%j -> %s", (statuses, expected) => expect(aggregateStatus([...statuses])).toBe(expected));
});

describe("beranda: laptop dan sesi", () => {
  test("sebelum sinkronisasi pertama: laptop dari penyimpanan perangkat tampil dengan 'Memuat sesi…'", () => {
    renderApp();
    expect(screen.getByRole("heading", { level: 2, name: "Laptop Kantor" })).toBeTruthy();
    expect(screen.getByText("melalui relay.contoh.com")).toBeTruthy();
    expect(screen.getByText("Memuat sesi…")).toBeTruthy();
  });

  test("setelah sinkronisasi: status online/offline dan daftar sesi dengan tautan ke timeline", async () => {
    relay.data.sessions.m1 = [summary("sesi-a", "2026-11-11T10:30:00.000Z"), summary("sesi/b?x", "2026-11-11T09:30:00.000Z", { status: "ended", endedAt: "2026-11-11T09:45:00.000Z" })];
    renderApp();
    await sync();

    const card = screen.getByRole("region", { name: "Laptop Kantor" });
    expect(within(card).getByText("Online")).toBeTruthy();
    const links = within(card).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe("/s/m1/sesi-a");
    expect(links[1]?.getAttribute("href")).toBe("/s/m1/sesi%2Fb%3Fx"); // id dengan karakter khusus di-encode
    expect(within(links[0] as HTMLElement).getByText("Claude Code")).toBeTruthy();
    expect(within(links[0] as HTMLElement).getByText("Aktif")).toBeTruthy();
    expect(within(links[1] as HTMLElement).getByText("Selesai")).toBeTruthy();
  });

  test("laptop yang offline ditandai Offline", async () => {
    relay.data.machines[0] = { id: "m1", name: "Laptop Kantor", online: false };
    renderApp();
    await sync();
    expect(within(screen.getByRole("region", { name: "Laptop Kantor" })).getByText("Offline")).toBeTruthy();
  });

  test("laptop tanpa sesi: pesan kosong", async () => {
    relay.data.sessions.m1 = [];
    renderApp();
    await sync();
    expect(screen.getByText("Belum ada sesi di laptop ini.")).toBeTruthy();
  });

  test("sesi baru dari event langsung muncul paling atas tanpa memuat ulang", async () => {
    renderApp();
    await sync();
    live(ev(0, { sessionId: "sesi-baru", ts: "2026-11-11T12:00:00.000Z" }));
    const links = within(screen.getByRole("region", { name: "Laptop Kantor" })).getAllByRole("link");
    expect(links[0]?.getAttribute("href")).toBe("/s/m1/sesi-baru");
  });

  test("klik biasa berpindah layar tanpa memuat ulang; klik dengan Ctrl dibiarkan untuk browser (tab baru)", async () => {
    renderApp();
    await sync();
    const link = screen.getByRole("link", { name: /Claude Code/ });

    const ctrlClick = fireEvent.click(link, { ctrlKey: true });
    expect(ctrlClick).toBe(true); // tidak di-preventDefault: browser yang menangani
    expect(window.location.pathname).toBe("/");

    fireEvent.click(link);
    expect(window.location.pathname).toBe("/s/m1/s1");
  });

  test("tanpa pairing: ajakan memasangkan laptop, bukan daftar", () => {
    cleanup();
    window.localStorage.clear();
    renderApp();
    expect(screen.getByRole("heading", { level: 2, name: "Belum ada laptop terpasang" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Claude Code/ })).toBeNull();
  });

  test("perangkat dicabut: pesan jelas menggantikan daftar", async () => {
    const { RelayApiError } = await import("./relay/api");
    relay.fail.machines = new RelayApiError("unauthorized");
    renderApp();
    await act(async () => connection.onReady());
    await waitFor(() => expect(screen.getByText("Perangkat dicabut", { selector: "p.font-semibold" })).toBeTruthy());
    expect(screen.getByText(/Pasangkan ulang dengan QR baru/)).toBeTruthy();
  });

  test("gagal memperbarui: data terakhir tetap tampil dengan peringatan", async () => {
    const { RelayApiError } = await import("./relay/api");
    renderApp();
    await sync();
    relay.fail.machines = new RelayApiError("unreachable");
    await act(async () => connection.onReady());
    await waitFor(() => expect(screen.getByText(/Tidak bisa memperbarui daftar/)).toBeTruthy());
    expect(screen.getByRole("link", { name: /Claude Code/ })).toBeTruthy(); // daftar lama masih ada
  });
});

describe("status koneksi", () => {
  test("tidak tampil sebelum ada laptop terpasang", () => {
    cleanup();
    window.localStorage.clear();
    renderApp();
    expect(screen.queryByLabelText(/Status koneksi/)).toBeNull();
  });

  test("mengikuti keadaan sambungan dan diumumkan ke pembaca layar (aria-live)", () => {
    renderApp();
    const chip = () => screen.getByLabelText(/Status koneksi/);
    expect(chip().getAttribute("aria-live")).toBe("polite");
    expect(chip().textContent).toBe("Menyambung…");

    act(() => connection.onStatus("online"));
    expect(chip().textContent).toBe("Tersambung");
    act(() => connection.onStatus("offline"));
    expect(chip().textContent).toBe("Terputus");
    expect(chip().getAttribute("aria-label")).toBe("Status koneksi: Terputus");
  });

  test("perangkat dicabut menimpa status lain", async () => {
    const { RelayApiError } = await import("./relay/api");
    relay.fail.machines = new RelayApiError("unauthorized");
    renderApp();
    await act(async () => connection.onReady());
    await waitFor(() => expect(screen.getByLabelText(/Status koneksi/).textContent).toBe("Perangkat dicabut"));
    act(() => connection.onStatus("online"));
    expect(screen.getByLabelText(/Status koneksi/).textContent).toBe("Perangkat dicabut");
  });

  test("bahasa Inggris", () => {
    window.history.replaceState(null, "", "/");
    render(
      <I18nProvider initialLocale="en">
        <App relayFactory={factory} />
      </I18nProvider>,
    );
    expect(screen.getByLabelText(/Connection status/).textContent).toBe("Connecting…");
  });
});
