// FILE INI: TEST pairing E2E di sisi laptop (issue #033 bagian B). HP disimulasikan dengan pustaka kripto yang SAMA seperti PWA nanti.
// Yang dijaga: bukti rahasia QR, tantangan dan sidik jari yang cocok di kedua sisi, konfirmasi manusia (tanpa 'y' tidak ada kunci),
// penolakan bukti palsu, kunci data sampai ke HP yang benar, tidak ada kepercayaan tersisa bila gagal, dan berkas kunci yang aman.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingUrl } from "@agentmon/shared";
import {
  fromB64,
  generateKxKeyPair,
  generateSignKeyPair,
  loadSodium,
  makePairProof,
  pairingFingerprint,
  phoneSessionKeys,
  toB64,
  unwrapDataKey,
  verifyPairChallenge,
  verifyPairResponse,
  type PairRequest,
  type Sodium,
} from "@agentmon/shared/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { E2E_FILE, E2eStoreError, currentDataKey, e2eActive, loadE2e, loadOrCreateE2e, saveE2e, trustedDevices } from "./e2e-store";
import { runPair } from "./pairing";

let s: Sodium;
let root: string;
let counter = 0;
beforeAll(async () => {
  s = await loadSodium();
  root = mkdtempSync(join(tmpdir(), "agentmon e2e "));
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CODE = "kode-sekali-pakai-0123456789abcdef";
const posix = process.platform !== "win32";

type Posted = { kind: string; deviceId: string; body: Record<string, unknown> };

/** Relay palsu minimal + HP yang "memindai QR" saat runPair menunggu. */
function scenario(options: { confirm?: boolean; hpMode?: "ok" | "wrong-secret" | "swap-kx" | "zero-width-name" | "legacy"; failResponse?: boolean; failChallenge?: boolean } = {}) {
  const home = join(root, `kasus ${++counter}`);
  const out: string[] = [];
  const err: string[] = [];
  const posted: Posted[] = [];
  const revoked: string[] = [];
  const devices: Array<{ id: string; name: string; pairedAt: string; e2e?: { kx: string; sign: string; proof: string } }> = [];
  const phone = { sign: generateSignKeyPair(s), kx: generateKxKeyPair(s) };
  let scanned = false;
  let qr: ReturnType<typeof parsePairingUrl>;
  let confirmCalls = 0;

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/pair/devices" && method === "GET") return json(200, { devices });
    if (url.pathname === "/pair/code") return json(201, { code: CODE, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (url.pathname === "/pair/e2e/messages" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Posted;
      if ((body.kind === "response" && options.failResponse) || (body.kind === "challenge" && options.failChallenge)) return json(404, { error: "not-found" });
      posted.push(body);
      return json(201, { ok: true });
    }
    if (url.pathname.startsWith("/pair/devices/") && method === "DELETE") {
      revoked.push(decodeURIComponent(url.pathname.split("/").pop()!));
      return json(200, { ok: true });
    }
    return json(404, {});
  }) as unknown as typeof fetch;

  // HP memindai QR begitu laptop mulai menunggu (satu kali), dengan perilaku sesuai skenario.
  const sleep = async () => {
    if (scanned) return;
    scanned = true;
    qr = parsePairingUrl(out.find((line) => line.startsWith("https://")) ?? "");
    const mode = options.hpMode ?? "ok";
    if (mode === "legacy") {
      devices.push({ id: "hp-1", name: "HP lama", pairedAt: new Date().toISOString() });
      return;
    }
    const secret = mode === "wrong-secret" ? s.randombytes_buf(32) : fromB64(s, qr!.secret!);
    const name = mode === "zero-width-name" ? "iPhone Dono​" : "iPhone Dono";
    const request: PairRequest = { code: CODE, machineId: "m1", deviceName: name.normalize("NFC").trim(), kxPublicKey: phone.kx.publicKey, signPublicKey: phone.sign.publicKey };
    // zero-width: HP jahat membuat bukti atas nama yang sama persis dengan yang dikirim ke relay
    const proof = mode === "zero-width-name" ? s.crypto_auth(new TextEncoder().encode("bukti-tak-penting"), s.randombytes_buf(32)) : makePairProof(s, request, secret);
    const kxSent = mode === "swap-kx" ? generateKxKeyPair(s).publicKey : phone.kx.publicKey;
    devices.push({ id: "hp-1", name, pairedAt: new Date().toISOString(), e2e: { kx: toB64(s, kxSent), sign: toB64(s, phone.sign.publicKey), proof: toB64(s, proof) } });
  };

  const run = () =>
    runPair({
      relayUrl: "https://relay.contoh.com",
      machineToken: "t".repeat(40),
      appUrl: "https://app.contoh.com",
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      fetch: fetchFake,
      sleep,
      pollMs: 1,
      renderQr: async () => "[QR]",
      e2e: {
        home,
        machineId: "m1",
        machineName: "Laptop Dono",
        confirm: async (question) => {
          confirmCalls += 1;
          out.push(`PROMPT: ${question}`);
          return options.confirm ?? true;
        },
      },
    });

  return { run, home, out, err, posted, revoked, phone, devices, qr: () => qr, confirmCalls: () => confirmCalls };
}

describe("pairing E2E di laptop: jalur sukses", () => {
  test("HP yang sah: sidik jari SAMA di kedua sisi, kunci data sampai ke HP itu, dan HP dipercaya di laptop", async () => {
    const t = scenario();
    expect(await t.run()).toBe(0);
    expect(t.revoked).toEqual([]);

    const challenge = t.posted.find((p) => p.kind === "challenge")!;
    const response = t.posted.find((p) => p.kind === "response")!;
    expect(challenge.deviceId).toBe("hp-1");
    const laptopKey = fromB64(s, t.qr()!.laptopKey!);

    // Sisi HP: memverifikasi tantangan dan menghitung sidik jari sendiri (dengan kunci laptop dari QR, bukan dari relay).
    const request: PairRequest = { code: CODE, machineId: "m1", deviceName: "iPhone Dono", kxPublicKey: t.phone.kx.publicKey, signPublicKey: t.phone.sign.publicKey };
    const r = fromB64(s, challenge.body.r as string);
    expect(verifyPairChallenge(s, fromB64(s, challenge.body.sig as string), request, r, laptopKey)).toBe(true);
    const phoneFingerprint = pairingFingerprint(s, request, laptopKey, r);
    expect(t.out.join("\n")).toContain(`${phoneFingerprint.slice(0, 3)} ${phoneFingerprint.slice(3)}`);

    // Sisi HP: memverifikasi jawaban bertanda tangan dan membuka kunci data.
    const body = response.body as { deviceId: string; machineName: string; laptopKx: string; kid: number; wrapped: { n: string; c: string }; sig: string };
    const full = { machineId: "m1", deviceId: body.deviceId, machineName: body.machineName, laptopKxPublicKey: fromB64(s, body.laptopKx), code: CODE, kid: body.kid, phoneKxPublicKey: t.phone.kx.publicKey, phoneSignPublicKey: t.phone.sign.publicKey, wrapped: body.wrapped };
    expect(verifyPairResponse(s, fromB64(s, body.sig), full, laptopKey)).toBe(true);
    const keys = phoneSessionKeys(s, t.phone.kx, fromB64(s, body.laptopKx));
    const dataKey = unwrapDataKey(s, keys.rx, body.wrapped, { machineId: "m1", deviceId: "hp-1", kid: body.kid });
    const state = loadE2e(t.home)!;
    expect(dataKey).toEqual(currentDataKey(s, state));

    // Sisi laptop: HP dipercaya dengan kunci publiknya, E2E menyala.
    expect(trustedDevices(state).map(([id]) => id)).toEqual(["hp-1"]);
    expect(state.devices["hp-1"]?.sign).toBe(toB64(s, t.phone.sign.publicKey));
    expect(e2eActive(t.home)).toBe(true);
    expect(t.out.join("\n")).toMatch(/terenkripsi ujung-ke-ujung/);
  });

  test("QR memuat rahasia (s) dan kunci publik laptop (k) HANYA di fragmen; rahasia tidak pernah dikirim ke relay atau disimpan", async () => {
    const t = scenario();
    await t.run();
    const link = t.qr()!;
    expect(link.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.laptopKey).toBe(loadE2e(t.home)!.sign.publicKey);
    const urlLine = t.out.find((line) => line.startsWith("https://"))!;
    expect(new URL(urlLine).search).toBe("");
    // rahasia tidak ada di apa pun yang dikirim ke relay, dan tidak ada di berkas kunci
    expect(JSON.stringify(t.posted)).not.toContain(link.secret!);
    expect(readFileSync(join(t.home, E2E_FILE), "utf8")).not.toContain(link.secret!);
  });

  test("tantangan sidik jari acak baru tiap pairing (bukan nol dan tidak berulang), dan laptop yang sama tetap memakai kunci tanda tangan yang sama", async () => {
    const challenges: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = scenario();
      await t.run();
      challenges.push(t.posted.find((p) => p.kind === "challenge")!.body.r as string);
      expect(fromB64(s, challenges[i]!).some((byte) => byte !== 0)).toBe(true);
    }
    expect(new Set(challenges).size).toBe(3);
  });

  test.runIf(posix)("berkas kunci hanya bisa dibaca pemilik (0600), dan tidak ada berkas sementara tersisa", async () => {
    const t = scenario();
    await t.run();
    expect(statSync(join(t.home, E2E_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(t.home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("pairing E2E di laptop: penolakan", () => {
  test("pengguna menjawab TIDAK: tidak ada kunci dibagikan, HP dicabut, tidak ada kepercayaan, kode keluar 1", async () => {
    const t = scenario({ confirm: false });
    expect(await t.run()).toBe(1);
    expect(t.revoked).toEqual(["hp-1"]);
    expect(t.posted.some((p) => p.kind === "response")).toBe(false);
    expect(trustedDevices(loadE2e(t.home)!)).toEqual([]);
    expect(e2eActive(t.home)).toBe(false);
  });

  test.each([
    ["rahasia QR salah (relay atau penyerang tanpa rahasia)", "wrong-secret"],
    ["kunci HP ditukar relay setelah bukti dibuat", "swap-kx"],
    ["nama berakhiran karakter lebar-nol", "zero-width-name"],
  ] as const)("%s: DITOLAK tanpa menanyakan pengguna, HP dicabut, tidak ada tantangan atau kunci dikirim", async (_n, hpMode) => {
    const t = scenario({ hpMode });
    expect(await t.run()).toBe(1);
    expect(t.confirmCalls()).toBe(0);
    expect(t.revoked).toEqual(["hp-1"]);
    expect(t.posted).toEqual([]);
    expect(e2eActive(t.home)).toBe(false);
    expect(t.err.join("\n")).toMatch(/bukti rahasia QR tidak sah/);
  });

  test("jawaban gagal terkirim: kepercayaan DIBATALKAN (tidak menyisakan HP yang tak pernah menerima kunci) dan HP dicabut", async () => {
    const t = scenario({ failResponse: true });
    expect(await t.run()).toBe(1);
    expect(t.revoked).toEqual(["hp-1"]);
    expect(loadE2e(t.home)!.devices).toEqual({});
    expect(e2eActive(t.home)).toBe(false);
  });

  test("tantangan gagal terkirim: tidak ada pertanyaan ke pengguna, HP dicabut", async () => {
    const t = scenario({ failChallenge: true });
    expect(await t.run()).toBe(1);
    expect(t.confirmCalls()).toBe(0);
    expect(t.revoked).toEqual(["hp-1"]);
  });

  test("tanpa terminal (bukan TTY) jawaban bawaan adalah TIDAK: tidak pernah ada persetujuan otomatis", async () => {
    const { promptYesNo } = await import("./pairing-e2e");
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      expect(await promptYesNo("Pasangkan?")).toBe(false);
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

describe("HP versi lama (tanpa bahan E2E)", () => {
  test("tetap terpasang seperti dulu, tidak dipercaya sebagai HP terenkripsi, dan diberi peringatan jelas", async () => {
    const t = scenario({ hpMode: "legacy" });
    expect(await t.run()).toBe(0);
    expect(t.confirmCalls()).toBe(0);
    expect(t.posted).toEqual([]);
    expect(e2eActive(t.home)).toBe(false);
    expect(t.out.join("\n")).toMatch(/Perangkat baru terpasang: HP lama/);
    expect(t.out.join("\n")).toMatch(/versi lama tanpa enkripsi ujung-ke-ujung/);
  });
});

describe("penyimpanan kunci", () => {
  const fresh = () => join(root, `simpan ${++counter}`);

  test("membuat identitas sekali, dan memuat yang sama lain kali (kunci tidak berganti)", () => {
    const home = fresh();
    const a = loadOrCreateE2e(s, home);
    const b = loadOrCreateE2e(s, home);
    expect(b).toEqual(a);
    expect(a.kid).toBe(1);
    expect(Object.keys(a.dataKeys)).toEqual(["1"]);
    expect(fromB64(s, a.sign.publicKey)).toHaveLength(32);
    expect(fromB64(s, a.dataKeys["1"]!)).toHaveLength(32);
    expect(e2eActive(home)).toBe(false);
  });

  test("berkas rusak atau tidak dikenal MELEMPAR galat dan TIDAK ditimpa diam-diam (itu akan memutus semua HP)", () => {
    for (const content of ["{rusak", "[]", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, sign: {}, kx: {}, kid: 1, dataKeys: {}, devices: {} })]) {
      const home = fresh();
      loadOrCreateE2e(s, home);
      writeFileSync(join(home, E2E_FILE), content);
      expect(() => loadOrCreateE2e(s, home)).toThrow(E2eStoreError);
      expect(readFileSync(join(home, E2E_FILE), "utf8")).toBe(content);
    }
  });

  test("kunci data untuk kid yang sedang dipakai wajib ada", () => {
    const home = fresh();
    const state = loadOrCreateE2e(s, home);
    writeFileSync(join(home, E2E_FILE), JSON.stringify({ ...state, kid: 2 }));
    expect(() => loadE2e(home)).toThrow(E2eStoreError);
  });

  test("HP yang dicabut tidak dihitung dipercaya; semua dicabut berarti E2E mati lagi", () => {
    const home = fresh();
    const state = loadOrCreateE2e(s, home);
    saveE2e(home, { ...state, devices: { a: { name: "A", kx: "K".repeat(43), sign: "S".repeat(43), confirmedAt: "2026-11-22T00:00:00.000Z" } } });
    expect(e2eActive(home)).toBe(true);
    saveE2e(home, { ...state, devices: { a: { name: "A", kx: "K".repeat(43), sign: "S".repeat(43), confirmedAt: "2026-11-22T00:00:00.000Z", revokedAt: "2026-11-23T00:00:00.000Z" } } });
    expect(e2eActive(home)).toBe(false);
  });

  test.runIf(posix)("izin berkas yang terlalu longgar tidak dipakai ulang: ditulis ulang 0600", () => {
    const home = fresh();
    const state = loadOrCreateE2e(s, home);
    chmodSync(join(home, E2E_FILE), 0o644);
    saveE2e(home, state);
    expect(statSync(join(home, E2E_FILE)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, E2E_FILE))).toBe(true);
  });
});
