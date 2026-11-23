// FILE INI: TEST klien relay dengan E2E aktif (issue #033 bagian D): yang keluar dari daemon ke relay tidak pernah polos, perintah polos tidak
// sampai ke mesin keputusan, perintah sah sampai, dan balasan disegel. Relay palsu minimal; kripto dan HP sungguhan (bukan tiruan).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@agentmon/shared";
import { approvalHash, fromB64, generateKxKeyPair, generateSignKeyPair, loadSodium, openSigned, phoneSessionKeys, sealSigned, toB64, utf8, type Sodium } from "@agentmon/shared/crypto";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDaemonE2e } from "./e2e-daemon";
import { loadOrCreateE2e, saveE2e, trustDevice } from "./e2e-store";
import type { Logger } from "./logger";
import { createRelayClient, type RelayClient } from "./relay-client";

const MACHINE = "m1";
const DEVICE = "hp-1";
let s: Sodium;
let root: string;
const stoppers: Array<() => Promise<void> | void> = [];
beforeAll(async () => {
  s = await loadSodium();
  root = mkdtempSync(join(tmpdir(), "agentmon relay e2e "));
}, 30_000);
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const silent: Logger = { info: () => undefined, error: () => undefined };

async function harness(options: { trust: boolean }) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const received: Array<{ kind: string; event?: Envelope; body?: Record<string, unknown>; deviceId?: string }> = [];
  let socket: ServerSocket | undefined;
  wss.on("connection", (conn) => {
    socket = conn;
    conn.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { kind: string; event?: Envelope };
      if (frame.kind === "hello") return void conn.send(JSON.stringify({ kind: "welcome", role: "machine", id: MACHINE }));
      received.push(frame);
      if (frame.kind === "event" && frame.event) conn.send(JSON.stringify({ kind: "ack", eventId: frame.event.id }));
    });
  });

  const home = join(root, `kasus ${stoppers.length}-${Math.random().toString(36).slice(2)}`);
  const state = loadOrCreateE2e(s, home);
  const phone = { sign: generateSignKeyPair(s), kx: generateKxKeyPair(s) };
  if (options.trust) saveE2e(home, trustDevice(state, DEVICE, { name: "HP", kx: toB64(s, phone.kx.publicKey), sign: toB64(s, phone.sign.publicKey) }, new Date()));
  const keys = phoneSessionKeys(s, phone.kx, fromB64(s, state.kx.publicKey));
  const decisions: Array<Record<string, unknown>> = [];
  const e2e = createDaemonE2e({ s, home, machineId: MACHINE, logger: silent });
  const client: RelayClient = createRelayClient({
    url: `ws://127.0.0.1:${port}`,
    token: "t".repeat(40),
    machineId: MACHINE,
    decide: (input) => (decisions.push(input as Record<string, unknown>), { ok: true }),
    e2e,
    logger: silent,
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    ackTimeoutMs: 500,
  });
  stoppers.push(() => client.close(), () => new Promise<void>((resolve) => wss.close(() => resolve())));
  await vi.waitFor(() => expect(client.stats().state).toBe("ready"), { timeout: 5000 });
  const sendCommand = (body: unknown) => socket?.send(JSON.stringify({ kind: "command", deviceId: DEVICE, body }));
  const phoneCommand = (body: Record<string, unknown>) =>
    sealSigned(s, keys.tx, phone.sign.privateKey, { direction: "command", machineId: MACHINE, deviceId: DEVICE }, utf8(JSON.stringify(body)));
  return { client, received, decisions, sendCommand, phoneCommand, keys, laptopSign: fromB64(s, state.sign.publicKey) };
}

let n = 0;
const makeEvent = (type: string, payload: Record<string, unknown>): Envelope => ({
  v: 1,
  id: `e-${++n}`,
  machineId: MACHINE,
  sessionId: "sesi-1",
  seq: n,
  ts: "2026-11-24T10:00:00.000Z",
  agent: "claude-code",
  type: type as Envelope["type"],
  payload,
});

describe("klien relay + E2E aktif", () => {
  test("event keluar tersegel: relay tidak melihat isinya; izin membawa approvalId dan expiresAt", async () => {
    const h = await harness({ trust: true });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    h.client.send(makeEvent("approval.requested", { approvalId: "a1", expiresAt, command: "rahasia-sekali" }));
    h.client.send(makeEvent("tool.requested", { command: "rahasia-dua" }));
    await vi.waitFor(() => expect(h.received.filter((f) => f.kind === "event")).toHaveLength(2));
    const text = JSON.stringify(h.received);
    expect(text).not.toContain("rahasia-sekali");
    expect(text).not.toContain("rahasia-dua");
    expect(h.received[0]?.event).toMatchObject({ approvalId: "a1", expiresAt });
  });

  test("event yang gagal disegel dibuang dan tidak pernah dikirim polos", async () => {
    const h = await harness({ trust: true });
    h.client.send(makeEvent("approval.requested", { command: "rahasia-tanpa-id" })); // tanpa approvalId/expiresAt: tidak bisa disegel
    h.client.send(makeEvent("tool.requested", { command: "rahasia-berikutnya" }));
    await vi.waitFor(() => expect(h.received.filter((f) => f.kind === "event")).toHaveLength(1));
    expect(JSON.stringify(h.received)).not.toContain("rahasia-tanpa-id");
    expect(h.client.stats().dropped).toBeGreaterThan(0);
  });

  test("tanpa HP terpercaya: event tetap polos seperti dulu", async () => {
    const h = await harness({ trust: false });
    h.client.send(makeEvent("tool.requested", { command: "polos" }));
    await vi.waitFor(() => expect(h.received.filter((f) => f.kind === "event")).toHaveLength(1));
    expect(JSON.stringify(h.received)).toContain("polos");
  });

  test("perintah polos ditolak: mesin keputusan tidak dipanggil dan tidak ada balasan", async () => {
    const h = await harness({ trust: true });
    h.sendCommand({ type: "approval.decision", commandId: "c-polos", approvalId: "a1", decision: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.decisions).toHaveLength(0);
    expect(h.received.filter((f) => f.kind === "reply")).toHaveLength(0);
  });

  test("keputusan sah sampai ke mesin keputusan dan balasannya tersegel (HP bisa membukanya)", async () => {
    const h = await harness({ trust: true });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const payload = { approvalId: "a1", expiresAt, command: "ls" };
    const event = makeEvent("approval.requested", payload);
    h.client.send(event);
    await vi.waitFor(() => expect(h.received.filter((f) => f.kind === "event")).toHaveLength(1));
    const hash = toB64(s, approvalHash(s, utf8(JSON.stringify(payload))));
    h.sendCommand(h.phoneCommand({ type: "approval.decision", commandId: "c-sah", approvalId: "a1", decision: "allow", sessionId: "sesi-1", eventId: event.id, h: hash }));
    await vi.waitFor(() => expect(h.decisions).toHaveLength(1));
    expect(h.decisions[0]).toMatchObject({ approvalId: "a1", decision: "allow" });
    expect(h.decisions[0]).not.toHaveProperty("h");
    await vi.waitFor(() => expect(h.received.filter((f) => f.kind === "reply")).toHaveLength(1));
    const reply = h.received.find((f) => f.kind === "reply");
    expect(JSON.stringify(reply)).not.toContain("applied");
    const opened = openSigned(s, h.keys.rx, h.laptopSign, { direction: "reply", machineId: MACHINE, deviceId: DEVICE }, reply?.body);
    expect(JSON.parse(new TextDecoder().decode(opened))).toMatchObject({ type: "approval.result", approvalId: "a1", outcome: "applied" });
  });

  test("keputusan dengan H yang salah ditolak dan HP diberi tahu 'invalid' (tersegel)", async () => {
    const h = await harness({ trust: true });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const event = makeEvent("approval.requested", { approvalId: "a1", expiresAt, command: "ls" });
    h.client.send(event);
    await vi.waitFor(() => expect(h.received.filter((f) => f.kind === "event")).toHaveLength(1));
    h.sendCommand(h.phoneCommand({ type: "approval.decision", commandId: "c-h", approvalId: "a1", decision: "allow", sessionId: "sesi-1", eventId: event.id, h: "A".repeat(43) }));
    await vi.waitFor(() => expect(h.received.filter((f) => f.kind === "reply")).toHaveLength(1));
    expect(h.decisions).toHaveLength(0);
    const reply = h.received.find((f) => f.kind === "reply");
    const opened = openSigned(s, h.keys.rx, h.laptopSign, { direction: "reply", machineId: MACHINE, deviceId: DEVICE }, reply?.body);
    expect(JSON.parse(new TextDecoder().decode(opened))).toMatchObject({ outcome: "invalid" });
  });
});
