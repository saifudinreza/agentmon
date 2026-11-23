// @vitest-environment node
// FILE INI: TEST gerbang E2E di dalam relay-store (issue #033 bagian C): seluruh jalur masuk (event langsung, riwayat, antrean izin, balasan) dan
// keluar (keputusan, permintaan umum) lewat gerbang, dan layar tidak perlu tahu apa-apa soal kripto. Berjalan di Node karena libsodium menolak
// Uint8Array milik jsdom.
import {
  approvalHash,
  fromB64,
  generateDataKey,
  generateKxKeyPair,
  generateSignKeyPair,
  laptopSessionKeys,
  loadSodium,
  openSigned,
  sealEvent,
  sealSigned,
  utf8,
  type Sodium,
} from "@agentmon/shared/crypto";
import type { Envelope } from "@agentmon/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { approvalKey } from "../approvals/model";
import type { DeviceConnectionOptions } from "../relay/connection";
import { ev, fakeRelay } from "../relay/fake-relay";
import { createRelayStore } from "../relay/relay-store";
import { createGate } from "./gate";
import { memoryBackend, openKeyring } from "./keyring";

let s: Sodium;
beforeAll(async () => {
  s = await loadSodium();
}, 30_000);
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => vi.useRealTimers());

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function setup() {
  const laptopSign = generateSignKeyPair(s);
  const laptopKx = generateKxKeyPair(s);
  const dataKey = generateDataKey(s);
  const keyring = await openKeyring(s, memoryBackend());
  await keyring.ensurePhone();
  await keyring.saveMachine({ machineId: "m1", relayUrl: "https://relay.contoh.com", deviceId: "hp-1", laptopSignPublicKey: laptopSign.publicKey, laptopKxPublicKey: laptopKx.publicKey, kid: 1, dataKey });
  const gate = createGate(s, keyring);
  const keys = laptopSessionKeys(s, laptopKx, keyring.phone()!.kx.publicKey);

  let options!: DeviceConnectionOptions;
  const sent: Array<Record<string, unknown>> = [];
  const relay = fakeRelay();
  const store = createRelayStore({
    relayUrl: "https://relay.contoh.com",
    token: "t".repeat(64),
    api: relay.api,
    e2e: gate,
    newId: () => COMMAND_ID,
    confirmTimeoutMs: 1000,
    connect: (opts) => {
      options = opts;
      return { reconnectNow: vi.fn(), status: () => "online" as const, close: vi.fn(), send: (frame) => (sent.push(frame as Record<string, unknown>), true) };
    },
  });
  store.start();
  await vi.waitFor(() => expect(options).toBeDefined());

  let seq = 100;
  const sealed = (type: string, payload: Record<string, unknown>, sessionId = "s1"): { envelope: Envelope; plaintext: Uint8Array } => {
    const plaintext = utf8(JSON.stringify(payload));
    const approvalId = type === "approval.requested" ? (payload.approvalId as string) : undefined;
    const expiresAt = type === "approval.requested" ? (payload.expiresAt as string) : undefined;
    const base = { v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId, seq: seq++, ts: "2026-11-11T10:00:00.000Z", agent: "claude-code", type, ...(approvalId ? { approvalId } : {}), ...(expiresAt ? { expiresAt } : {}) };
    const payloadSealed = sealEvent(s, { dataKey, kid: 1, envelope: base, plaintext, signPrivateKey: laptopSign.privateKey });
    return { envelope: { ...base, payload: payloadSealed } as unknown as Envelope, plaintext };
  };
  const reply = (body: Record<string, unknown>) => sealSigned(s, keys.tx, laptopSign.privateKey, { direction: "reply", machineId: "m1", deviceId: "hp-1" }, utf8(JSON.stringify(body)));
  const openCommand = (frame: Record<string, unknown>) => JSON.parse(text(openSigned(s, keys.rx, keyring.phone()!.sign.publicKey, { direction: "command", machineId: "m1", deviceId: "hp-1" }, frame.body)));
  const ready = async () => {
    options.onReady();
    await vi.waitFor(() => expect(store.getState().approvalsLoaded).toBe(true));
  };
  return { store, relay, sent, sealed, reply, openCommand, ready, live: (e: Envelope) => options.onEvent(e), onReply: (b: Record<string, unknown>) => options.onReply?.("m1", b), gate };
}

describe("relay-store dengan gerbang E2E: masuk", () => {
  test("event langsung terenkripsi dibuka dan muncul di sesi yang dibuka; event polos dari laptop itu dibuang", async () => {
    const t = await setup();
    t.store.openSession("m1", "s1");
    await t.ready();
    const { envelope } = t.sealed("tool.requested", { toolName: "Write", toolInput: { file_path: "a.ts" } });
    t.live(envelope);
    const events = t.store.getState().events["m1/s1"] ?? [];
    expect(events.map((e) => e.type)).toEqual(["tool.requested"]);
    expect(events[0]?.payload).toEqual({ toolName: "Write", toolInput: { file_path: "a.ts" } });

    t.live(ev(5, { type: "tool.requested", payload: { toolName: "Palsu", toolInput: {} } })); // polos, mengaku dari m1
    expect((t.store.getState().events["m1/s1"] ?? []).length).toBe(1);
    expect(t.gate.stats().plaintextRejected).toBe(1);
  });

  test("permintaan izin terenkripsi masuk antrean (dari event terbuka); penyelesaiannya (terenkripsi) mengeluarkannya", async () => {
    const t = await setup();
    await t.ready();
    t.live(t.sealed("approval.requested", { approvalId: "a1", toolName: "Bash", toolInput: { command: "npm test" }, expiresAt: EXPIRES }).envelope);
    expect(t.store.getState().approvals.map((a) => a.approvalId)).toEqual(["a1"]);
    t.live(t.sealed("approval.resolved", { approvalId: "a1", status: "approved" }).envelope);
    expect(t.store.getState().approvals).toEqual([]);
  });

  test("antrean izin saat sinkronisasi dihitung di HP dari event mentah; antrean 'palsu' dari relay untuk laptop E2E diabaikan", async () => {
    const t = await setup();
    const requested = t.sealed("approval.requested", { approvalId: "a-asli", toolName: "Bash", toolInput: {}, expiresAt: EXPIRES }).envelope;
    t.relay.api.approvalsWithEvents = vi.fn(async () => ({
      approvals: [{ machineId: "m1", sessionId: "s1", approvalId: "a-palsu", toolName: "x", toolInput: {}, requestedAt: "2026-11-11T10:00:00.000Z", expiresAt: EXPIRES }],
      events: [requested],
    }));
    await t.ready();
    expect(t.store.getState().approvals.map((a) => a.approvalId)).toEqual(["a-asli"]);
  });

  test("balasan polos dari laptop E2E dibuang: keputusan yang menunggu tidak berubah", async () => {
    const t = await setup();
    await t.ready();
    t.live(t.sealed("approval.requested", { approvalId: "a1", toolName: "Bash", toolInput: {}, expiresAt: EXPIRES }).envelope);
    t.store.decide("m1", "a1", "approve");
    expect(t.store.getState().decisions[approvalKey("m1", "a1")]?.phase).toBe("sent");
    t.onReply({ type: "approval.result", commandId: COMMAND_ID, approvalId: "a1", outcome: "applied", status: "approved" }); // polos: relay jahat
    expect(t.store.getState().decisions[approvalKey("m1", "a1")]?.phase).toBe("sent");
  });
});

describe("relay-store dengan gerbang E2E: keluar", () => {
  test("keputusan dikirim sebagai amplop tertutup (relay tidak melihat apa-apa), membawa H atas payload yang dilihat HP; balasan terenkripsi menyelesaikannya", async () => {
    const t = await setup();
    await t.ready();
    const seen = t.sealed("approval.requested", { approvalId: "a1", toolName: "Bash", toolInput: { command: "npm test" }, expiresAt: EXPIRES });
    t.live(seen.envelope);
    t.store.decide("m1", "a1", "deny", "tidak boleh");
    expect(t.sent).toHaveLength(1);
    const frame = t.sent[0]!;
    expect(frame.kind).toBe("command");
    expect(frame.machineId).toBe("m1");
    expect(Object.keys(frame.body as object).sort()).toEqual(["c", "n", "s"]);
    expect(JSON.stringify(frame)).not.toContain("tidak boleh");
    const plaintext = t.openCommand(frame);
    expect(plaintext).toMatchObject({ type: "approval.decision", commandId: COMMAND_ID, approvalId: "a1", decision: "deny", comment: "tidak boleh", sessionId: "s1", eventId: seen.envelope.id });
    expect(fromB64(s, plaintext.h)).toEqual(approvalHash(s, seen.plaintext));

    t.onReply(t.reply({ type: "approval.result", commandId: COMMAND_ID, approvalId: "a1", outcome: "applied", status: "denied" }));
    expect(t.store.getState().decisions[approvalKey("m1", "a1")]?.phase).toBe("applied");
  });

  test("izin yang tidak pernah dilihat HP tidak bisa diputuskan: gagal 'invalid', tidak ada yang dikirim", async () => {
    const t = await setup();
    await t.ready();
    t.store.decide("m1", "tidak-dilihat", "approve");
    expect(t.sent).toEqual([]);
    expect(t.store.getState().decisions[approvalKey("m1", "tidak-dilihat")]).toMatchObject({ phase: "failed", reason: "invalid" });
  });

  test("permintaan umum (request) juga disegel dan menunggu balasan terenkripsi", async () => {
    const t = await setup();
    await t.ready();
    const promise = t.store.request("m1", { type: "rollback.restore", checkpointId: "cp-1" });
    expect(t.sent).toHaveLength(1);
    expect(t.openCommand(t.sent[0]!)).toEqual({ type: "rollback.restore", checkpointId: "cp-1", commandId: COMMAND_ID });
    t.onReply(t.reply({ type: "rollback.result", commandId: COMMAND_ID, outcome: "restored" }));
    expect(await promise).toMatchObject({ ok: true, reply: { outcome: "restored" } });
  });
});

describe("relay-store tanpa laptop E2E", () => {
  test("laptop yang tidak dipasangkan E2E: event dan perintah apa adanya (pairing lama tidak terganggu)", async () => {
    const keyring = await openKeyring(s, memoryBackend());
    const gate = createGate(s, keyring);
    let options!: DeviceConnectionOptions;
    const sent: Array<Record<string, unknown>> = [];
    const relay = fakeRelay();
    const store = createRelayStore({
      relayUrl: "https://relay.contoh.com",
      token: "t".repeat(64),
      api: relay.api,
      e2e: gate,
      newId: () => COMMAND_ID,
      connect: (opts) => {
        options = opts;
        return { reconnectNow: vi.fn(), status: () => "online" as const, close: vi.fn(), send: (frame) => (sent.push(frame as Record<string, unknown>), true) };
      },
    });
    store.start();
    store.openSession("m1", "s1");
    options.onReady();
    await vi.waitFor(() => expect(store.getState().approvalsLoaded).toBe(true));
    options.onEvent(ev(1, { type: "approval.requested", payload: { approvalId: "a1", toolName: "Bash", toolInput: {}, expiresAt: EXPIRES } }));
    expect(store.getState().approvals.map((a) => a.approvalId)).toEqual(["a1"]);
    store.decide("m1", "a1", "approve");
    expect(sent[0]?.body).toMatchObject({ type: "approval.decision", approvalId: "a1", decision: "approve" });
  });
});
