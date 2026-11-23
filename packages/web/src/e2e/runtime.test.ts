// @vitest-environment node
// FILE INI: TEST brankas di IndexedDB dan "saklar" runtime E2E (issue #033 bagian C). IndexedDB tiruan (fake-indexeddb) + WebCrypto Node.
import { generateDataKey, generateKxKeyPair, generateSignKeyPair, loadSodium, type Sodium } from "@agentmon/shared/crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { indexedDbBackend, KeyringError, memoryBackend, openKeyring } from "./keyring";
import { e2eStatus, ensureE2e, getE2e, initE2eIfPresent, resetE2eForTests, setE2eMarkers } from "./runtime";

let s: Sodium;
beforeAll(async () => {
  s = await loadSodium();
}, 30_000);
afterEach(() => {
  resetE2eForTests();
  setE2eMarkers(new Set());
});

async function withMachine(backend: ReturnType<typeof memoryBackend>) {
  const keyring = await openKeyring(s, backend);
  await keyring.ensurePhone();
  const laptopSign = generateSignKeyPair(s);
  const laptopKx = generateKxKeyPair(s);
  await keyring.saveMachine({ machineId: "m1", relayUrl: "https://r", deviceId: "hp-1", laptopSignPublicKey: laptopSign.publicKey, laptopKxPublicKey: laptopKx.publicKey, kid: 1, dataKey: generateDataKey(s) });
  return keyring;
}

describe("backend IndexedDB (dibungkus AES-GCM dengan kunci yang tidak dapat diekspor)", () => {
  test("tulis lalu baca kembali persis sama, dan baca sebelum ada isi memberi undefined", async () => {
    const backend = indexedDbBackend(new IDBFactory());
    expect(await backend.read()).toBeUndefined();
    await backend.write('{"v":1,"machines":{}}');
    expect(await backend.read()).toBe('{"v":1,"machines":{}}');
    await backend.write("{}");
    expect(await backend.read()).toBe("{}");
  });

  test("isi yang tersimpan di IndexedDB TIDAK berupa teks biasa (kunci privat tidak terbaca dari dump penyimpanan)", async () => {
    const factory = new IDBFactory();
    const keyring = await openKeyring(s, indexedDbBackend(factory));
    const phone = await keyring.ensurePhone();
    const privateKeyText = Buffer.from(phone.sign.privateKey).toString("base64url");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open("agentmon-e2e", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const raw = await new Promise<{ iv: Uint8Array; ct: Uint8Array }>((resolve, reject) => {
      const req = db.transaction("kv", "readonly").objectStore("kv").get("blob");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const dump = JSON.stringify([...raw.ct]) + Buffer.from(raw.ct).toString("latin1") + Buffer.from(raw.ct).toString("base64");
    expect(dump).not.toContain(privateKeyText);
    expect(dump).not.toContain("privateKey");
    expect(raw.iv).toHaveLength(12);
  });

  test("kunci pembungkus TIDAK dapat diekspor (tidak bisa disalin keluar)", async () => {
    const factory = new IDBFactory();
    await indexedDbBackend(factory).write("x");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open("agentmon-e2e", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const key = await new Promise<CryptoKey>((resolve, reject) => {
      const req = db.transaction("kv", "readonly").objectStore("kv").get("wrap-key");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  test("brankas lengkap lewat IndexedDB: identitas dan laptop bertahan setelah dibuka ulang", async () => {
    const factory = new IDBFactory();
    const first = await withMachine(memoryBackend()); // pembanding
    expect(first.secured("m1")).toBe(true);
    const keyring = await openKeyring(s, indexedDbBackend(factory));
    const phone = await keyring.ensurePhone();
    const reopened = await openKeyring(s, indexedDbBackend(factory));
    expect(Buffer.from(reopened.phone()!.sign.publicKey).equals(Buffer.from(phone.sign.publicKey))).toBe(true);
  });

  test("isi diubah di penyimpanan (bukan oleh aplikasi): dibuka dengan galat jelas, bukan dianggap kosong", async () => {
    const factory = new IDBFactory();
    const backend = indexedDbBackend(factory);
    await backend.write(JSON.stringify({ v: 1, machines: {} }));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open("agentmon-e2e", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({ iv: new Uint8Array(12), ct: new Uint8Array(40) }, "blob"); // ciphertext sembarang
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await expect(backend.read()).rejects.toBeInstanceOf(KeyringError);
  });
});

describe("saklar runtime", () => {
  test("tanpa isi di brankas: tidak ada runtime (libsodium tidak dimuat), dan ensureE2e menghidupkannya sesuai kebutuhan", async () => {
    const backend = memoryBackend();
    expect(await initE2eIfPresent(backend)).toBeUndefined();
    expect(getE2e()).toBeUndefined();
    const live = await ensureE2e(backend);
    expect(getE2e()).toBe(live);
    expect(live.keyring.anySecured()).toBe(false);
  });

  test("brankas berisi laptop E2E: runtime hidup SEBELUM layar digambar, dan gerbang mengenal laptop itu", async () => {
    const backend = memoryBackend();
    await withMachine(backend);
    const live = await initE2eIfPresent(backend);
    expect(live).toBeDefined();
    expect(getE2e()?.gate.isSecured("m1")).toBe(true);
    expect(getE2e()?.gate.isSecured("lain")).toBe(false);
  });

  test("brankas rusak: galat dilempar (layar menjelaskannya), brankas TIDAK dikosongkan", async () => {
    const backend = memoryBackend("{rusak");
    await expect(initE2eIfPresent(backend)).rejects.toBeInstanceOf(KeyringError);
    expect(backend.value()).toBe("{rusak");
  });

  test("ada laptop ditandai E2E (required): gerbang WAJIB hidup walau brankas kosong atau dibersihkan peramban; event polos darinya ditolak", async () => {
    setE2eMarkers(new Set(["m1"]));
    const live = await initE2eIfPresent(memoryBackend(), { required: true });
    expect(live).toBeDefined();
    expect(e2eStatus("m1")).toBe("no-keys");
    expect(e2eStatus("lain")).toBe("none");
    const plain = { v: 1, id: crypto.randomUUID(), machineId: "m1", sessionId: "s", seq: 0, ts: "2026-11-24T10:00:00.000Z", agent: "claude-code", type: "session.started", payload: { cwd: "/" } };
    expect(live!.gate.open(plain as never, true)).toBeUndefined();
  });

  test("ada laptop ditandai E2E tetapi IndexedDB tidak tersedia: galat dilempar (HP tidak diam-diam berjalan tanpa gerbang); tanpa penanda, tidak masalah", async () => {
    const unavailable = { read: async () => { throw new Error("SecurityError"); }, write: async () => undefined };
    await expect(initE2eIfPresent(unavailable, { required: true })).rejects.toBeInstanceOf(KeyringError);
    expect(await initE2eIfPresent(unavailable)).toBeUndefined();
  });

  test("laptop dengan kunci di brankas berstatus ok", async () => {
    const backend = memoryBackend();
    await withMachine(backend);
    setE2eMarkers(new Set(["m1"]));
    await initE2eIfPresent(backend, { required: true });
    expect(e2eStatus("m1")).toBe("ok");
  });

  test("galat KeyringError dari backend (isi tidak bisa dibuka) tidak ditelan: dilempar, bukan dianggap belum ada E2E", async () => {
    const unreadable = { read: async () => { throw new KeyringError("Brankas kunci tidak bisa dibuka."); }, write: async () => undefined };
    await expect(initE2eIfPresent(unreadable)).rejects.toBeInstanceOf(KeyringError);
  });

  test("IndexedDB tidak tersedia (mode privat tertentu): dianggap belum ada E2E, bukan membuat aplikasi gagal", async () => {
    const broken = { read: async () => { throw new Error("SecurityError"); }, write: async () => { throw new Error("SecurityError"); } };
    expect(await initE2eIfPresent(broken)).toBeUndefined();
  });

  test("ensureE2e yang gagal boleh dicoba lagi (penyimpanan baru diizinkan)", async () => {
    let fail = true;
    const flaky = { read: async () => { if (fail) throw new Error("diblokir"); return undefined; }, write: async () => undefined };
    await expect(ensureE2e(flaky)).rejects.toThrow();
    fail = false;
    await expect(ensureE2e(flaky)).resolves.toBeDefined();
  });
});
