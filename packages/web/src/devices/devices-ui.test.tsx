import type { ListedDevice } from "@agentmon/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { I18nProvider } from "../i18n/react";
import { savePairing } from "../pairing/storage";
import { RelayApiError } from "../relay/api";
import { fakeRelay } from "../relay/fake-relay";
import type { RelayStoreFactory } from "../relay/RelayProvider";
import { createRelayStore } from "../relay/relay-store";
import { stubMatchMedia } from "../testing";

let relay: ReturnType<typeof fakeRelay>;
const device = (id: string, name: string, current = false): ListedDevice => ({ id, name, current, pairedAt: "2026-11-01T00:00:00.000Z" });

const factory: RelayStoreFactory = (pairing) =>
  createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: relay.api,
    connect: () => ({ reconnectNow: vi.fn(), send: vi.fn(() => true), status: () => "online" as const, close: vi.fn() }),
  });

function renderApp(path: string) {
  window.history.replaceState(null, "", path);
  return render(
    <I18nProvider>
      <App relayFactory={factory} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  stubMatchMedia(true);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  relay = fakeRelay();
  relay.data.devices = [device("d1", "HP saya", true), device("d3", "HP hilang")];
  savePairing(window.localStorage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: "d".repeat(64), machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("layar perangkat", () => {
  test("daftar menampilkan perangkat dan menandai perangkat ini", async () => {
    renderApp("/devices");
    await screen.findByText("HP hilang");
    expect(screen.getByText("HP saya")).toBeTruthy();
    expect(screen.getByText("(perangkat ini)")).toBeTruthy();
  });

  test("mencabut butuh konfirmasi; Batal tidak mencabut apa pun", async () => {
    renderApp("/devices");
    fireEvent.click(await screen.findByRole("button", { name: "Cabut HP hilang" }));
    expect(relay.api.revokeDevice).not.toHaveBeenCalled();
    expect(screen.getByText(/tidak bisa dibatalkan/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(relay.api.revokeDevice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cabut HP hilang" })).toBeTruthy();
  });

  test("setelah konfirmasi: dicabut, hilang dari daftar, dan ada pesan hasilnya", async () => {
    renderApp("/devices");
    fireEvent.click(await screen.findByRole("button", { name: "Cabut HP hilang" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut" }));
    await waitFor(() => expect(screen.queryByText("HP hilang")).toBeNull());
    expect(relay.api.revokeDevice).toHaveBeenCalledWith("d3");
    expect(screen.getByRole("status").textContent).toContain("HP hilang sudah dicabut");
  });

  test("gagal mencabut: pesan galat, perangkat tetap ada, bisa dicoba lagi", async () => {
    relay.fail.revoke = new RelayApiError("unreachable");
    renderApp("/devices");
    fireEvent.click(await screen.findByRole("button", { name: "Cabut HP hilang" }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Gagal mencabut"));
    expect(screen.getByText("HP hilang")).toBeTruthy();
  });

  test("mencabut perangkat ini sendiri meminta konfirmasi yang lebih tegas dan memberi tahu harus memasangkan ulang", async () => {
    renderApp("/devices");
    fireEvent.click(await screen.findByRole("button", { name: "Cabut HP saya" }));
    expect(screen.getByText(/harus memasangkan ulang/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ya, cabut" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Perangkat ini sudah dicabut"));
  });

  test("daftar gagal dimuat: pesan dan tombol coba lagi", async () => {
    relay.fail.devices = new RelayApiError("server");
    renderApp("/devices");
    await screen.findByText(/tidak bisa dimuat/);
    relay.fail.devices = undefined;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Coba lagi" })));
    await screen.findByText("HP hilang");
  });

  test("token ditolak (perangkat sudah dicabut): menampilkan 'Perangkat dicabut'", async () => {
    relay.fail.devices = new RelayApiError("unauthorized");
    renderApp("/devices");
    await screen.findByText("Perangkat dicabut");
  });

  test("beranda punya tautan ke layar perangkat", async () => {
    renderApp("/");
    const link = await screen.findByRole("link", { name: "Perangkat dan akses" });
    expect(link.getAttribute("href")).toBe("/devices");
  });
});
