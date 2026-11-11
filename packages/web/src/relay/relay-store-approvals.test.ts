import type { PendingApproval } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { approvalKey } from "../approvals/model";
import type { DeviceConnectionOptions } from "./connection";
import { ev, fakeRelay } from "./fake-relay";
import { createRelayStore, type RelayStore } from "./relay-store";

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const KEY = approvalKey("m1", "a1");
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
const requestedEvent = (approvalId: string, extra: Record<string, unknown> = {}) =>
  ev(10, { type: "approval.requested", payload: { approvalId, toolName: "Bash", toolInput: { command: "npm test" }, expiresAt: "2099-01-01T00:00:00.000Z", ...extra } });
const resolvedEvent = (approvalId: string, status: string) => ev(11, { type: "approval.resolved", payload: { approvalId, status } });

function setup(relay = fakeRelay(), send: () => boolean = () => true) {
  let options!: DeviceConnectionOptions;
  const sent: Array<Record<string, unknown>> = [];
  const store: RelayStore = createRelayStore({
    relayUrl: "https://relay.contoh.com",
    token: "t".repeat(64),
    api: relay.api,
    newId: () => COMMAND_ID,
    confirmTimeoutMs: 1000,
    connect: (opts) => {
      options = opts;
      return {
        reconnectNow: vi.fn(),
        status: () => "online" as const,
        close: vi.fn(),
        send: (frame) => {
          const ok = send();
          if (ok) sent.push(frame as Record<string, unknown>);
          return ok;
        },
      };
    },
  });
  store.start();
  const ready = async () => {
    options.onReady();
    await vi.waitFor(() => expect(store.getState().approvalsLoaded).toBe(true));
  };
  return {
    store,
    relay,
    sent,
    ready,
    live: (e: ReturnType<typeof ev>) => options.onEvent(e),
    reply: (body: Record<string, unknown>, machineId = "m1") => options.onReply?.(machineId, body),
    error: (code: string) => options.onError?.(code),
    decision: () => store.getState().decisions[KEY],
    ids: () => store.getState().approvals.map((a) => a.approvalId),
  };
}
const replyBody = (outcome: string, extra: Record<string, unknown> = {}) => ({ type: "approval.result", commandId: COMMAND_ID, approvalId: "a1", outcome, ...extra });

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => vi.useRealTimers());

describe("antrean izin", () => {
  test("diambil dari relay saat sinkronisasi, berisiko tinggi di atas", async () => {
    const relay = fakeRelay();
    relay.data.approvals = [pending("rendah", { risk: { level: "low", reasons: [] } }), pending("tinggi", { risk: { level: "high", reasons: [] } })];
    const t = setup(relay);
    await t.ready();
    expect(t.ids()).toEqual(["tinggi", "rendah"]);
  });

  test("permintaan baru dari event langsung masuk antrean; yang sama dua kali tidak ganda", async () => {
    const t = setup();
    await t.ready();
    t.live(requestedEvent("a1"));
    t.live(requestedEvent("a1"));
    expect(t.ids()).toEqual(["a1"]);
    expect(t.store.getState().approvals[0]).toMatchObject({ toolName: "Bash", toolInput: { command: "npm test" } });
  });

  test("event dari laptop yang tidak dikenal tidak masuk antrean", async () => {
    const t = setup();
    await t.ready();
    t.live(ev(10, { machineId: "m-asing", type: "approval.requested", payload: { approvalId: "x", toolName: "Bash", toolInput: {}, expiresAt: "2099-01-01T00:00:00.000Z" } }));
    expect(t.ids()).toEqual([]);
  });

  test("penyelesaian (keputusan manusia) mengeluarkan dari antrean dan mencatat hasilnya", async () => {
    const t = setup();
    await t.ready();
    t.live(requestedEvent("a1"));
    t.live(resolvedEvent("a1", "denied"));
    expect(t.ids()).toEqual([]);
    expect(t.store.getState().resolved[KEY]).toBe("denied");
  });

  test("penyelesaian otomatis juga mengeluarkan dari antrean", async () => {
    const t = setup();
    await t.ready();
    t.live(requestedEvent("a1"));
    t.live(ev(12, { type: "approval.auto_resolved", payload: { approvalId: "a1", toolName: "Bash", status: "auto_approved", policy: { action: "allow", ruleId: "r" } } }));
    expect(t.ids()).toEqual([]);
    expect(t.store.getState().resolved[KEY]).toBe("auto_approved");
  });

  test("izin yang diselesaikan SELAGI daftar dari relay masih diambil tidak muncul kembali (tanpa hantu)", async () => {
    const relay = fakeRelay();
    relay.data.approvals = [pending("a1")]; // relay masih menyebutnya
    const t = setup(relay);
    t.live(requestedEvent("a1"));
    t.live(resolvedEvent("a1", "approved"));
    await t.ready();
    expect(t.ids()).toEqual([]);
  });

  test("izin yang diterima langsung selagi pengambilan berjalan tidak hilang (relay belum sempat memuatnya)", async () => {
    const relay = fakeRelay();
    relay.data.approvals = [pending("lama")];
    const t = setup(relay);
    await t.ready(); // daftar laptop sudah dimuat
    // Sinkronisasi berikutnya (mis. HP dibuka dari kunci) berjalan; selagi menunggu, izin baru tiba langsung.
    const release = relay.hold();
    t.store.refresh().catch(() => undefined);
    t.live(requestedEvent("baru"));
    release();
    await vi.waitFor(() => expect(t.ids().sort()).toEqual(["baru", "lama"]));
  });

  test("event yang tiba SEBELUM daftar laptop dimuat diabaikan, tetapi sinkronisasi mengambilnya dari relay (yang menyimpan sebelum meneruskan)", async () => {
    const relay = fakeRelay();
    relay.data.approvals = [pending("baru")]; // relay sudah menyimpannya
    const t = setup(relay);
    t.live(requestedEvent("baru")); // tiba sebelum laptop dikenal
    expect(t.ids()).toEqual([]);
    await t.ready();
    expect(t.ids()).toEqual(["baru"]);
  });

  test("hasil yang dicatat dibatasi jumlahnya (tidak tumbuh tanpa akhir)", async () => {
    const t = setup();
    await t.ready();
    for (let i = 0; i < 300; i++) t.live(resolvedEvent(`x${i}`, "approved"));
    expect(Object.keys(t.store.getState().resolved)).toHaveLength(200);
    expect(t.store.getState().resolved[approvalKey("m1", "x299")]).toBe("approved");
  });

  test("gagal mengambil antrean: syncError menyala dan antrean lama dipertahankan", async () => {
    const relay = fakeRelay();
    relay.data.approvals = [pending("a1")];
    const t = setup(relay);
    await t.ready();
    relay.fail.approvals = new Error("jaringan");
    t.store.refresh().catch(() => undefined);
    await vi.waitFor(() => expect(t.store.getState().syncError).toBe(true));
    expect(t.ids()).toEqual(["a1"]);
  });
});

describe("mengirim keputusan", () => {
  test("mengirim perintah ke laptop yang benar dengan nomor perintah, dan fasenya 'sent' (terkirim)", async () => {
    const t = setup();
    await t.ready();
    t.live(requestedEvent("a1"));
    t.store.decide("m1", "a1", "approve");
    expect(t.sent).toEqual([{ kind: "command", machineId: "m1", body: { type: "approval.decision", commandId: COMMAND_ID, approvalId: "a1", decision: "approve" } }]);
    expect(t.decision()).toMatchObject({ phase: "sent", decision: "approve", commandId: COMMAND_ID });
  });

  test("tolak dengan komentar: dipangkas dan dibatasi 2.000 karakter; komentar kosong tidak dikirim", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "deny", "  jangan hapus folder itu  ");
    expect((t.sent[0]?.body as { comment?: string }).comment).toBe("jangan hapus folder itu");
    t.store.decide("m1", "a1", "deny", "x".repeat(5000));
    expect((t.sent[1]?.body as { comment?: string }).comment).toHaveLength(2000);
    t.store.decide("m1", "a1", "deny", "   ");
    expect(t.sent[2]?.body).not.toHaveProperty("comment");
  });

  test("tidak tersambung: langsung gagal 'offline', tanpa menggantung", async () => {
    const t = setup(fakeRelay(), () => false);
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    expect(t.decision()).toMatchObject({ phase: "failed", reason: "offline" });
    expect(t.sent).toEqual([]);
  });

  test("tidak ada konfirmasi laptop dalam batas waktu: gagal 'unconfirmed' (tidak menggantung selamanya)", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    vi.advanceTimersByTime(999);
    expect(t.decision()?.phase).toBe("sent");
    vi.advanceTimersByTime(2);
    expect(t.decision()).toMatchObject({ phase: "failed", reason: "unconfirmed" });
  });

  test("balasan yang tiba sebelum batas waktu membatalkan penunggu (tidak menimpa hasil)", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.reply(replyBody("applied", { status: "approved" }));
    vi.advanceTimersByTime(5000);
    expect(t.decision()).toMatchObject({ phase: "applied", status: "approved" });
  });

  test("mencoba lagi memakai nomor perintah baru; balasan untuk percobaan lama diabaikan", async () => {
    let id = 0;
    const relay = fakeRelay();
    let options!: DeviceConnectionOptions;
    const store = createRelayStore({
      relayUrl: "https://relay.contoh.com",
      token: "t".repeat(64),
      api: relay.api,
      newId: () => `00000000-0000-4000-8000-00000000000${++id}`,
      connect: (o) => {
        options = o;
        return { reconnectNow: vi.fn(), status: () => "online" as const, close: vi.fn(), send: () => true };
      },
    });
    store.start();
    store.decide("m1", "a1", "approve");
    store.decide("m1", "a1", "approve"); // coba lagi
    options.onReply?.("m1", { type: "approval.result", commandId: "00000000-0000-4000-8000-000000000001", approvalId: "a1", outcome: "applied", status: "approved" });
    expect(store.getState().decisions[KEY]?.phase).toBe("sent"); // balasan percobaan pertama tidak dipakai
    options.onReply?.("m1", { type: "approval.result", commandId: "00000000-0000-4000-8000-000000000002", approvalId: "a1", outcome: "applied", status: "approved" });
    expect(store.getState().decisions[KEY]?.phase).toBe("applied");
  });
});

describe("hasil keputusan dari balasan laptop", () => {
  test("applied: berhasil, dengan status yang berlaku", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "deny", "alasan");
    t.reply(replyBody("applied", { status: "denied" }));
    expect(t.decision()).toMatchObject({ phase: "applied", status: "denied", decision: "deny" });
  });

  test("dua HP memutuskan bersamaan: yang kalah mendapat 'conflict' beserta keputusan yang menang", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.reply(replyBody("already_resolved", { status: "denied" }));
    expect(t.decision()).toMatchObject({ phase: "conflict", status: "denied", decision: "approve" });
  });

  test.each([
    ["already_resolved timed_out", replyBody("already_resolved", { status: "timed_out" })],
    ["unknown", replyBody("unknown")],
  ])("kedaluwarsa atau tidak dikenal (%s): 'expired' dan keluar dari antrean", async (_name, body) => {
    const t = setup();
    await t.ready();
    t.live(requestedEvent("a1"));
    t.store.decide("m1", "a1", "approve");
    t.reply(body);
    expect(t.decision()?.phase).toBe("expired");
    expect(t.ids()).toEqual([]);
  });

  test("invalid: gagal dengan alasan", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.reply(replyBody("invalid"));
    expect(t.decision()).toMatchObject({ phase: "failed", reason: "invalid" });
  });

  test.each([
    ["nomor perintah lain", { ...replyBody("applied"), commandId: "99999999-9999-4999-8999-999999999999" }],
    ["bentuk rusak", { type: "approval.result", outcome: "applied" }],
    ["jenis lain", { type: "lain", commandId: COMMAND_ID }],
  ])("balasan yang bukan untuk keputusan ini diabaikan: %s", async (_name, body) => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.reply(body);
    expect(t.decision()?.phase).toBe("sent");
  });

  test("balasan dari laptop LAIN dengan nomor izin yang sama tidak mengubah keputusan ini", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.reply(replyBody("applied", { status: "approved" }), "m-lain");
    expect(t.decision()?.phase).toBe("sent");
  });

  test("balasan tanpa keputusan yang menunggu tidak membuat apa pun", async () => {
    const t = setup();
    await t.ready();
    t.reply(replyBody("applied", { status: "approved" }));
    expect(t.store.getState().decisions).toEqual({});
  });
});

describe("hasil keputusan yang disimpulkan dari event (balasan belum atau tidak tiba)", () => {
  test("hasil cocok dengan keputusan kita: dianggap berlaku", async () => {
    const t = setup();
    await t.ready();
    t.live(requestedEvent("a1"));
    t.store.decide("m1", "a1", "approve");
    t.live(resolvedEvent("a1", "approved"));
    expect(t.decision()).toMatchObject({ phase: "applied", status: "approved" });
  });

  test("hasil BERBEDA dari keputusan kita (HP lain yang menang): konflik, dengan status yang berlaku", async () => {
    const t = setup();
    await t.ready();
    t.live(requestedEvent("a1"));
    t.store.decide("m1", "a1", "approve");
    t.live(resolvedEvent("a1", "denied"));
    expect(t.decision()).toMatchObject({ phase: "conflict", status: "denied" });
  });

  test("waktu habis saat kita menunggu: konflik dengan status timed_out", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "deny");
    t.live(resolvedEvent("a1", "timed_out"));
    expect(t.decision()).toMatchObject({ phase: "conflict", status: "timed_out" });
  });

  test("hasil yang sudah final tidak ditimpa event berikutnya", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.reply(replyBody("applied", { status: "approved" }));
    t.live(resolvedEvent("a1", "approved"));
    t.live(resolvedEvent("a1", "denied"));
    expect(t.decision()).toMatchObject({ phase: "applied", status: "approved" });
  });
});

describe("galat dari relay", () => {
  test.each([
    ["target_offline", "laptop-offline"],
    ["forbidden", "not-allowed"],
    ["rate_limited", "rate-limited"],
  ])("%s pada keputusan yang baru dikirim -> gagal '%s'", async (code, reason) => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.error(code);
    expect(t.decision()).toMatchObject({ phase: "failed", reason });
  });

  test("galat lain diabaikan", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.error("invalid_json");
    expect(t.decision()?.phase).toBe("sent");
  });

  test("galat yang datang lama sesudah pengiriman tidak dikaitkan dengan keputusan ini", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    vi.advanceTimersByTime(900); // masih menunggu, tetapi sudah lewat 5 detik dalam skenario ini
    vi.setSystemTime(Date.now() + 10_000);
    t.error("target_offline");
    expect(t.decision()?.phase).toBe("sent");
  });

  test("galat tidak mengubah keputusan yang sudah punya hasil", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.reply(replyBody("applied", { status: "approved" }));
    t.error("target_offline");
    expect(t.decision()?.phase).toBe("applied");
  });
});

describe("berhenti", () => {
  test("stop membatalkan penunggu konfirmasi", async () => {
    const t = setup();
    await t.ready();
    t.store.decide("m1", "a1", "approve");
    t.store.stop();
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(t.decision()?.phase).toBe("sent"); // tidak berubah setelah berhenti
  });
});
