import type { Envelope } from "@agentmon/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import { I18nProvider } from "../i18n/react";
import { savePairing } from "../pairing/storage";
import type { DeviceConnectionOptions } from "../relay/connection";
import { ev, fakeRelay } from "../relay/fake-relay";
import type { RelayStoreFactory } from "../relay/RelayProvider";
import { createRelayStore, type RelayStore } from "../relay/relay-store";
import { stubMatchMedia } from "../testing";
import { EventRow } from "../timeline/EventRow";
import { rollbackPath } from "./RollbackScreen";

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
let relay: ReturnType<typeof fakeRelay>;
let connection: DeviceConnectionOptions;
let stores: RelayStore[];
let sent: Array<{ kind: string; machineId?: string; body: Record<string, unknown> }>;
let sendOk: boolean;
let counter: number;

const factory: RelayStoreFactory = (pairing) => {
  const store = createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: relay.api,
    newId: () => `${COMMAND_ID.slice(0, -2)}${String(++counter).padStart(2, "0")}`,
    connect: (options) => {
      connection = options;
      return {
        reconnectNow: vi.fn(),
        status: () => "online" as const,
        close: vi.fn(),
        send: (frame) => {
          if (!sendOk) return false;
          sent.push(frame as (typeof sent)[number]);
          return true;
        },
      };
    },
  });
  stores.push(store);
  return store;
};

function renderApp(path: string) {
  window.history.replaceState(null, "", path);
  return render(
    <I18nProvider>
      <App relayFactory={factory} />
    </I18nProvider>,
  );
}
const lastCommandId = () => sent[sent.length - 1]?.body.commandId as string;
const replyTo = (body: Record<string, unknown>) => act(() => connection.onReply?.("m1", { type: "rollback.result", checkpointId: "cp1", commandId: lastCommandId(), ...body }));
const previewReply = (extra: Record<string, unknown> = {}) =>
  replyTo({
    outcome: "preview",
    files: [
      { path: "a.txt", change: "overwrite" },
      { path: "b.txt", change: "restore" },
      { path: "baru.txt", change: "delete" },
    ],
    total: 3,
    counts: { restore: 1, overwrite: 1, delete: 1 },
    truncated: false,
    previewHash: "hash-1",
    agentRunning: false,
    ...extra,
  });

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  stubMatchMedia(true);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
  relay = fakeRelay();
  stores = [];
  sent = [];
  sendOk = true;
  counter = 0;
  savePairing(window.localStorage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: "d".repeat(64), machine: { id: "m1", name: "Laptop Kantor", pairedAt: "2026-11-01T00:00:00.000Z" } });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

// Membuka layar dan menyambungkan koneksi; pratinjau baru diminta setelah tersambung.
async function open(path = "/r/m1/cp1") {
  renderApp(path);
  act(() => connection.onStatus("online"));
  await waitFor(() => expect(sent).toHaveLength(1));
}

async function openPreview(reply: Record<string, unknown> = {}) {
  await open();
  previewReply(reply);
}

describe("layar rollback: pratinjau", () => {
  test("meminta pratinjau ke laptop yang benar dan menampilkan semua berkas dengan jenisnya", async () => {
    await openPreview();
    expect(sent[0]).toMatchObject({ kind: "command", machineId: "m1", body: { type: "rollback.preview", checkpointId: "cp1" } });
    await screen.findByText("3 berkas akan berubah");
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(screen.getByText("baru.txt")).toBeTruthy();
    expect(screen.getByText("dihapus")).toBeTruthy();
    expect(screen.getByText(/1 dibuat lagi, 1 dikembalikan isinya, 1 dihapus/)).toBeTruthy();
  });

  test("menyebut hal yang tidak bisa dibatalkan dan bahwa rollback bisa dibatalkan", async () => {
    await openPreview();
    await screen.findByText("Yang perlu Anda ketahui");
    expect(screen.getByText(/Pekerjaan setelah checkpoint ini/)).toBeTruthy();
    expect(screen.getByText(/git push, jaringan, database/)).toBeTruthy();
    expect(screen.getByText(/rollback ini bisa dibatalkan/)).toBeTruthy();
  });

  test("jalur berkas dengan karakter berbahaya ditampilkan sebagai kodenya, bukan disembunyikan", async () => {
    await openPreview({ files: [{ path: "aman‮gpj.exe", change: "delete" }], total: 1, counts: { restore: 0, overwrite: 0, delete: 1 } });
    await screen.findByText("aman\\u202egpj.exe");
  });

  test("daftar dipotong: memberi tahu berapa yang ditampilkan dari total", async () => {
    await openPreview({ total: 250, truncated: true, counts: { restore: 10, overwrite: 40, delete: 200 } });
    await screen.findByText("Menampilkan 3 dari 250 berkas.");
    // Ringkasan memakai jumlah dari daftar penuh, bukan dari 3 berkas yang tampil.
    expect(screen.getByText(/10 dibuat lagi, 40 dikembalikan isinya, 200 dihapus/)).toBeTruthy();
  });

  test("tidak ada perbedaan: pesan 'tidak ada yang perlu dikembalikan', tanpa tombol", async () => {
    await openPreview({ files: [], total: 0, counts: { restore: 0, overwrite: 0, delete: 0 } });
    await screen.findByText(/Tidak ada yang perlu dikembalikan/);
    expect(screen.queryByRole("button", { name: /Kembalikan berkas/ })).toBeNull();
  });

  test("agent masih berjalan: peringatan dan tombol mati", async () => {
    await openPreview({ agentRunning: true });
    await screen.findByText(/Agent masih berjalan di sesi ini/);
    expect((screen.getByRole("button", { name: /Kembalikan berkas/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("layar rollback: konfirmasi dan penerapan", () => {
  test("butuh dua ketukan; Batal kembali tanpa mengirim apa pun", async () => {
    await openPreview();
    fireEvent.click(await screen.findByRole("button", { name: /Kembalikan berkas/ }));
    expect(screen.getByText(/Kembalikan 3 berkas ke checkpoint ini/)).toBeTruthy();
    expect(sent).toHaveLength(1); // hanya pratinjau
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.getByRole("button", { name: /Kembalikan berkas/ })).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  test("konfirmasi mengirim apply dengan sidik pratinjau; berhasil menampilkan hasil dan tautan batalkan", async () => {
    await openPreview();
    fireEvent.click(await screen.findByRole("button", { name: /Kembalikan berkas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, kembalikan" }));
    expect(sent[1]).toMatchObject({ kind: "command", machineId: "m1", body: { type: "rollback.apply", checkpointId: "cp1", previewHash: "hash-1" } });
    replyTo({ outcome: "applied", changed: 3, safetyCheckpointId: "aman-1" });
    await screen.findByText("Selesai: 3 berkas dikembalikan.");
    const undo = screen.getByRole("link", { name: "Batalkan rollback" });
    expect(undo.getAttribute("href")).toBe(rollbackPath("m1", "aman-1"));
  });

  test("tidak bisa menekan konfirmasi dua kali saat sedang berjalan", async () => {
    await openPreview();
    fireEvent.click(await screen.findByRole("button", { name: /Kembalikan berkas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, kembalikan" }));
    expect((screen.getByRole("button", { name: "Mengembalikan…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Mengembalikan…" }));
    expect(sent.filter((f) => f.body.type === "rollback.apply")).toHaveLength(1);
  });

  test("laptop menolak karena isi berubah: pesan dari laptop dan tombol lihat pratinjau lagi yang mengirim pratinjau baru", async () => {
    await openPreview();
    fireEvent.click(await screen.findByRole("button", { name: /Kembalikan berkas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, kembalikan" }));
    replyTo({ outcome: "refused", reason: "preview_changed", message: "Isi proyek berubah sejak pratinjau." });
    await screen.findByText("Isi proyek berubah sejak pratinjau.");
    fireEvent.click(screen.getByRole("button", { name: "Lihat pratinjau lagi" }));
    await waitFor(() => expect(sent.filter((f) => f.body.type === "rollback.preview")).toHaveLength(2));
  });

  test("gagal di tengah jalan: menyebut apakah keadaan sebelumnya dipulihkan", async () => {
    await openPreview();
    fireEvent.click(await screen.findByRole("button", { name: /Kembalikan berkas/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ya, kembalikan" }));
    replyTo({ outcome: "failed", message: "git checkout-index gagal", recovered: true });
    await screen.findByText("Rollback gagal");
    expect(screen.getByText("Keadaan sebelumnya sudah dipulihkan.")).toBeTruthy();
  });
});

describe("layar rollback: penolakan dan galat", () => {
  test("pratinjau ditolak (checkpoint tidak ada): pesan laptop ditampilkan, tanpa tombol rollback", async () => {
    await open();
    replyTo({ outcome: "refused", reason: "checkpoint_missing", message: "Checkpoint ini sudah tidak ada di repo." });
    await screen.findByText("Checkpoint ini sudah tidak ada di repo.");
    expect(screen.queryByRole("button", { name: /Kembalikan berkas/ })).toBeNull();
  });

  test("tidak tersambung: pesan jelas dan bisa dicoba lagi", async () => {
    sendOk = false;
    renderApp("/r/m1/cp1");
    act(() => connection.onStatus("online"));
    await screen.findByText(/Tidak tersambung ke relay/);
    sendOk = true;
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  test("balasan untuk checkpoint lain atau rusak diabaikan sebagai 'tidak dikenal'", async () => {
    await open();
    replyTo({ checkpointId: "cp-lain", outcome: "applied", changed: 1 });
    await screen.findByText(/Jawaban laptop tidak dikenal/);
  });

  test("layar dibuka sebelum koneksi siap: menunggu, tidak mengirim apa pun, lalu meminta pratinjau begitu tersambung", async () => {
    renderApp("/r/m1/cp1");
    expect(screen.getByText("Menyambung ke laptop…")).toBeTruthy();
    expect(sent).toHaveLength(0);
    act(() => connection.onStatus("online"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body.type).toBe("rollback.preview");
  });

  test("tersambung ulang di tengah jalan tidak mengulang pratinjau", async () => {
    await openPreview();
    await screen.findByText("3 berkas akan berubah");
    act(() => connection.onStatus("offline"));
    act(() => connection.onStatus("online"));
    expect(sent).toHaveLength(1);
  });

  test("perangkat dicabut: pesan perangkat dicabut, tanpa mengirim apa pun", () => {
    renderApp("/r/m1/cp1");
    act(() => connection.onStatus("revoked"));
    expect(screen.getAllByText("Perangkat dicabut").length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
  });

  test("laptop tidak dipasangkan: tidak ditemukan, dan tidak ada perintah dikirim", () => {
    renderApp("/r/mx/cp1");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(sent).toHaveLength(0);
  });
});

describe("tautan di timeline", () => {
  const checkpointEvent = (payload: Record<string, unknown>): Envelope => ev(5, { type: "checkpoint.created", payload });

  test("event checkpoint.created punya tautan 'Kembalikan ke sini' ke layar rollback", () => {
    window.history.replaceState(null, "", "/");
    render(
      <I18nProvider>
        <ul>
          <EventRow event={checkpointEvent({ checkpointId: "20261112T100000000Z-0001-ab12" })} />
        </ul>
      </I18nProvider>,
    );
    expect(screen.getByRole("link", { name: "Kembalikan ke sini" }).getAttribute("href")).toBe(rollbackPath("m1", "20261112T100000000Z-0001-ab12"));
  });

  test("nomor dengan karakter khusus di-encode di alamat", () => {
    render(
      <I18nProvider>
        <ul>
          <EventRow event={checkpointEvent({ checkpointId: "a/b c" })} />
        </ul>
      </I18nProvider>,
    );
    expect(screen.getByRole("link", { name: "Kembalikan ke sini" }).getAttribute("href")).toBe("/r/m1/a%2Fb%20c");
  });

  test("event checkpoint.restored punya tautan 'Batalkan rollback' ke checkpoint pengaman", () => {
    render(
      <I18nProvider>
        <ul>
          <EventRow event={ev(6, { type: "checkpoint.restored", payload: { checkpointId: "cp1", safetyCheckpointId: "aman-1" } })} />
          <EventRow event={ev(7, { type: "checkpoint.restored", payload: { checkpointId: "cp1" } })} />
        </ul>
      </I18nProvider>,
    );
    const links = screen.getAllByRole("link", { name: "Batalkan rollback" });
    expect(links).toHaveLength(1); // yang tanpa nomor pengaman tidak punya tautan
    expect(links[0]?.getAttribute("href")).toBe(rollbackPath("m1", "aman-1"));
  });

  test("event lain, atau checkpoint.created tanpa nomor, tidak punya tautan", () => {
    render(
      <I18nProvider>
        <ul>
          <EventRow event={ev(1, { type: "tool.completed", payload: { toolName: "Write" } })} />
          <EventRow event={checkpointEvent({})} />
        </ul>
      </I18nProvider>,
    );
    expect(screen.queryByRole("link", { name: "Kembalikan ke sini" })).toBeNull();
  });
});
