import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { I18nProvider } from "../i18n/react";
import { savePairing } from "../pairing/storage";
import type { DeviceConnectionOptions } from "../relay/connection";
import { fakeRelay } from "../relay/fake-relay";
import type { RelayStoreFactory } from "../relay/RelayProvider";
import { createRelayStore, type RelayStore } from "../relay/relay-store";
import { stubMatchMedia } from "../testing";

afterEach(() => cleanup());

let relay: ReturnType<typeof fakeRelay>;
let connection: DeviceConnectionOptions;
let stores: RelayStore[];

const factory: RelayStoreFactory = (pairing) => {
  const store = createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: relay.api,
    newId: () => "11111111-1111-4111-8111-111111111111",
    connect: (options) => {
      connection = options;
      return { reconnectNow: vi.fn(), status: () => "online" as const, close: vi.fn(), send: () => true };
    },
  });
  stores.push(store);
  return store;
};

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  stubMatchMedia(true);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  relay = fakeRelay();
  stores = [];
});

describe("kartu Notifikasi di beranda", () => {
  test("tampil bila ada laptop terpasang; di browser tanpa dukungan push (jsdom) memberi penjelasan, bukan tombol", async () => {
    savePairing(window.localStorage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: "d".repeat(64), machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
    window.history.replaceState(null, "", "/");
    render(
      <I18nProvider>
        <App relayFactory={factory} />
      </I18nProvider>,
    );
    await act(async () => connection.onReady());
    await waitFor(() => expect(stores[0]?.getState().machinesLoaded).toBe(true));
    expect(screen.getByRole("heading", { name: "Notifikasi" })).toBeTruthy();
    expect(await screen.findByText(/tidak mendukung notifikasi push/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
  });

  test("tidak tampil sebelum ada laptop terpasang (tidak ada relay untuk dihubungi)", () => {
    window.history.replaceState(null, "", "/");
    render(
      <I18nProvider>
        <App relayFactory={factory} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("heading", { name: "Notifikasi" })).toBeNull();
  });
});
