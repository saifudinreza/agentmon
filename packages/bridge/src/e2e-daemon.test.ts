// FILE INI: TEST petugas segel di laptop (issue #033 bagian D). HP disimulasikan dengan pustaka kripto yang sama seperti PWA.
// Yang dijaga: event tersegel dan terverifikasi di HP, gagal menyegel = melempar (bukan polos), perintah polos ditolak saat E2E aktif,
// perintah palsu / HP dicabut / HP asing / diputar ulang (tahan restart) / izin tak dikenal / kedaluwarsa / H beda / terpotong ditolak,
// balasan tersegel dan bertanda tangan laptop, dan berkas kunci rusak = gagal tertutup.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@agentmon/shared";
import {
  approvalHash,
  fromB64,
  generateKxKeyPair,
  generateSignKeyPair,
  loadSodium,
  openEvent,
  openSigned,
  phoneSessionKeys,
  sealSigned,
  toB64,
  utf8,
  type Sodium,
} from "@agentmon/shared/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDaemonE2e } from "./e2e-daemon";
import { E2E_FILE, loadOrCreateE2e, markDeviceRevoked, saveE2e, trustDevice } from "./e2e-store";
import type { Logger } from "./logger";

let s: Sodium;
let root: string;
let counter = 0;
beforeAll(async () => {
  s = await loadSodium();
  root = mkdtempSync(join(tmpdir(), "agentmon daemon e2e "));
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MACHINE = "m1";
const DEVICE = "hp-1";
const silent: Logger = { info: () => undefined, error: () => undefined };

function setup(options: { trust?: boolean; now?: () => number } = {}) {
  const home = join(root, `kasus ${++counter}`);
  const state = loadOrCreateE2e(s, home);
  const phone = { sign: generateSignKeyPair(s), kx: generateKxKeyPair(s) };
  if (options.trust !== false) {
    saveE2e(home, trustDevice(state, DEVICE, { name: "HP", kx: toB64(s, phone.kx.publicKey), sign: toB64(s, phone.sign.publicKey) }, new Date()));
  }
  const daemon = createDaemonE2e({ s, home, machineId: MACHINE, logger: silent, ...(options.now ? { now: options.now } : {}) });
  const laptopSign = fromB64(s, state.sign.publicKey);
  const keys = phoneSessionKeys(s, phone.kx, fromB64(s, state.kx.publicKey));
  const dataKey = fromB64(s, state.dataKeys["1"]!);
  return { home, daemon, phone, laptopSign, keys, dataKey, state };
}

let n = 0;
const approvalEvent = (payload: Record<string, unknown>, extra: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: `evt-${++n}`,
  machineId: MACHINE,
  sessionId: "sesi-1",
  seq: n,
  ts: "2026-11-24T10:00:00.000Z",
  agent: "claude-code",
  type: "approval.requested",
  payload,
  ...extra,
});

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

/** Perintah dari HP: disegel dengan kunci pasangan HP dan ditandatangani kunci HP. */
function phoneSeals(ctx: ReturnType<typeof setup>, body: Record<string, unknown>, deviceId = DEVICE) {
  return sealSigned(s, ctx.keys.tx, ctx.phone.sign.privateKey, { direction: "command", machineId: MACHINE, deviceId }, utf8(JSON.stringify(body))) as unknown as Record<string, unknown>;
}

describe("seal (event keluar)", () => {
  test("event disegel dan hanya HP yang tahu kunci bisa membukanya; amplop izin membawa approvalId dan expiresAt", () => {
    const ctx = setup();
    const event = approvalEvent({ approvalId: "a1", expiresAt: FUTURE, tool: "Bash", command: "rm -rf /" });
    const sealed = ctx.daemon.seal(event);
    const text = JSON.stringify(sealed);
    expect(text).not.toContain("rm -rf");
    expect(sealed).toMatchObject({ approvalId: "a1", expiresAt: FUTURE, type: "approval.requested" });
    const { approvalId, expiresAt, ...base } = sealed as unknown as Record<string, unknown>;
    const envelope = { v: 1, id: event.id, machineId: MACHINE, sessionId: "sesi-1", seq: event.seq, ts: event.ts, agent: "claude-code", type: "approval.requested", approvalId: approvalId as string, expiresAt: expiresAt as string };
    const opened = openEvent(s, { payload: base.payload, envelope, expectedMachineId: MACHINE, dataKeys: (kid) => (kid === 1 ? ctx.dataKey : undefined), signPublicKey: ctx.laptopSign });
    expect(JSON.parse(new TextDecoder().decode(opened.plaintext))).toMatchObject({ tool: "Bash", command: "rm -rf /" });
  });

  test("event biasa tidak membawa approvalId dan expiresAt", () => {
    const ctx = setup();
    const sealed = ctx.daemon.seal(approvalEvent({ x: 1 }, { type: "tool.requested" })) as unknown as Record<string, unknown>;
    expect(sealed.approvalId).toBeUndefined();
    expect(sealed.expiresAt).toBeUndefined();
  });

  test("izin tanpa approvalId atau expiresAt tidak bisa disegel (dibuang, tidak polos)", () => {
    const ctx = setup();
    expect(() => ctx.daemon.seal(approvalEvent({ approvalId: "a1" }))).toThrow();
    expect(() => ctx.daemon.seal(approvalEvent({ expiresAt: FUTURE }))).toThrow();
  });

  test("tanpa HP terpercaya: tidak aktif dan seal melempar", () => {
    const ctx = setup({ trust: false });
    expect(ctx.daemon.active()).toBe(false);
    expect(() => ctx.daemon.seal(approvalEvent({}, { type: "tool.requested" }))).toThrow();
  });

  test("HP dicabut: E2E tidak aktif lagi (tanpa memulai ulang daemon)", async () => {
    const ctx = setup();
    expect(ctx.daemon.active()).toBe(true);
    await markDeviceRevoked(ctx.home, DEVICE);
    expect(ctx.daemon.active()).toBe(false);
  });

  test("berkas kunci rusak pada laptop yang sudah aktif: tetap dianggap aktif (gagal tertutup), seal melempar, perintah ditolak", () => {
    const ctx = setup();
    expect(ctx.daemon.active()).toBe(true);
    writeFileSync(join(ctx.home, E2E_FILE), "{rusak");
    expect(ctx.daemon.active()).toBe(true);
    expect(() => ctx.daemon.seal(approvalEvent({}, { type: "tool.requested" }))).toThrow();
    expect(ctx.daemon.openCommand(DEVICE, { type: "approval.decision" })).toEqual({ ok: false });
  });
});

describe("openCommand (perintah masuk)", () => {
  function withApproval(options: { truncated?: boolean; now?: () => number } = {}) {
    const ctx = setup(options.now ? { now: options.now } : {});
    const payload = { approvalId: "a1", expiresAt: FUTURE, tool: "Bash", command: "ls", ...(options.truncated ? { truncated: true } : {}) };
    const event = approvalEvent(payload);
    ctx.daemon.seal(event);
    const h = toB64(s, approvalHash(s, utf8(JSON.stringify(payload))));
    const decision = (extra: Record<string, unknown> = {}) => ({ type: "approval.decision", commandId: `c-${++n}`, approvalId: "a1", decision: "allow", sessionId: "sesi-1", eventId: event.id, h, ...extra });
    return { ctx, event, h, decision };
  }

  test("tanpa E2E aktif: perintah polos diteruskan apa adanya", () => {
    const ctx = setup({ trust: false });
    const body = { type: "approval.decision", approvalId: "a1" };
    expect(ctx.daemon.openCommand(DEVICE, body)).toEqual({ ok: true, command: body });
  });

  test("E2E aktif: perintah polos ditolak", () => {
    const { ctx } = withApproval();
    expect(ctx.daemon.openCommand(DEVICE, { type: "approval.decision", approvalId: "a1", decision: "allow" })).toEqual({ ok: false });
  });

  test("keputusan sah diterima dan kolom bukti (sessionId, eventId, h) dibuang", () => {
    const { ctx, decision } = withApproval();
    const body = decision();
    const verdict = ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, body));
    expect(verdict).toEqual({ ok: true, command: { type: "approval.decision", commandId: body.commandId, approvalId: "a1", decision: "allow" } });
  });

  test("perintah yang sama diputar ulang ditolak, juga sesudah daemon dimulai ulang", () => {
    const { ctx, decision } = withApproval();
    const sealed = phoneSeals(ctx, decision());
    expect(ctx.daemon.openCommand(DEVICE, sealed).ok).toBe(true);
    expect(ctx.daemon.openCommand(DEVICE, sealed).ok).toBe(false);
    const restarted = createDaemonE2e({ s, home: ctx.home, machineId: MACHINE, logger: silent });
    expect(restarted.openCommand(DEVICE, sealed).ok).toBe(false);
  });

  test("tanda tangan dari kunci lain (relay atau HP asing) ditolak", () => {
    const { ctx, decision } = withApproval();
    const stranger = generateSignKeyPair(s);
    const forged = sealSigned(s, ctx.keys.tx, stranger.privateKey, { direction: "command", machineId: MACHINE, deviceId: DEVICE }, utf8(JSON.stringify(decision())));
    expect(ctx.daemon.openCommand(DEVICE, forged as unknown as Record<string, unknown>).ok).toBe(false);
  });

  test("amplop yang diubah satu karakter ditolak", () => {
    const { ctx, decision } = withApproval();
    const sealed = phoneSeals(ctx, decision()) as { n: string; c: string; s: string };
    const flipped = { ...sealed, c: `${sealed.c.slice(0, -2)}${sealed.c.endsWith("AA") ? "BB" : "AA"}` };
    expect(ctx.daemon.openCommand(DEVICE, flipped).ok).toBe(false);
  });

  test("amplop untuk nomor HP lain ditolak (terikat ke HP pengirim)", () => {
    const { ctx, decision } = withApproval();
    expect(ctx.daemon.openCommand("hp-lain", phoneSeals(ctx, decision())).ok).toBe(false);
  });

  test("HP yang dicabut tidak bisa memberi perintah", async () => {
    const { ctx, decision } = withApproval();
    const sealed = phoneSeals(ctx, decision());
    await markDeviceRevoked(ctx.home, DEVICE);
    expect(ctx.daemon.openCommand(DEVICE, sealed)).toEqual({ ok: true, command: sealed }); // tidak ada HP terpercaya: E2E mati, jalur polos lagi
  });

  test("HP dicabut tetapi HP lain masih terpercaya: perintah HP yang dicabut ditolak", async () => {
    const ctx = setup();
    const other = { sign: generateSignKeyPair(s), kx: generateKxKeyPair(s) };
    const state = loadOrCreateE2e(s, ctx.home);
    saveE2e(ctx.home, trustDevice(state, "hp-2", { name: "HP 2", kx: toB64(s, other.kx.publicKey), sign: toB64(s, other.sign.publicKey) }, new Date()));
    await markDeviceRevoked(ctx.home, DEVICE);
    expect(ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, { type: "x", commandId: "c-revoked" })).ok).toBe(false);
  });

  test("perintah tanpa nomor perintah ditolak", () => {
    const { ctx } = withApproval();
    expect(ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, { type: "rollback" })).ok).toBe(false);
  });

  test("perintah lain yang sah (bukan keputusan) diteruskan dengan isinya", () => {
    const { ctx } = withApproval();
    const body = { type: "rollback", commandId: `c-${++n}`, sessionId: "sesi-1" };
    expect(ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, body))).toEqual({ ok: true, command: body });
  });

  test("izin yang tidak dikenal laptop ditolak dan dijawab 'unknown'", () => {
    const { ctx, decision } = withApproval();
    const body = decision({ approvalId: "tidak-ada" });
    expect(ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, body))).toEqual({ ok: false, reply: { type: "approval.result", commandId: body.commandId, approvalId: "tidak-ada", outcome: "unknown" } });
  });

  test("izin kedaluwarsa menurut JAM LAPTOP ditolak", () => {
    let clock = Date.now();
    const { ctx, decision } = withApproval({ now: () => clock });
    clock += 2 * 3_600_000;
    const verdict = ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, decision()));
    expect(verdict.ok).toBe(false);
  });

  test.each([
    ["H berbeda (HP melihat isi lain)", { h: "A".repeat(43) }],
    ["H rusak", { h: "***" }],
    ["sesi berbeda", { sessionId: "sesi-lain" }],
    ["nomor event berbeda", { eventId: "evt-lain" }],
  ])("%s ditolak dan dijawab 'invalid'", (_name, extra) => {
    const { ctx, decision } = withApproval();
    const body = decision(extra);
    expect(ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, body))).toEqual({ ok: false, reply: { type: "approval.result", commandId: body.commandId, approvalId: "a1", outcome: "invalid" } });
  });

  test("izin terpotong: 'allow' ditolak tetapi 'deny' diterima", () => {
    const { ctx, decision } = withApproval({ truncated: true });
    expect(ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, decision())).ok).toBe(false);
    expect(ctx.daemon.openCommand(DEVICE, phoneSeals(ctx, decision({ decision: "deny" }))).ok).toBe(true);
  });
});

describe("sealReply (balasan ke HP)", () => {
  test("disegel dan bertanda tangan laptop; HP membukanya dengan kunci laptop yang dikenalnya", () => {
    const ctx = setup();
    const box = ctx.daemon.sealReply(DEVICE, { type: "approval.result", outcome: "applied" });
    expect(box).toBeDefined();
    const opened = openSigned(s, ctx.keys.rx, ctx.laptopSign, { direction: "reply", machineId: MACHINE, deviceId: DEVICE }, box);
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ type: "approval.result", outcome: "applied" });
    expect(JSON.stringify(box)).not.toContain("applied");
  });

  test("HP tidak dikenal atau dicabut tidak dibalas", async () => {
    const ctx = setup();
    expect(ctx.daemon.sealReply("asing", { a: 1 })).toBeUndefined();
    await markDeviceRevoked(ctx.home, DEVICE);
    expect(ctx.daemon.sealReply(DEVICE, { a: 1 })).toBeUndefined();
  });

  test("balasan untuk HP A tidak bisa dibuka sebagai balasan untuk HP B", () => {
    const ctx = setup();
    const box = ctx.daemon.sealReply(DEVICE, { a: 1 });
    expect(() => openSigned(s, ctx.keys.rx, ctx.laptopSign, { direction: "reply", machineId: MACHINE, deviceId: "hp-b" }, box)).toThrow();
  });
});
