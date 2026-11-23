// FILE INI: TEST pairing E2E di sisi laptop (issue #033 bagian B). HP disimulasikan dengan pustaka kripto yang SAMA seperti PWA nanti.
// Yang dijaga: bukti rahasia QR, tantangan dan sidik jari yang cocok di kedua sisi, konfirmasi manusia (tanpa 'y' tidak ada kunci),
// penolakan bukti palsu, kunci data sampai ke HP yang benar, tidak ada kepercayaan tersisa bila gagal, berkas kunci yang aman, dan
// orkestrasi yang tahan (HP dari kode lain, HP yang dipasang ulang, pelepasan yang gagal, penyimpanan yang gagal, dua proses bersamaan).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { E2E_FILE, E2eStoreError, currentDataKey, e2eActive, loadE2e, loadOrCreateE2e, markDeviceRevoked, saveE2e, trustedDevices, updateE2e, withE2eLock } from "./e2e-store";
import { runPair, runRevokeDevice } from "./pairing";

let s: Sodium;
let root: string;
let counter = 0;
beforeAll(async () => {
  s = await loadSodium();
  root = mkdtempSync(join(tmpdir(), "agentmon e2e "));
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CODE = "kode-sekali-pakai-0123456789abcdef";
const MY_HASH = createHash("sha256").update(CODE).digest("hex");
const OTHER_HASH = createHash("sha256").update("kode-lain").digest("hex");
const posix = process.platform !== "win32";

type Posted = { kind: string; deviceId: string; body: Record<string, unknown> };
type Listed = { id: string; name: string; pairedAt: string; codeHash?: string; e2e?: { kx: string; sign: string; proof: string } };
type HpMode = "ok" | "wrong-secret" | "swap-kx" | "zero-width-name" | "legacy";

type ScenarioOptions = {
  confirm?: boolean;
  hpMode?: HpMode;
  failResponse?: boolean;
  failChallenge?: boolean;
  /** DELETE ?scope=pairing dijawab galat (relay bermasalah). */
  failUnpair?: boolean;
  /** Relay lama: tidak mengirim hash kode. */
  oldRelay?: boolean;
  /** Sebelum HP kita muncul, HP lain dari KODE LAIN sudah muncul di daftar. */
  otherCodeDevice?: boolean;
  /** HP kita muncul baru pada putaran ke-N (1 = langsung). */
  scanOnSleep?: number;
  /** Kepercayaan yang sudah ada sebelum pairing ini (mis. HP yang sama dipasang ulang). */
  preTrust?: { id: string; name: string; kx: string; sign: string };
  /** Dipanggil di tengah pertanyaan konfirmasi (untuk merusak penyimpanan, dst.). */
  duringConfirm?: (home: string) => void;
  /** Nomor HP kita. */
  deviceId?: string;
};

/** Relay palsu minimal + HP yang "memindai QR" saat runPair menunggu. */
function scenario(options: ScenarioOptions = {}) {
  const home = join(root, `kasus ${++counter}`);
  const out: string[] = [];
  const err: string[] = [];
  const posted: Posted[] = [];
  const unpaired: string[] = [];
  const revokedGlobally: string[] = [];
  const calls: string[] = [];
  const devices: Listed[] = [];
  const phone = { sign: generateSignKeyPair(s), kx: generateKxKeyPair(s) };
  const deviceId = options.deviceId ?? "hp-1";
  let sleeps = 0;
  let scanned = false;
  let qr: ReturnType<typeof parsePairingUrl>;
  let confirmCalls = 0;

  if (options.preTrust) {
    mkdirSync(home, { recursive: true });
    const state = loadOrCreateE2e(s, home);
    saveE2e(home, { ...state, devices: { [options.preTrust.id]: { name: options.preTrust.name, kx: options.preTrust.kx, sign: options.preTrust.sign, confirmedAt: "2026-11-01T00:00:00.000Z" } } });
  }

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/pair/devices" && method === "GET") return json(200, { devices });
    if (url.pathname === "/pair/code") return json(201, { code: CODE, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (url.pathname === "/pair/e2e/messages" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Posted;
      if ((body.kind === "response" && options.failResponse) || (body.kind === "challenge" && options.failChallenge)) return json(404, { error: "not-found" });
      posted.push(body);
      return json(201, { ok: true });
    }
    if (url.pathname.startsWith("/pair/devices/") && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").pop()!);
      if (url.searchParams.get("scope") === "pairing") {
        if (options.failUnpair) return json(500, { error: "server" });
        unpaired.push(id);
      } else revokedGlobally.push(id);
      return json(200, { ok: true });
    }
    return json(404, {});
  }) as unknown as typeof fetch;

  const listed = (item: Omit<Listed, "pairedAt">): Listed => ({ ...item, pairedAt: new Date().toISOString(), ...(options.oldRelay ? {} : {}) });
  const withHash = (hash: string): { codeHash?: string } => (options.oldRelay ? {} : { codeHash: hash });

  // HP memindai QR; dipanggil dari `sleep` pada putaran yang ditentukan.
  const scan = () => {
    qr = parsePairingUrl(out.find((line) => line.startsWith("https://")) ?? "");
    const mode = options.hpMode ?? "ok";
    if (options.otherCodeDevice) devices.push(listed({ id: "hp-lain", name: "HP kode lain", ...withHash(OTHER_HASH), e2e: { kx: "K".repeat(43), sign: "S".repeat(43), proof: "P".repeat(43) } }));
    if (mode === "legacy") {
      devices.push(listed({ id: deviceId, name: "HP lama", ...withHash(MY_HASH) }));
      return;
    }
    const secret = mode === "wrong-secret" ? s.randombytes_buf(32) : fromB64(s, qr!.secret!);
    const name = mode === "zero-width-name" ? "iPhone Dono​" : "iPhone Dono";
    const request: PairRequest = { code: CODE, machineId: qr!.machineId ?? "m1", deviceName: name.normalize("NFC").trim(), kxPublicKey: phone.kx.publicKey, signPublicKey: phone.sign.publicKey };
    // zero-width: HP jahat membuat bukti atas nama yang sama persis dengan yang dikirim ke relay
    const proof = mode === "zero-width-name" ? s.crypto_auth(new TextEncoder().encode("bukti-tak-penting"), s.randombytes_buf(32)) : makePairProof(s, request, secret);
    const kxSent = mode === "swap-kx" ? generateKxKeyPair(s).publicKey : phone.kx.publicKey;
    devices.push(listed({ id: deviceId, name, ...withHash(MY_HASH), e2e: { kx: toB64(s, kxSent), sign: toB64(s, phone.sign.publicKey), proof: toB64(s, proof) } }));
  };

  const sleep = async () => {
    sleeps += 1;
    if (!scanned && sleeps >= (options.scanOnSleep ?? 1)) {
      scanned = true;
      scan();
    }
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
          options.duringConfirm?.(home);
          return options.confirm ?? true;
        },
      },
    });

  return { run, home, out, err, posted, unpaired, revokedGlobally, calls, phone, devices, qr: () => qr, confirmCalls: () => confirmCalls, deviceId };
}

describe("pairing E2E di laptop: jalur sukses", () => {
  test("HP yang sah: sidik jari SAMA di kedua sisi, kunci data sampai ke HP itu, dan HP dipercaya di laptop", async () => {
    const t = scenario();
    expect(await t.run()).toBe(0);
    expect(t.unpaired).toEqual([]);
    expect(t.revokedGlobally).toEqual([]);

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

  test("QR memuat rahasia (s), kunci publik laptop (k), dan nomor laptop (m) HANYA di fragmen; rahasia tidak pernah dikirim ke relay atau disimpan", async () => {
    const t = scenario();
    await t.run();
    const link = t.qr()!;
    expect(link.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.laptopKey).toBe(loadE2e(t.home)!.sign.publicKey);
    expect(link.machineId).toBe("m1");
    const urlLine = t.out.find((line) => line.startsWith("https://"))!;
    expect(new URL(urlLine).search).toBe("");
    // rahasia tidak ada di apa pun yang dikirim ke relay, dan tidak ada di berkas kunci
    expect(JSON.stringify(t.posted)).not.toContain(link.secret!);
    expect(readFileSync(join(t.home, E2E_FILE), "utf8")).not.toContain(link.secret!);
  });

  test("tantangan sidik jari acak baru tiap pairing (bukan nol dan tidak berulang)", async () => {
    const challenges: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = scenario();
      await t.run();
      challenges.push(t.posted.find((p) => p.kind === "challenge")!.body.r as string);
      expect(fromB64(s, challenges[i]!).some((byte) => byte !== 0)).toBe(true);
    }
    expect(new Set(challenges).size).toBe(3);
  });

  test.runIf(posix)("berkas kunci hanya bisa dibaca pemilik (0600), dan tidak ada berkas sementara atau kunci yang tersisa", async () => {
    const t = scenario();
    await t.run();
    expect(statSync(join(t.home, E2E_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(t.home).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toEqual([]);
  });

  test("HP yang SUDAH terpasang dipasangkan ulang dengan bahan E2E baru (jalur migrasi): diproses walau nomornya sudah ada", async () => {
    const t = scenario({ preTrust: { id: "hp-1", name: "iPhone lama", kx: "K".repeat(43), sign: "S".repeat(43) } });
    t.devices.push({ id: "hp-1", name: "iPhone Dono", pairedAt: new Date().toISOString(), codeHash: OTHER_HASH }); // sudah terpasang dari kode lama
    expect(await t.run()).toBe(0);
    expect(t.confirmCalls()).toBe(1);
    expect(t.out.join("\n")).toMatch(/MENGGANTI kunci perangkat tepercaya 'iPhone lama'/);
    expect(loadE2e(t.home)!.devices["hp-1"]?.sign).toBe(toB64(s, t.phone.sign.publicKey));
  });
});

describe("pairing E2E di laptop: penolakan (hanya di laptop ini)", () => {
  test("pengguna menjawab TIDAK: tidak ada kunci dibagikan, pasangan dilepas HANYA di laptop ini (bukan pencabutan global), tidak ada kepercayaan, kode keluar 1", async () => {
    const t = scenario({ confirm: false });
    expect(await t.run()).toBe(1);
    expect(t.unpaired).toEqual(["hp-1"]);
    expect(t.revokedGlobally).toEqual([]);
    expect(t.posted.some((p) => p.kind === "response")).toBe(false);
    expect(trustedDevices(loadE2e(t.home)!)).toEqual([]);
    expect(e2eActive(t.home)).toBe(false);
  });

  test.each([
    ["rahasia QR salah (relay atau penyerang tanpa rahasia)", "wrong-secret"],
    ["kunci HP ditukar relay setelah bukti dibuat", "swap-kx"],
    ["nama berakhiran karakter lebar-nol", "zero-width-name"],
  ] as const)("%s: DITOLAK tanpa menanyakan pengguna, pasangan dilepas di laptop ini saja, tidak ada tantangan atau kunci dikirim", async (_n, hpMode) => {
    const t = scenario({ hpMode });
    expect(await t.run()).toBe(1);
    expect(t.confirmCalls()).toBe(0);
    expect(t.unpaired).toEqual(["hp-1"]);
    expect(t.revokedGlobally).toEqual([]);
    expect(t.posted).toEqual([]);
    expect(e2eActive(t.home)).toBe(false);
    expect(t.err.join("\n")).toMatch(/bukti rahasia QR tidak sah/);
  });

  test("jawaban gagal terkirim: kepercayaan DIBATALKAN (tidak menyisakan HP yang tak pernah menerima kunci) dan pasangan dilepas", async () => {
    const t = scenario({ failResponse: true });
    expect(await t.run()).toBe(1);
    expect(t.unpaired).toEqual(["hp-1"]);
    expect(loadE2e(t.home)!.devices).toEqual({});
    expect(e2eActive(t.home)).toBe(false);
  });

  test("jawaban gagal terkirim saat memasangkan ulang HP yang sudah dipercaya: kepercayaan LAMA dipulihkan (bukan dihapus)", async () => {
    const old = { id: "hp-1", name: "iPhone lama", kx: "K".repeat(43), sign: "S".repeat(43) };
    const t = scenario({ failResponse: true, preTrust: old });
    expect(await t.run()).toBe(1);
    const restored = loadE2e(t.home)!.devices["hp-1"];
    expect(restored?.sign).toBe(old.sign);
    expect(restored?.name).toBe("iPhone lama");
  });

  test("tantangan gagal terkirim: tidak ada pertanyaan ke pengguna, pasangan dilepas", async () => {
    const t = scenario({ failChallenge: true });
    expect(await t.run()).toBe(1);
    expect(t.confirmCalls()).toBe(0);
    expect(t.unpaired).toEqual(["hp-1"]);
  });

  test("menyimpan kepercayaan gagal (berkas kunci tidak bisa ditulis): tidak ada jejak tumpukan, pasangan dilepas, kode keluar 1", async () => {
    const t = scenario({
      duringConfirm: (home) => {
        // Mengganti berkas kunci dengan folder: membaca dan mengganti berkas itu gagal (EISDIR/EPERM), seperti antivirus yang memegang berkas.
        rmSync(join(home, E2E_FILE), { force: true });
        mkdirSync(join(home, E2E_FILE));
      },
    });
    expect(await t.run()).toBe(1);
    expect(t.unpaired).toEqual(["hp-1"]);
    expect(t.posted.some((p) => p.kind === "response")).toBe(false);
    expect(t.err.join("\n")).toMatch(/Gagal menyelesaikan pairing/);
  });

  test("pelepasan yang GAGAL dilaporkan jujur: pengguna diberi tahu HP MASIH terpasang di relay (tidak diklaim berhasil)", async () => {
    const t = scenario({ confirm: false, failUnpair: true });
    expect(await t.run()).toBe(1);
    expect(t.err.join("\n")).toMatch(/MASIH terpasang di relay/);
    expect(t.out.concat(t.err).join("\n")).not.toMatch(/dicabut\./);
    expect(t.calls.filter((c) => c.startsWith("DELETE")).length).toBe(3); // dicoba 3 kali
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

  test("berkas kunci rusak: pair berhenti SEBELUM meminta kode (jatah kode tidak terbuang)", async () => {
    const t = scenario();
    mkdirSync(t.home, { recursive: true });
    writeFileSync(join(t.home, E2E_FILE), "{rusak");
    expect(await t.run()).toBe(1);
    expect(t.calls).not.toContain("POST /pair/code");
    expect(t.err.join("\n")).toMatch(/Kunci enkripsi tidak bisa disiapkan/);
  });
});

describe("HP versi lama (tanpa bahan E2E) atau QR yang dipakai tanpa kunci", () => {
  test("WAJIB dikonfirmasi pengguna (nama ditampilkan); dijawab ya: terpasang tanpa enkripsi dengan peringatan jelas, tidak dipercaya sebagai HP terenkripsi", async () => {
    const t = scenario({ hpMode: "legacy" });
    expect(await t.run()).toBe(0);
    expect(t.confirmCalls()).toBe(1);
    expect(t.out.join("\n")).toMatch(/TANPA enkripsi ujung-ke-ujung/);
    expect(t.posted).toEqual([]);
    expect(e2eActive(t.home)).toBe(false);
  });

  test("dijawab TIDAK (atau tanpa terminal): pasangan dilepas dan kode keluar 1 (QR bocor tidak bisa dipakai dengan melewati bahan E2E)", async () => {
    const t = scenario({ hpMode: "legacy", confirm: false });
    expect(await t.run()).toBe(1);
    expect(t.unpaired).toEqual(["hp-1"]);
    expect(t.revokedGlobally).toEqual([]);
  });
});

describe("beberapa HP dan relay lama", () => {
  test("HP dari KODE LAIN (pair paralel, kode lama) diabaikan: tidak ditanya, tidak dilepas; HP kita tetap diproses", async () => {
    const t = scenario({ otherCodeDevice: true });
    expect(await t.run()).toBe(0);
    expect(t.confirmCalls()).toBe(1);
    expect(t.unpaired).toEqual([]);
    expect(t.revokedGlobally).toEqual([]);
    expect(trustedDevices(loadE2e(t.home)!).map(([id]) => id)).toEqual(["hp-1"]);
  });

  test("HP kita muncul belakangan (setelah HP kode lain muncul lebih dulu): tetap diproses, bukan menunggu sampai kode kedaluwarsa", async () => {
    const t = scenario({ otherCodeDevice: true, scanOnSleep: 3 });
    expect(await t.run()).toBe(0);
    expect(trustedDevices(loadE2e(t.home)!).map(([id]) => id)).toEqual(["hp-1"]);
  });

  test("relay lama (tanpa hash kode): HP baru tetap diproses seperti dulu", async () => {
    const t = scenario({ oldRelay: true });
    expect(await t.run()).toBe(0);
    expect(trustedDevices(loadE2e(t.home)!).map(([id]) => id)).toEqual(["hp-1"]);
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

  test("dua pembaruan BERSAMAAN tidak saling menimpa (kunci berkas): kedua HP tercatat", async () => {
    const home = fresh();
    const add = (id: string) => updateE2e(s, home, (state) => ({ ...state, devices: { ...state.devices, [id]: { name: id, kx: "K".repeat(43), sign: "S".repeat(43), confirmedAt: "2026-11-22T00:00:00.000Z" } } }));
    await Promise.all([add("a"), add("b"), add("c")]);
    expect(Object.keys(loadE2e(home)!.devices).sort()).toEqual(["a", "b", "c"]);
  });

  test("dua pembuatan identitas pertama yang berbalapan menghasilkan SATU identitas yang sama", async () => {
    const home = fresh();
    const [a, b] = await Promise.all([updateE2e(s, home, (state) => state), updateE2e(s, home, (state) => state)]);
    expect(a.sign.publicKey).toBe(b.sign.publicKey);
    expect(loadE2e(home)!.sign.publicKey).toBe(a.sign.publicKey);
  });

  test("kunci basi (proses mati) dilepas; kunci yang masih segar membuat pembaruan lain menunggu lalu berhasil", async () => {
    const home = fresh();
    loadOrCreateE2e(s, home);
    let order: string[] = [];
    await Promise.all([
      withE2eLock(home, async () => {
        order.push("a-mulai");
        await new Promise((resolve) => setTimeout(resolve, 150));
        order.push("a-selesai");
      }),
      withE2eLock(home, () => void order.push("b")),
    ]);
    expect(order).toEqual(["a-mulai", "a-selesai", "b"]);
    order = [];
    writeFileSync(join(home, `${E2E_FILE}.lock`), "999999 0\n");
    const old = new Date(Date.now() - 120_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(home, `${E2E_FILE}.lock`), old, old);
    await withE2eLock(home, () => void order.push("setelah-basi"));
    expect(order).toEqual(["setelah-basi"]);
  });

  test("`devices revoke` juga menandai HP dicabut di berkas kunci E2E (tidak lagi dipercaya), dan hanya bila relay mengonfirmasi", async () => {
    const home = fresh();
    const state = loadOrCreateE2e(s, home);
    saveE2e(home, { ...state, devices: { a: { name: "A", kx: "K".repeat(43), sign: "S".repeat(43), confirmedAt: "2026-11-22T00:00:00.000Z" } } });
    const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const bad = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const out: string[] = [];
    const err: string[] = [];
    const opts = { relayUrl: "https://relay.contoh.com", machineToken: "t".repeat(40), out: (t: string) => out.push(t), err: (t: string) => err.push(t), e2eHome: home, deviceId: "a" };
    expect(await runRevokeDevice({ ...opts, fetch: bad })).toBe(1);
    expect(e2eActive(home)).toBe(true); // relay gagal: masih dipercaya (HP belum dicabut)
    expect(await runRevokeDevice({ ...opts, fetch: ok })).toBe(0);
    expect(e2eActive(home)).toBe(false);
  });

  test("markDeviceRevoked: menandai HP dicabut (tidak lagi dipercaya); tanpa berkas kunci tidak membuat folder atau berkas", async () => {
    const home = fresh();
    const state = loadOrCreateE2e(s, home);
    saveE2e(home, { ...state, devices: { a: { name: "A", kx: "K".repeat(43), sign: "S".repeat(43), confirmedAt: "2026-11-22T00:00:00.000Z" } } });
    expect(await markDeviceRevoked(home, "a")).toBe(true);
    expect(e2eActive(home)).toBe(false);
    expect(await markDeviceRevoked(home, "a")).toBe(false); // sudah dicabut
    expect(await markDeviceRevoked(home, "tidak-ada")).toBe(false);
    const empty = join(root, `kosong ${++counter}`);
    expect(await markDeviceRevoked(empty, "a")).toBe(false);
    expect(existsSync(empty)).toBe(false);
  });
});
