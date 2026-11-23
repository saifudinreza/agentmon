// @vitest-environment node
// FILE INI: TEST sisi HP untuk E2E (issue #033 bagian C). Berjalan di lingkungan Node, bukan jsdom: jsdom memakai kelas Uint8Array yang berbeda
// dari milik Node dan libsodium menolaknya; di browser sungguhan tidak ada masalah itu.
// "Laptop" disimulasikan dengan pustaka kripto yang SAMA, jadi yang diuji adalah kontrak kawat yang sama dengan yang akan dipakai daemon.
import {
  approvalHash,
  fromB64,
  generateDataKey,
  generateKxKeyPair,
  generateSignKeyPair,
  laptopSessionKeys,
  loadSodium,
  openSigned,
  pairingFingerprint,
  sealEvent,
  sealSigned,
  signPairChallenge,
  signPairResponse,
  toB64,
  utf8,
  verifyPairProof,
  wrapDataKey,
  type PairRequest,
  type Sodium,
} from "@agentmon/shared/crypto";
import type { Envelope, PairingLink, PendingApproval } from "@agentmon/shared";
import { beforeAll, describe, expect, test } from "vitest";
import { RelayApiError, type RelayApi } from "../relay/api";
import { e2eMachineIds, loadPairings, savePairing } from "../pairing/storage";
import { createGate, gatedApi } from "./gate";
import { KeyringError, memoryBackend, openKeyring, type Keyring } from "./keyring";
import { pairE2e, type E2ePairPhase } from "./pair";

let s: Sodium;
beforeAll(async () => {
  s = await loadSodium();
}, 30_000);

const NOW = "2026-11-24T10:00:00.000Z";
const IN_5_MIN = "2026-11-24T10:05:00.000Z";
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Laptop tiruan: identitas, kunci data, dan cara menyegel event dan balasan. */
function makeLaptop(machineId = "m1") {
  const sign = generateSignKeyPair(s);
  const kx = generateKxKeyPair(s);
  const dataKey = generateDataKey(s);
  let seq = 0;
  return {
    machineId,
    sign,
    kx,
    dataKey,
    event(type: string, payload: Record<string, unknown>, extra: { sessionId?: string; kid?: number; key?: Uint8Array; signWith?: Uint8Array } = {}): { envelope: Envelope; plaintext: Uint8Array } {
      const plaintext = utf8(JSON.stringify(payload));
      const approvalId = type === "approval.requested" ? (payload.approvalId as string) : undefined;
      const expiresAt = type === "approval.requested" ? (payload.expiresAt as string) : undefined;
      const base = { v: 1, id: crypto.randomUUID(), machineId, sessionId: extra.sessionId ?? "s1", seq: seq++, ts: NOW, agent: "claude-code", type };
      const sealed = sealEvent(s, { dataKey: extra.key ?? dataKey, kid: extra.kid ?? 1, envelope: { ...base, ...(approvalId ? { approvalId } : {}), ...(expiresAt ? { expiresAt } : {}) }, plaintext, signPrivateKey: extra.signWith ?? sign.privateKey });
      return { envelope: { ...base, ...(approvalId ? { approvalId } : {}), ...(expiresAt ? { expiresAt } : {}), payload: sealed } as unknown as Envelope, plaintext };
    },
  };
}

/** HP dipasangkan secara E2E dengan laptop itu (langsung ke brankas, tanpa alur pairing). */
async function pairedKeyring(laptop: ReturnType<typeof makeLaptop>, deviceId = "hp-1"): Promise<Keyring> {
  const keyring = await openKeyring(s, memoryBackend());
  await keyring.ensurePhone();
  await keyring.saveMachine({ machineId: laptop.machineId, relayUrl: "https://relay.contoh.com", deviceId, laptopSignPublicKey: laptop.sign.publicKey, laptopKxPublicKey: laptop.kx.publicKey, kid: 1, dataKey: laptop.dataKey });
  return keyring;
}

const requested = (approvalId: string, overrides: Record<string, unknown> = {}) => ({ approvalId, toolName: "Bash", toolInput: { command: "ls" }, expiresAt: IN_5_MIN, ...overrides });

describe("brankas kunci HP", () => {
  test("identitas HP dibuat sekali dan sama setelah dibuka ulang dari backend yang sama", async () => {
    const backend = memoryBackend();
    const first = await openKeyring(s, backend);
    const phone = await first.ensurePhone();
    const again = await openKeyring(s, backend);
    expect(toB64(s, again.phone()!.sign.publicKey)).toBe(toB64(s, phone.sign.publicKey));
    expect(toB64(s, (await again.ensurePhone()).kx.publicKey)).toBe(toB64(s, phone.kx.publicKey));
  });

  test("laptop tersimpan dan dipulihkan; kunci pasangan diturunkan sama dengan sisi laptop (rx = laptop tx, tx = laptop rx)", async () => {
    const laptop = makeLaptop();
    const backend = memoryBackend();
    const keyring = await openKeyring(s, backend);
    await keyring.ensurePhone();
    await keyring.saveMachine({ machineId: "m1", relayUrl: "https://r", deviceId: "hp-1", laptopSignPublicKey: laptop.sign.publicKey, laptopKxPublicKey: laptop.kx.publicKey, kid: 1, dataKey: laptop.dataKey });
    const restored = (await openKeyring(s, backend)).machine("m1")!;
    const laptopKeys = laptopSessionKeys(s, laptop.kx, keyring.phone()!.kx.publicKey);
    expect(restored.rx).toEqual(laptopKeys.tx);
    expect(restored.tx).toEqual(laptopKeys.rx);
    expect(restored.dataKeys.get(1)).toEqual(laptop.dataKey);
    expect(restored.deviceId).toBe("hp-1");
  });

  test("isi rusak atau tidak dikenal MELEMPAR KeyringError dan TIDAK ditimpa (membuang kunci tanpa kabar tidak boleh)", async () => {
    const good = memoryBackend();
    const keyring = await openKeyring(s, good);
    await keyring.ensurePhone();
    const goodText = good.value()!;
    const cases = ["{rusak", "[]", JSON.stringify({ v: 2, machines: {} }), JSON.stringify({ v: 1, machines: { m1: { relayUrl: "x" } } }), JSON.stringify({ v: 1, machines: { m1: { relayUrl: "r", deviceId: "d", laptopSignPublicKey: "A", laptopKxPublicKey: "A", kid: 1, dataKeys: { "1": "A" } } } })];
    for (const raw of cases) {
      const backend = memoryBackend(raw);
      await expect(openKeyring(s, backend)).rejects.toBeInstanceOf(KeyringError);
      expect(backend.value()).toBe(raw);
    }
    expect(goodText.length).toBeGreaterThan(10);
  });

  test("gagal menyimpan: perubahan dibatalkan di memori (tidak memakai kunci yang tidak tersimpan)", async () => {
    const laptop = makeLaptop();
    let fail = false;
    const backend = { read: async () => undefined, write: async () => { if (fail) throw new Error("penyimpanan penuh"); } };
    const keyring = await openKeyring(s, backend);
    await keyring.ensurePhone();
    fail = true;
    await expect(keyring.saveMachine({ machineId: "m1", relayUrl: "r", deviceId: "d", laptopSignPublicKey: laptop.sign.publicKey, laptopKxPublicKey: laptop.kx.publicKey, kid: 1, dataKey: laptop.dataKey })).rejects.toThrow();
    expect(keyring.secured("m1")).toBe(false);
    const fresh = await openKeyring(s, { read: async () => undefined, write: async () => { throw new Error("penuh"); } });
    await expect(fresh.ensurePhone()).rejects.toThrow();
    expect(fresh.phone()).toBeUndefined();
  });

  test("kunci data baru (rotasi) hanya diterima bila kid LEBIH TINGGI; kunci lama dipertahankan untuk riwayat", async () => {
    const laptop = makeLaptop();
    const keyring = await pairedKeyring(laptop);
    const key2 = generateDataKey(s);
    expect(await keyring.addDataKey("m1", 1, generateDataKey(s))).toBe(false);
    expect(await keyring.addDataKey("tidak-ada", 2, key2)).toBe(false);
    expect(await keyring.addDataKey("m1", 2, key2)).toBe(true);
    const m = keyring.machine("m1")!;
    expect(m.kid).toBe(2);
    expect([...m.dataKeys.keys()].sort()).toEqual([1, 2]);
  });

  test("memasangkan ulang laptop dengan kunci tanda tangan BERBEDA membuang kunci data lama; kunci yang sama mempertahankannya", async () => {
    const laptop = makeLaptop();
    const keyring = await pairedKeyring(laptop);
    await keyring.addDataKey("m1", 2, generateDataKey(s));
    const same = await keyring.saveMachine({ machineId: "m1", relayUrl: "r", deviceId: "hp-1", laptopSignPublicKey: laptop.sign.publicKey, laptopKxPublicKey: laptop.kx.publicKey, kid: 3, dataKey: generateDataKey(s) });
    expect([...same.dataKeys.keys()].sort()).toEqual([1, 2, 3]);
    const other = makeLaptop();
    const changed = await keyring.saveMachine({ machineId: "m1", relayUrl: "r", deviceId: "hp-1", laptopSignPublicKey: other.sign.publicKey, laptopKxPublicKey: other.kx.publicKey, kid: 1, dataKey: other.dataKey });
    expect([...changed.dataKeys.keys()]).toEqual([1]);
  });
});

describe("gerbang: event masuk", () => {
  test("laptop yang TIDAK dipasangkan E2E: event diteruskan apa adanya (pairing lama)", async () => {
    const keyring = await openKeyring(s, memoryBackend());
    const gate = createGate(s, keyring);
    const plain = { v: 1, id: crypto.randomUUID(), machineId: "lama", sessionId: "s", seq: 0, ts: NOW, agent: "claude-code", type: "session.started", payload: { cwd: "/x" } } as Envelope;
    expect(gate.open(plain, true)).toBe(plain);
    expect(gate.isSecured("lama")).toBe(false);
  });

  test("laptop E2E: event terenkripsi dan bertanda tangan dibuka menjadi payload biasa; tanda tangan laptop yang benar wajib", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    const { envelope } = laptop.event("tool.requested", { toolName: "Write", toolInput: { file_path: "a.ts" } });
    const opened = gate.open(envelope, true)!;
    expect(opened.payload).toEqual({ toolName: "Write", toolInput: { file_path: "a.ts" } });
    expect(opened.id).toBe(envelope.id);
  });

  test("event POLOS dari laptop E2E DITOLAK walau terlihat sah (penurunan versi), dan dihitung", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    const plain = { v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s", seq: 0, ts: NOW, agent: "claude-code", type: "session.started", payload: { cwd: "/x" } } as Envelope;
    expect(gate.open(plain, true)).toBeUndefined();
    expect(gate.open(plain, false)).toBeUndefined();
    expect(gate.stats().plaintextRejected).toBe(2);
  });

  test("DITOLAK dan dihitung: ciphertext diubah, kolom amplop diubah, ditandatangani pihak lain (pemegang kunci data), laptop lain, kid tak dikenal", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    const good = laptop.event("tool.requested", { toolName: "Bash", toolInput: {} }).envelope;
    const payload = good.payload as { c: string };
    const flipped = fromB64(s, payload.c);
    flipped[0] = flipped[0]! ^ 1;
    const attempts: Envelope[] = [
      { ...good, payload: { ...payload, c: toB64(s, flipped) } },
      { ...good, seq: good.seq + 1 },
      { ...good, sessionId: "sesi-lain" },
      { ...good, type: "approval.resolved" },
      laptop.event("tool.requested", {}, { signWith: generateSignKeyPair(s).privateKey }).envelope, // pemalsu yang memegang kunci data
      makeLaptop("m1").event("tool.requested", {}).envelope, // laptop lain dengan nomor yang sama
      laptop.event("tool.requested", {}, { kid: 9 }).envelope,
    ];
    for (const attempt of attempts) expect(gate.open(attempt, true)).toBeUndefined();
    expect(gate.stats().rejected).toBe(attempts.length);
  });

  test("kid LEBIH RENDAH dari yang terbaru ditolak untuk event langsung, tetapi riwayat lama tetap bisa dibaca", async () => {
    const laptop = makeLaptop();
    const keyring = await pairedKeyring(laptop);
    const key2 = generateDataKey(s);
    await keyring.addDataKey("m1", 2, key2);
    const gate = createGate(s, keyring);
    const oldEvent = laptop.event("tool.requested", { toolName: "Old", toolInput: {} }, { kid: 1 }).envelope;
    expect(gate.open(oldEvent, true)).toBeUndefined();
    expect(gate.open(oldEvent, false)!.payload).toEqual({ toolName: "Old", toolInput: {} });
    expect(gate.open(laptop.event("tool.requested", { toolName: "Baru", toolInput: {} }, { kid: 2, key: key2 }).envelope, true)!.payload).toEqual({ toolName: "Baru", toolInput: {} });
  });

  test("event izin: approvalId dan expiresAt di AMPLOP harus sama dengan isinya; selain itu ditolak", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    const ok = laptop.event("approval.requested", requested("ap-1")).envelope;
    expect(gate.open(ok, true)!.payload).toMatchObject({ approvalId: "ap-1" });

    // amplop berbohong (mis. untuk notifikasi palsu) walau ditandatangani laptop: dibuat dengan menyegel amplop yang berbeda dari isinya
    const plaintext = utf8(JSON.stringify(requested("ap-1")));
    const lying = { v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s1", seq: 99, ts: NOW, agent: "claude-code", type: "approval.requested", approvalId: "ap-LAIN", expiresAt: IN_5_MIN };
    const payload = sealEvent(s, { dataKey: laptop.dataKey, kid: 1, envelope: lying, plaintext, signPrivateKey: laptop.sign.privateKey });
    expect(gate.open({ ...lying, payload } as unknown as Envelope, true)).toBeUndefined();
    // hanya tenggat di amplop yang berbohong (nomor izin sama): tenggat palsu di notifikasi harus ditolak juga
    const lyingExpiry = { ...lying, approvalId: "ap-1", expiresAt: "2099-01-01T00:00:00.000Z" };
    const p3 = sealEvent(s, { dataKey: laptop.dataKey, kid: 1, envelope: lyingExpiry, plaintext, signPrivateKey: laptop.sign.privateKey });
    expect(gate.open({ ...lyingExpiry, payload: p3 } as unknown as Envelope, true)).toBeUndefined();
    // event non-izin yang membawa approvalId di amplop berbeda dari isinya juga ditolak
    const resolvedPlain = utf8(JSON.stringify({ approvalId: "ap-1", status: "approved" }));
    const mismatch = { v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s1", seq: 98, ts: NOW, agent: "claude-code", type: "approval.resolved", approvalId: "ap-LAIN" };
    const p4 = sealEvent(s, { dataKey: laptop.dataKey, kid: 1, envelope: mismatch, plaintext: resolvedPlain, signPrivateKey: laptop.sign.privateKey });
    expect(gate.open({ ...mismatch, payload: p4 } as unknown as Envelope, true)).toBeUndefined();
    const noEnvelopeId = { ...lying, approvalId: undefined };
    const p2 = sealEvent(s, { dataKey: laptop.dataKey, kid: 1, envelope: noEnvelopeId, plaintext, signPrivateKey: laptop.sign.privateKey });
    expect(gate.open({ ...noEnvelopeId, payload: p2 } as unknown as Envelope, true)).toBeUndefined();
  });
});

describe("gerbang: laptop yang DITANDAI E2E tetapi kuncinya tidak ada (pairing terputus, brankas dibersihkan)", () => {
  test("event polos DITOLAK (tidak turun diam-diam ke mode polos); balasan polos ditolak; keputusan tidak dikirim", async () => {
    const keyring = await openKeyring(s, memoryBackend());
    const gate = createGate(s, keyring, (id) => id === "m1", () => true);
    const plain = { v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s", seq: 0, ts: NOW, agent: "claude-code", type: "session.started", payload: { cwd: "/" } } as Envelope;
    expect(gate.open(plain, true)).toBeUndefined();
    expect(gate.isSecured("m1")).toBe(true);
    expect(gate.hasKeys("m1")).toBe(false);
    expect(gate.openReply("m1", { type: "approval.result" })).toBeUndefined();
    expect(gate.sealCommand("m1", { type: "approval.decision", approvalId: "x" })).toEqual({ ok: false, reason: "no-keys" });
    // laptop lain yang tidak ditandai tetap lewat
    expect(gate.open({ ...plain, machineId: "lama" }, true)).toBeDefined();
  });

  test("antrean izin: laptop bertanda tanpa kunci tidak menyumbang apa pun (antrean polos dari relay untuknya pun diabaikan)", async () => {
    const keyring = await openKeyring(s, memoryBackend());
    const gate = createGate(s, keyring, (id) => id === "m1", () => true);
    const relayList: PendingApproval[] = [
      { machineId: "m1", sessionId: "s", approvalId: "ap-palsu", toolName: "x", toolInput: {}, requestedAt: NOW, expiresAt: IN_5_MIN },
      { machineId: "lama", sessionId: "s", approvalId: "ap-lama", toolName: "x", toolInput: {}, requestedAt: NOW, expiresAt: IN_5_MIN },
    ];
    expect(gate.pendingApprovals(relayList, [], new Date(NOW)).map((a) => a.approvalId)).toEqual(["ap-lama"]);
  });
});

describe("brankas dua tab (baca-ubah-tulis)", () => {
  test("tab lama yang menulis belakangan TIDAK menghapus laptop yang dipasangkan tab lain dan TIDAK mengganti identitas HP", async () => {
    const backend = memoryBackend();
    const tabA = await openKeyring(s, backend);
    const tabB = await openKeyring(s, backend);
    const phoneA = await tabA.ensurePhone();
    const laptop1 = makeLaptop("m1");
    await tabA.saveMachine({ machineId: "m1", relayUrl: "https://r", deviceId: "hp-1", laptopSignPublicKey: laptop1.sign.publicKey, laptopKxPublicKey: laptop1.kx.publicKey, kid: 1, dataKey: laptop1.dataKey });
    // tab B belum tahu apa-apa (memori basi), lalu memasangkan laptop kedua
    const phoneB = await tabB.ensurePhone();
    expect(toB64(s, phoneB.sign.publicKey)).toBe(toB64(s, phoneA.sign.publicKey)); // identitas tab A dipakai, bukan dibuat ulang
    const laptop2 = makeLaptop("m2");
    await tabB.saveMachine({ machineId: "m2", relayUrl: "https://r", deviceId: "hp-1", laptopSignPublicKey: laptop2.sign.publicKey, laptopKxPublicKey: laptop2.kx.publicKey, kid: 1, dataKey: laptop2.dataKey });
    const reopened = await openKeyring(s, backend);
    expect(reopened.secured("m1")).toBe(true); // tidak terhapus oleh tab B
    expect(reopened.secured("m2")).toBe(true);
    // tab A menulis lagi (memorinya basi untuk m2): m2 tetap ada
    await tabA.addDataKey("m1", 2, generateDataKey(s));
    expect((await openKeyring(s, backend)).secured("m2")).toBe(true);
  });

  test("reload() mengambil laptop yang dipasangkan tab lain", async () => {
    const backend = memoryBackend();
    const tabA = await openKeyring(s, backend);
    const tabB = await openKeyring(s, backend);
    await tabA.ensurePhone();
    const laptop = makeLaptop("m1");
    await tabA.saveMachine({ machineId: "m1", relayUrl: "https://r", deviceId: "hp-1", laptopSignPublicKey: laptop.sign.publicKey, laptopKxPublicKey: laptop.kx.publicKey, kid: 1, dataKey: laptop.dataKey });
    expect(tabB.secured("m1")).toBe(false);
    await tabB.reload();
    expect(tabB.secured("m1")).toBe(true);
  });

  test("penulisan DISERIALKAN oleh kunci: dua penyimpanan bersamaan tidak saling menimpa", async () => {
    const backend = memoryBackend();
    const queue: Array<() => void> = [];
    let busy = false;
    const lock = async <T,>(fn: () => Promise<T>): Promise<T> => {
      while (busy) await new Promise<void>((resolve) => queue.push(resolve));
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
        queue.shift()?.();
      }
    };
    const a = await openKeyring(s, backend, lock);
    const b = await openKeyring(s, backend, lock);
    await a.ensurePhone();
    await b.reload();
    const l1 = makeLaptop("m1");
    const l2 = makeLaptop("m2");
    await Promise.all([
      a.saveMachine({ machineId: "m1", relayUrl: "https://r", deviceId: "hp-1", laptopSignPublicKey: l1.sign.publicKey, laptopKxPublicKey: l1.kx.publicKey, kid: 1, dataKey: l1.dataKey }),
      b.saveMachine({ machineId: "m2", relayUrl: "https://r", deviceId: "hp-1", laptopSignPublicKey: l2.sign.publicKey, laptopKxPublicKey: l2.kx.publicKey, kid: 1, dataKey: l2.dataKey }),
    ]);
    const final = await openKeyring(s, backend);
    expect(final.secured("m1") && final.secured("m2")).toBe(true);
  });
});

describe("gerbang: perintah keluar dan balasan masuk", () => {
  test("keputusan: disegel dengan sessionId, eventId, dan H atas SELURUH payload yang dilihat HP; laptop membukanya dengan kunci rx dan kunci HP dari catatannya", async () => {
    const laptop = makeLaptop();
    const keyring = await pairedKeyring(laptop);
    const gate = createGate(s, keyring);
    const seen = laptop.event("approval.requested", requested("ap-1", { diff: { files: [] } }), { sessionId: "s-9" });
    gate.open(seen.envelope, true);

    const sealed = gate.sealCommand("m1", { type: "approval.decision", commandId: "c-1", approvalId: "ap-1", decision: "approve" });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    const keys = laptopSessionKeys(s, laptop.kx, keyring.phone()!.kx.publicKey);
    const plaintext = JSON.parse(text(openSigned(s, keys.rx, keyring.phone()!.sign.publicKey, { direction: "command", machineId: "m1", deviceId: "hp-1" }, sealed.body)));
    expect(plaintext).toMatchObject({ type: "approval.decision", approvalId: "ap-1", decision: "approve", sessionId: "s-9", eventId: seen.envelope.id });
    expect(fromB64(s, plaintext.h)).toEqual(approvalHash(s, seen.plaintext));
    // relay tidak melihat apa pun yang bisa dibaca
    expect(JSON.stringify(sealed.body)).not.toContain("approve");
    expect(Object.keys(sealed.body).sort()).toEqual(["c", "n", "s"]);
  });

  test("izin yang TIDAK pernah dilihat HP (tidak ada catatannya) tidak bisa diputuskan; laptop tanpa kunci juga tidak", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    expect(gate.sealCommand("m1", { type: "approval.decision", commandId: "c", approvalId: "tidak-dilihat", decision: "approve" })).toEqual({ ok: false, reason: "unknown-approval" });
    expect(gate.sealCommand("m-asing", { type: "approval.decision", approvalId: "x" })).toEqual({ ok: false, reason: "no-keys" });
  });

  test("perintah lain (rollback, dst.) disegel dan ditandatangani apa adanya tanpa pengayaan keputusan", async () => {
    const laptop = makeLaptop();
    const keyring = await pairedKeyring(laptop);
    const gate = createGate(s, keyring);
    const sealed = gate.sealCommand("m1", { type: "rollback.restore", commandId: "c-2", checkpointId: "cp-1" });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    const keys = laptopSessionKeys(s, laptop.kx, keyring.phone()!.kx.publicKey);
    expect(JSON.parse(text(openSigned(s, keys.rx, keyring.phone()!.sign.publicKey, { direction: "command", machineId: "m1", deviceId: "hp-1" }, sealed.body)))).toEqual({ type: "rollback.restore", commandId: "c-2", checkpointId: "cp-1" });
  });

  test("balasan laptop: dibuka bila terenkripsi dan bertanda tangan laptop; polos, diubah, atau dari kunci lain DITOLAK; laptop lama lewat apa adanya", async () => {
    const laptop = makeLaptop();
    const keyring = await pairedKeyring(laptop);
    const gate = createGate(s, keyring);
    const keys = laptopSessionKeys(s, laptop.kx, keyring.phone()!.kx.publicKey);
    const reply = { type: "approval.result", commandId: "c-1", approvalId: "ap-1", outcome: "applied" };
    const box = sealSigned(s, keys.tx, laptop.sign.privateKey, { direction: "reply", machineId: "m1", deviceId: "hp-1" }, utf8(JSON.stringify(reply)));
    expect(gate.openReply("m1", box)).toEqual(reply);
    expect(gate.openReply("m1", reply)).toBeUndefined(); // balasan polos dari laptop E2E
    expect(gate.openReply("m1", { ...box, c: box.n })).toBeUndefined();
    const forged = sealSigned(s, keys.tx, generateSignKeyPair(s).privateKey, { direction: "reply", machineId: "m1", deviceId: "hp-1" }, utf8(JSON.stringify(reply)));
    expect(gate.openReply("m1", forged)).toBeUndefined();
    const asCommand = sealSigned(s, keys.tx, laptop.sign.privateKey, { direction: "command", machineId: "m1", deviceId: "hp-1" }, utf8("{}"));
    expect(gate.openReply("m1", asCommand)).toBeUndefined();
    expect(gate.openReply("lama", reply)).toEqual(reply);
    expect(gate.stats().rejected).toBe(4);
  });
});

describe("gerbang: API (riwayat dan antrean izin)", () => {
  function fakeApi(over: Partial<RelayApi>): RelayApi {
    return {
      events: async () => ({ events: [], hasMore: false }),
      eventsAfter: async () => [],
      approvals: async () => [],
      approvalsWithEvents: async () => ({ approvals: [], events: [] }),
      ...over,
    } as unknown as RelayApi;
  }

  test("halaman riwayat dibuka; event yang gagal dibuang dan sisanya tetap tampil berurutan", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    const a = laptop.event("tool.requested", { toolName: "A", toolInput: {} }).envelope;
    const bad = { ...laptop.event("tool.requested", { toolName: "B", toolInput: {} }).envelope, seq: 77 };
    const c = laptop.event("tool.requested", { toolName: "C", toolInput: {} }).envelope;
    const pages: Envelope[][] = [];
    const api = gatedApi(fakeApi({ eventsAfter: async (_m, _s, _a, onPage) => { onPage?.([a, bad]); onPage?.([c]); return [a, bad, c]; } }), gate);
    const all = await api.eventsAfter("m1", "s1", -1, (page) => pages.push(page));
    expect(all.map((e) => (e.payload as { toolName: string }).toolName)).toEqual(["A", "C"]);
    expect(pages.map((p) => p.length)).toEqual([1, 1]);
    const first = await gatedApi(fakeApi({ events: async () => ({ events: [a, bad], hasMore: true }) }), gate).events("m1", "s1", -1);
    expect(first.hasMore).toBe(true);
    expect(first.events).toHaveLength(1);
  });

  test("antrean izin laptop E2E dihitung DI HP dari event terbuka; antrean relay untuk laptop itu diabaikan; laptop lama memakai antrean relay", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    const reqA = laptop.event("approval.requested", requested("ap-A")).envelope;
    const reqB = laptop.event("approval.requested", requested("ap-B")).envelope;
    const resolvedB = laptop.event("approval.resolved", { approvalId: "ap-B", status: "approved" }, { sessionId: "s1" });
    // approval.resolved tidak membawa approvalId di amplop pada contoh ini: jangan dipaksa
    const resolved = { ...resolvedB.envelope } as Envelope;
    const relayList: PendingApproval[] = [
      { machineId: "m1", sessionId: "s1", approvalId: "ap-PALSU", toolName: "x", toolInput: {}, requestedAt: NOW, expiresAt: IN_5_MIN },
      { machineId: "lama", sessionId: "s", approvalId: "ap-LAMA", toolName: "y", toolInput: {}, requestedAt: NOW, expiresAt: IN_5_MIN },
    ];
    const api = gatedApi(fakeApi({ approvalsWithEvents: async () => ({ approvals: relayList, events: [reqA, reqB, resolved] }) }), gate, () => new Date(NOW));
    const pending = await api.approvals();
    expect(pending.map((p) => p.approvalId).sort()).toEqual(["ap-A", "ap-LAMA"]);
  });

  test("laptop lama dengan event polos di daftar mentah TIDAK dihitung dua kali (antreannya dari relay saja)", async () => {
    const laptop = makeLaptop();
    const gate = createGate(s, await pairedKeyring(laptop));
    const plainRequested = { v: 1, id: crypto.randomUUID(), machineId: "lama", sessionId: "s", seq: 0, ts: NOW, agent: "claude-code", type: "approval.requested", payload: { approvalId: "ap-LAMA", toolName: "t", toolInput: {}, expiresAt: IN_5_MIN } } as Envelope;
    const relayList: PendingApproval[] = [{ machineId: "lama", sessionId: "s", approvalId: "ap-LAMA", toolName: "t", toolInput: {}, requestedAt: NOW, expiresAt: IN_5_MIN }];
    const api = gatedApi(fakeApi({ approvalsWithEvents: async () => ({ approvals: relayList, events: [plainRequested] }) }), gate, () => new Date(NOW));
    expect((await api.approvals()).map((p) => p.approvalId)).toEqual(["ap-LAMA"]);
  });

  test("tanpa laptop E2E: antrean langsung dari relay (tanpa meminta event mentah)", async () => {
    const keyring = await openKeyring(s, memoryBackend());
    const gate = createGate(s, keyring);
    let rawCalls = 0;
    const list = [{ machineId: "x", sessionId: "s", approvalId: "ap", toolName: "t", toolInput: {}, requestedAt: NOW, expiresAt: IN_5_MIN }] as PendingApproval[];
    const api = gatedApi(fakeApi({ approvals: async () => list, approvalsWithEvents: async () => { rawCalls += 1; return { approvals: [], events: [] }; } }), gate);
    expect(await api.approvals()).toEqual(list);
    expect(rawCalls).toBe(0);
  });
});

// ---- Alur pairing ----
type Messages = Array<{ id: number; kind: "challenge" | "response" | "keys"; body: Record<string, unknown> }>;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k), clear: () => map.clear(), key: () => null, get length() { return map.size; } } as Storage;
}

/** Relay tiruan untuk satu pairing + laptop yang menjawab sesuai skenario. */
function pairScenario(options: { laptop?: ReturnType<typeof makeLaptop>; relayMachineId?: string; respond?: boolean; corruptResponse?: "sig" | "device" | "none"; respondBeforeChallenge?: boolean; challengeLater?: boolean; pollError?: RelayApiError; code?: number; tamperChallenge?: boolean; signedForDevice?: string } = {}) {
  const laptop = options.laptop ?? makeLaptop();
  const secret = s.randombytes_buf(32);
  const link: PairingLink = { code: "kode-sekali-pakai-0123456789abcdef", relayUrl: "https://relay.contoh.com", secret: toB64(s, secret), laptopKey: toB64(s, laptop.sign.publicKey), machineId: laptop.machineId };
  const storage = memoryStorage();
  const messages: Messages = [];
  const phases: E2ePairPhase[] = [];
  let redeemBody: { code: string; name: string; e2e?: { kx: string; sign: string; proof: string } } | undefined;
  let polls = 0;
  const later: Messages = [];
  let request: PairRequest | undefined;
  let laptopFingerprint: string | undefined;

  const fetchFake = (async (_url: string, init?: RequestInit) => {
    redeemBody = JSON.parse(String(init?.body));
    if (options.code && options.code !== 200) return new Response("{}", { status: options.code });
    return new Response(JSON.stringify({ deviceId: "hp-1", machineId: options.relayMachineId ?? laptop.machineId, machineName: "Laptop Dono", deviceToken: "t".repeat(64) }), { status: 200 });
  }) as unknown as typeof fetch;

  // "Laptop": setelah redeem, memverifikasi bukti lalu menjawab lewat kotak surat pada polling berikutnya.
  const laptopActs = () => {
    if (!redeemBody?.e2e || messages.length > 0 || options.respond === false) return;
    request = { code: redeemBody.code, machineId: laptop.machineId, deviceName: redeemBody.name, kxPublicKey: fromB64(s, redeemBody.e2e.kx), signPublicKey: fromB64(s, redeemBody.e2e.sign) };
    if (!verifyPairProof(s, fromB64(s, redeemBody.e2e.proof), request, secret)) return; // bukti salah: laptop menolak, tidak menjawab
    const r = s.randombytes_buf(16);
    laptopFingerprint = pairingFingerprint(s, request, laptop.sign.publicKey, r);
    const sig = signPairChallenge(s, request, r, laptop.sign.privateKey);
    const keys = laptopSessionKeys(s, laptop.kx, request.kxPublicKey);
    const signedFor = options.signedForDevice ?? "hp-1"; // laptop yang SAH menandatangani untuk nomor HP lain (relay menukar nomor)
    const wrapped = wrapDataKey(s, keys.tx, laptop.dataKey, { machineId: laptop.machineId, deviceId: signedFor, kid: 1 });
    const response = { machineId: laptop.machineId, deviceId: signedFor, machineName: "Laptop Dono", laptopKxPublicKey: laptop.kx.publicKey, code: redeemBody.code, kid: 1, phoneKxPublicKey: request.kxPublicKey, phoneSignPublicKey: request.signPublicKey, wrapped };
    let signature = signPairResponse(s, response, laptop.sign.privateKey);
    if (options.corruptResponse === "sig") signature = signature.map((b, i) => (i === 0 ? b ^ 1 : b));
    const body = { deviceId: options.corruptResponse === "device" ? "hp-LAIN" : signedFor, machineName: "Laptop Dono", laptopKx: toB64(s, laptop.kx.publicKey), kid: 1, wrapped, sig: toB64(s, signature) };
    const challenge = { id: 1, kind: "challenge" as const, body: { r: toB64(s, options.tamperChallenge ? s.randombytes_buf(16) : r), sig: toB64(s, sig) } };
    const answer = { id: 2, kind: "response" as const, body };
    if (options.challengeLater) {
      // nomor pesan mengikuti urutan tiba di relay: jawaban lebih dulu (1), tantangan menyusul (2)
      messages.push({ ...answer, id: 1 });
      later.push({ ...challenge, id: 2 });
    } else messages.push(...(options.respondBeforeChallenge ? [answer] : [challenge, answer]));
  };

  const makeApi = () => ({
    e2eMessages: async (_machineId: string, after: number) => {
      polls += 1;
      if (options.pollError) throw options.pollError;
      laptopActs();
      if (later.length > 0 && polls >= 2) messages.push(...later.splice(0));
      return messages.filter((m) => m.id > after);
    },
  });

  const run = async (keyring: Keyring, name = "iPhone Dono") =>
    pairE2e(link, name, { s, keyring, storage, fetch: fetchFake, makeApi, sleep: async () => undefined, waitMs: 300, pollMs: 1, now: (() => { let t = 0; return () => new Date(t++ * 10); })() }, (p) => phases.push(p));

  return { run, link, storage, phases, laptop, polls: () => polls, redeemBody: () => redeemBody, laptopFingerprint: () => laptopFingerprint };
}

describe("pairing E2E di HP", () => {
  const fresh = async () => openKeyring(s, memoryBackend());

  test("jalur sukses: bukti terkirim bersama kunci publik, sidik jari SAMA dengan laptop ditampilkan, kunci data tersimpan, laptop tercatat", async () => {
    const t = pairScenario();
    const keyring = await fresh();
    const outcome = await t.run(keyring);
    expect(outcome.status).toBe("success");
    // bahan E2E ikut ke relay, tanpa rahasia QR
    const sent = t.redeemBody()!;
    expect(sent.e2e).toBeDefined();
    expect(JSON.stringify(sent)).not.toContain(t.link.secret!);
    // sidik jari ditampilkan SEBELUM selesai, dan sama dengan yang dihitung laptop
    const confirm = t.phases.find((p) => p.step === "confirm");
    expect(confirm && "fingerprint" in confirm ? confirm.fingerprint : undefined).toBe(t.laptopFingerprint());
    expect(t.phases.map((p) => p.step)).toEqual(["redeeming", "waiting", "confirm"]);
    // kunci data dan identitas laptop tersimpan di brankas; tidak ada kunci di localStorage
    const m = keyring.machine("m1")!;
    expect(m.dataKeys.get(1)).toEqual(t.laptop.dataKey);
    expect(toB64(s, m.laptopSignPublicKey)).toBe(t.link.laptopKey);
    expect(m.deviceId).toBe("hp-1");
    expect(JSON.stringify(Object.fromEntries([...Array(1)].map(() => [t.storage.getItem("agentmon.pairings")])))).not.toContain(toB64(s, t.laptop.dataKey));
    expect(loadPairings(t.storage).map((p) => p.machines.map((x) => x.id))).toEqual([["m1"]]);
  });

  test("sesudah berhasil, event dari laptop itu hanya diterima terenkripsi (gerbang aktif)", async () => {
    const t = pairScenario();
    const keyring = await fresh();
    await t.run(keyring);
    const gate = createGate(s, keyring);
    expect(gate.open(t.laptop.event("tool.requested", { toolName: "X", toolInput: {} }).envelope, true)).toBeDefined();
    expect(gate.open({ v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s", seq: 0, ts: NOW, agent: "claude-code", type: "session.started", payload: { cwd: "/" } } as Envelope, true)).toBeUndefined();
  });

  test.each([
    ["tanda tangan jawaban diubah", { corruptResponse: "sig" as const }],
    ["jawaban untuk nomor HP lain", { corruptResponse: "device" as const }],
    ["jawaban tiba SEBELUM tantangan (pengguna belum sempat melihat sidik jari)", { respondBeforeChallenge: true }],
    ["tantangan tidak cocok dengan tanda tangannya (relay menukar)", { tamperChallenge: true }],
    ["jawaban SAH bertanda tangan laptop tetapi untuk nomor HP lain (nomor yang diberi relay berbeda)", { signedForDevice: "hp-LAIN" }],
    ["laptop tidak menjawab (bukti salah atau pengguna tidak menjawab)", { respond: false }],
  ])("%s: tidak ada kunci tersimpan, laptop DIBUANG dari pairing HP ini, hasil kedaluwarsa", async (_n, options) => {
    const t = pairScenario(options);
    const keyring = await fresh();
    expect((await t.run(keyring)).status).toBe("e2e-timeout");
    expect(keyring.secured("m1")).toBe(false);
    expect(loadPairings(t.storage)).toEqual([]);
  });

  test("jawaban yang tiba LEBIH DULU dari tantangan tidak hilang: diperiksa begitu sidik jari tampil, lalu pairing selesai", async () => {
    const t = pairScenario({ challengeLater: true });
    const keyring = await fresh();
    expect((await t.run(keyring)).status).toBe("success");
    expect(t.phases.map((p) => p.step)).toEqual(["redeeming", "waiting", "confirm"]);
    expect(keyring.secured("m1")).toBe(true);
  });

  test("laptop ditandai E2E sejak penukaran (sebelum kunci tersimpan), dan penanda hilang bila pairing dibatalkan", async () => {
    const t = pairScenario({ respond: false });
    const keyring = await fresh();
    let markedDuring = false;
    const original = t.storage.setItem.bind(t.storage);
    t.storage.setItem = (k, v) => {
      original(k, v);
      if (e2eMachineIds(loadPairings(t.storage)).has("m1")) markedDuring = true;
    };
    expect((await t.run(keyring)).status).toBe("e2e-timeout");
    expect(markedDuring).toBe(true);
    expect(e2eMachineIds(loadPairings(t.storage)).size).toBe(0);
  });

  test("pairing ULANG yang gagal memulihkan pairing lama yang berfungsi (tidak ikut dihapus beserta token relay)", async () => {
    const t = pairScenario({ respond: false });
    const keyring = await fresh();
    const old = { id: "m1", name: "Laptop Lama", pairedAt: "2026-11-01T00:00:00.000Z" };
    savePairing(t.storage, { relayUrl: "https://relay.contoh.com", deviceId: "hp-1", deviceToken: "t".repeat(64), machine: old });
    expect((await t.run(keyring)).status).toBe("e2e-timeout");
    const [pairing] = loadPairings(t.storage);
    expect(pairing?.machines).toEqual([old]);
    expect(pairing?.deviceToken).toBe("t".repeat(64));
  });

  test("brankas tidak bisa ditulis saat pairing: hasil e2e-unavailable (bukan menunggu sampai habis), dan laptop dibuang dari pairing HP", async () => {
    const t = pairScenario();
    const backend = memoryBackend();
    const keyring = await openKeyring(s, backend);
    await keyring.ensurePhone();
    const failing = { ...keyring, saveMachine: async () => { throw new Error("penyimpanan penuh"); } } as unknown as Keyring;
    expect((await t.run(failing)).status).toBe("e2e-unavailable");
    expect(loadPairings(t.storage)).toEqual([]);
    const noPhone = await openKeyring(s, { read: async () => undefined, write: async () => { throw new Error("penuh"); } });
    expect((await pairScenario().run(noPhone)).status).toBe("e2e-unavailable");
  });

  test("relay memberi nomor laptop yang berbeda dari QR: ditolak (e2e-invalid) dan dibuang", async () => {
    const t = pairScenario({ relayMachineId: "m-lain" });
    const keyring = await fresh();
    expect((await t.run(keyring)).status).toBe("e2e-invalid");
    expect(loadPairings(t.storage)).toEqual([]);
    expect(t.polls()).toBe(0);
  });

  test("perangkat dicabut saat menunggu (laptop menolak): e2e-rejected dan dibuang", async () => {
    const t = pairScenario({ pollError: new RelayApiError("unauthorized") });
    const keyring = await fresh();
    expect((await t.run(keyring)).status).toBe("e2e-rejected");
    expect(loadPairings(t.storage)).toEqual([]);
  });

  test("relay lama (rute kotak surat tidak ada, 404 sejak pertama): e2e-relay-old, bukan menunggu sampai habis", async () => {
    const t = pairScenario({ pollError: new RelayApiError("not-found") });
    const keyring = await fresh();
    expect((await t.run(keyring)).status).toBe("e2e-relay-old");
    expect(t.polls()).toBe(1);
    expect(loadPairings(t.storage)).toEqual([]);
  });

  test("tautan E2E tidak lengkap (kunci laptop tanpa rahasia, dst.) atau rusak: e2e-link, tidak diturunkan diam-diam ke pairing polos, relay tidak dihubungi", async () => {
    const t = pairScenario();
    const keyring = await fresh();
    for (const broken of [{ ...t.link, secret: undefined }, { ...t.link, laptopKey: undefined }, { ...t.link, machineId: undefined }, { ...t.link, laptopKey: "!!" }, { ...t.link, secret: "bukan-base64!" }]) {
      const link = broken as PairingLink;
      const outcome = await pairE2e(link, "iPhone", { s, keyring, storage: t.storage, fetch: (async () => { throw new Error("tidak boleh menghubungi relay"); }) as unknown as typeof fetch }, () => undefined);
      expect(outcome.status).toBe("e2e-link");
    }
  });

  test("nama perangkat tidak baku ditolak sebelum menghubungi relay; nama diperbaiki (NFC, spasi ujung) sebelum dikirim", async () => {
    const t = pairScenario();
    const keyring = await fresh();
    expect((await t.run(keyring, "iPhone​")).status).toBe("e2e-name");
    expect(t.redeemBody()).toBeUndefined();
    expect((await pairScenario().run(keyring, "   ")).status).toBe("e2e-name");
    const ok = pairScenario();
    await ok.run(await fresh(), "  Café  ");
    expect(ok.redeemBody()?.name).toBe("Café");
  });

  test("kode ditolak relay (400 invalid-code): hasil diteruskan dan tidak ada yang disimpan", async () => {
    const t = pairScenario({ code: 400 });
    const keyring = await fresh();
    expect((await t.run(keyring)).status).toBe("invalid-code");
    expect(keyring.secured("m1")).toBe(false);
  });
});
