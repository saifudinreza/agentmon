// FILE INI: TEST layar pairing untuk jalur E2E (issue #033 bagian C). Alur kripto diganti `runE2e` palsu (libsodium tidak jalan di jsdom; alur
// aslinya diuji di e2e/e2e.test.ts). Yang dijaga di sini: tautan E2E WAJIB lewat jalur E2E (tidak turun diam-diam ke pairing polos), sidik jari
// ditampilkan besar dengan peringatan, dan setiap kegagalan dijelaskan.
import { buildPairingUrl } from "@agentmon/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/react";
import { stubMatchMedia, stubPlatform, USER_AGENTS } from "../testing";
import type { E2ePairOutcome, E2ePairPhase } from "../e2e/pair";
import { clearPendingLink } from "./pending";
import { PairScreen, type RunE2e } from "./PairScreen";

const CODE = "abcDEF0123456789_-abcDEF0123456789";
const RELAY = "https://relay.contoh.com";
const KEY = "A".repeat(43);
const E2E_URL = buildPairingUrl("https://app.contoh.com", { code: CODE, relayUrl: RELAY, secret: KEY, laptopKey: KEY, machineId: "m1" });
const PLAIN_URL = buildPairingUrl("https://app.contoh.com", { code: CODE, relayUrl: RELAY });

let restorePlatform: (() => void) | undefined;

function open(url: string) {
  const parsed = new URL(url);
  window.history.replaceState(null, "", `${parsed.pathname}${parsed.hash}`);
}

function renderPair(runE2e: RunE2e) {
  return render(
    <I18nProvider>
      <PairScreen runE2e={runE2e} />
    </I18nProvider>,
  );
}

const machine = { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-24T00:00:00.000Z" };
const success = (): E2ePairOutcome => ({ status: "success", pairing: { relayUrl: RELAY, deviceId: "hp-1", deviceToken: "d".repeat(64), machines: [machine] }, machine, newDevice: true });

beforeEach(() => {
  window.localStorage.clear();
  clearPendingLink();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  restorePlatform = stubPlatform({ userAgent: USER_AGENTS.androidChrome });
  stubMatchMedia(true);
});
afterEach(() => {
  cleanup();
  restorePlatform?.();
  vi.unstubAllGlobals();
  open("https://app.contoh.com/");
});

describe("tautan E2E", () => {
  test("memakai jalur E2E (bukan pairing polos): relay biasa TIDAK dihubungi oleh jalur lama, dan nama baku dikirim", async () => {
    open(E2E_URL);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const runE2e = vi.fn<RunE2e>(async () => success());
    renderPair(runE2e);
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan" }));
    await waitFor(() => expect(runE2e).toHaveBeenCalledTimes(1));
    expect(runE2e.mock.calls[0]?.[0]).toMatchObject({ code: CODE, machineId: "m1", secret: KEY, laptopKey: KEY });
    expect(fetchSpy).not.toHaveBeenCalled(); // jalur polos tidak dipakai sama sekali
    expect(await screen.findByText("Terhubung dengan Laptop Kantor")).toBeTruthy();
  });

  test("sidik jari ditampilkan besar dengan peringatan; langkah menunggu dijelaskan; sesudah berhasil layar sukses", async () => {
    open(E2E_URL);
    let step!: (phase: E2ePairPhase) => void;
    let finish!: (outcome: E2ePairOutcome) => void;
    const runE2e: RunE2e = (_link, _name, onStep) => {
      step = onStep;
      return new Promise((resolve) => (finish = resolve));
    };
    renderPair(runE2e);
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan" }));
    await waitFor(() => expect(step).toBeDefined());
    act(() => step({ step: "waiting" }));
    expect(screen.getByText(/Lihat terminal di laptop Anda/)).toBeTruthy();
    act(() => step({ step: "confirm", fingerprint: "483291" }));
    expect(screen.getByRole("group", { name: "Sidik jari pairing" }).textContent).toBe("483 291");
    expect(screen.getByText(/JANGAN dilanjutkan/)).toBeTruthy();
    expect(screen.getByText(/harus SAMA PERSIS/)).toBeTruthy();
    act(() => finish(success()));
    expect(await screen.findByText("Terhubung dengan Laptop Kantor")).toBeTruthy();
  });

  test.each([
    ["e2e-link", /tidak lengkap atau rusak/],
    ["e2e-name", /karakter tak terlihat/],
    ["e2e-relay-old", /belum mendukung pairing terenkripsi/],
    ["e2e-rejected", /Laptop tidak memasangkan perangkat ini/],
    ["e2e-invalid", /tidak sah/],
    ["e2e-timeout", /tidak menjawab tepat waktu/],
    ["e2e-unavailable", /Penyimpanan kunci di HP ini/],
  ] as const)("kegagalan %s dijelaskan dan tidak ada yang berhasil", async (status, message) => {
    open(E2E_URL);
    renderPair(async () => ({ status }));
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(screen.queryByText(/Terhubung dengan/)).toBeNull();
  });

  test("tautan polos (pairing lama) tetap memakai jalur lama; jalur E2E tidak dipanggil", async () => {
    open(PLAIN_URL);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ deviceId: "d1", machineId: "m1", machineName: "Laptop Lama", deviceToken: "d".repeat(64) }), { status: 200 })));
    const runE2e = vi.fn<RunE2e>(async () => success());
    renderPair(runE2e);
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan" }));
    expect(await screen.findByText("Terhubung dengan Laptop Lama")).toBeTruthy();
    expect(runE2e).not.toHaveBeenCalled();
  });

  test("tautan yang HANYA memuat kunci laptop (tanpa rahasia) tidak turun ke pairing polos: diteruskan ke jalur E2E yang menolaknya", async () => {
    open(buildPairingUrl("https://app.contoh.com", { code: CODE, relayUrl: RELAY, laptopKey: KEY }));
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const runE2e = vi.fn<RunE2e>(async () => ({ status: "e2e-link" }));
    renderPair(runE2e);
    fireEvent.click(screen.getByRole("button", { name: "Pasangkan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/tidak lengkap atau rusak/);
    expect(runE2e).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
