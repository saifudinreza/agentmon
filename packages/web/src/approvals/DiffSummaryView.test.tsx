import type { DiffSummary, PendingApproval } from "@agentmon/shared";
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
import { DiffSummaryView } from "./DiffSummaryView";

afterEach(() => cleanup());

const renderView = (summary: DiffSummary) =>
  render(
    <I18nProvider>
      <DiffSummaryView summary={summary} />
    </I18nProvider>,
  );

describe("DiffSummaryView: kalimat dari data ringkasan", () => {
  test("berkas diubah: angka baris dan hunk, deklarasi di baris yang berubah, dan catatan bahwa ini bukan penilaian maksud", () => {
    renderView({
      files: [
        {
          path: "src/a.ts",
          change: "modified",
          added: 12,
          removed: 3,
          hunks: 2,
          language: "javascript",
          declarations: [
            { name: "salam", kind: "function", status: "changed" },
            { name: "Baru", kind: "class", status: "added" },
            { name: "Lama", kind: "type", status: "removed" },
          ],
        },
      ],
    });
    expect(screen.getByText("1 berkas terlibat")).toBeTruthy();
    expect(screen.getByText("src/a.ts: +12 baris, -3 baris, di 2 bagian")).toBeTruthy();
    expect(screen.getByText(/Deklarasi pada baris yang berubah:/).textContent).toContain("fungsi salam (diubah), kelas Baru (ditambahkan), tipe Lama (dihapus)");
    expect(screen.getByText(/bukan penilaian tentang maksud perubahan/)).toBeTruthy();
  });

  test("bahasa tidak dikenali: ringkasan dasar tetap ada, dengan keterangan bahwa nama fungsi tidak dideteksi", () => {
    renderView({ files: [{ path: "catatan.txt", change: "modified", added: 2, removed: 0, hunks: 1 }] });
    expect(screen.getByText("catatan.txt: +2 baris, -0 baris, di 1 bagian")).toBeTruthy();
    expect(screen.getByText(/Bahasa berkas ini tidak dikenali/)).toBeTruthy();
    expect(screen.queryByText(/Deklarasi pada baris/)).toBeNull();
  });

  test("bahasa dikenal tanpa deklarasi berubah: tanpa baris deklarasi dan tanpa keterangan bahasa", () => {
    renderView({ files: [{ path: "a.ts", change: "modified", added: 1, removed: 1, hunks: 1, language: "javascript" }] });
    expect(screen.queryByText(/Deklarasi pada baris/)).toBeNull();
    expect(screen.queryByText(/tidak dikenali/)).toBeNull();
  });

  test.each([
    [{ path: "b.ts", change: "new", added: 4, removed: 0, hunks: 1, language: "javascript" }, "b.ts: berkas baru, +4 baris"],
    [{ path: "x", change: "unchanged" }, "x: isi tidak berubah"],
    [{ path: "x", change: "format_only" }, "x: isi sama, hanya format (akhiran baris) yang berbeda"],
    [{ path: "x.bin", change: "binary" }, "x.bin: berkas biner, isinya tidak ditampilkan"],
    [{ path: "x", change: "too_large" }, "x: terlalu besar untuk dihitung"],
    [{ path: "x", change: "too_large", added: 9000, removed: 10 }, "x: terlalu besar untuk ditampilkan (perkiraan +9000 baris, -10 baris)"],
    [{ path: "x", change: "mismatch" }, "x: tidak cocok dengan isi berkas saat ini"],
  ] as const)("jenis %#", (file, expected) => {
    renderView({ files: [file as DiffSummary["files"][number]] });
    expect(screen.getByText(expected)).toBeTruthy();
  });

  test("banyak berkas dan deklarasi yang dipotong diberi tahu", () => {
    renderView({
      files: [
        { path: "a.ts", change: "modified", added: 1, removed: 0, hunks: 1, language: "javascript", declarations: [{ name: "f", kind: "function", status: "added" }], moreDeclarations: true },
        { path: "b.ts", change: "modified", added: 1, removed: 0, hunks: 1, language: "javascript" },
      ],
      moreFiles: true,
    });
    expect(screen.getByText("2 berkas terlibat")).toBeTruthy();
    expect(screen.getByText(/dan lainnya/, { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Berkas lain tidak dicantumkan.")).toBeTruthy();
  });

  test("karakter berbahaya di path ditampilkan sebagai kodenya", () => {
    renderView({ files: [{ path: "aman‮gpj.exe", change: "binary" }] });
    expect(screen.getByText(/aman\\u202egpj\.exe: berkas biner/)).toBeTruthy();
  });

  test("tanpa berkas: tidak menampilkan apa pun", () => {
    const { container } = renderView({ files: [] });
    expect(container.textContent).toBe("");
  });
});

// ---- Di layar keputusan: terbaca tanpa memuat penampil diff ----
const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
let relay: ReturnType<typeof fakeRelay>;
let connection: DeviceConnectionOptions;
let stores: RelayStore[];

const factory: RelayStoreFactory = (pairing) => {
  const store = createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: relay.api,
    newId: () => COMMAND_ID,
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
  savePairing(window.localStorage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: "d".repeat(64), machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
});

const approval = (extra: Partial<PendingApproval>): PendingApproval => ({
  machineId: "m1",
  sessionId: "s1",
  approvalId: "a1",
  toolName: "Edit",
  toolInput: { file_path: "src/a.ts" },
  requestedAt: "2026-11-11T10:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...extra,
});

describe("ringkasan di layar keputusan", () => {
  test("tampil di atas diff, dan terbaca walau diff-nya sendiri tidak ada (terlalu besar) dan penampil tidak pernah dimuat", async () => {
    relay.data.approvals = [
      approval({
        // Tanpa `diff`: hanya ringkasannya yang sampai (diff terlalu besar untuk dikirim).
        diffSummary: { files: [{ path: "src/a.ts", change: "modified", added: 6000, removed: 20, hunks: 40, language: "javascript", declarations: [{ name: "hitung", kind: "function", status: "changed" }] }] },
      }),
    ];
    window.history.replaceState(null, "", "/a/m1/a1");
    const { container } = render(
      <I18nProvider>
        <App relayFactory={factory} />
      </I18nProvider>,
    );
    await act(async () => connection.onReady());
    await waitFor(() => expect(stores[0]?.getState().approvalsLoaded).toBe(true));
    expect(screen.getByText("Ringkasan perubahan")).toBeTruthy();
    expect(screen.getByText("src/a.ts: +6000 baris, -20 baris, di 40 bagian")).toBeTruthy();
    expect(container.textContent).toContain("fungsi hitung (diubah)");
    expect(container.querySelector("[data-diff-viewer]")).toBeNull(); // penampil tidak dimuat sama sekali
    // Urutan: ringkasan sebelum diff.
    const titles = [...container.querySelectorAll("h3")].map((h) => h.textContent);
    expect(titles.indexOf("Ringkasan perubahan")).toBeLessThan(titles.indexOf("Perubahan berkas"));
  });

  test("permintaan tanpa ringkasan (mis. perintah shell): bagian ringkasan tidak ada", async () => {
    relay.data.approvals = [approval({ toolName: "Bash", toolInput: { command: "ls" } })];
    window.history.replaceState(null, "", "/a/m1/a1");
    render(
      <I18nProvider>
        <App relayFactory={factory} />
      </I18nProvider>,
    );
    await act(async () => connection.onReady());
    await waitFor(() => expect(stores[0]?.getState().approvalsLoaded).toBe(true));
    expect(screen.queryByText("Ringkasan perubahan")).toBeNull();
  });
});
