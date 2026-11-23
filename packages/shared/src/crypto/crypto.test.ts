import { beforeAll, describe, expect, test } from "vitest";
import {
  aeadOpen,
  aeadSeal,
  eventAad,
  approvalHash,
  openSigned,
  sealSigned,
  canon,
  CryptoError,
  fromB64,
  generateDataKey,
  generateKxKeyPair,
  generatePairingSecret,
  generatePairChallenge,
  normalizeDeviceName,
  signPairChallenge,
  verifyPairChallenge,
  generateSignKeyPair,
  laptopSessionKeys,
  loadSodium,
  makePairProof,
  openEvent,
  pairingFingerprint,
  PAD_BLOCK,
  phoneSessionKeys,
  sealEvent,
  signPairResponse,
  toB64,
  unwrapDataKey,
  utf8,
  verifyPairProof,
  verifyPairResponse,
  wrapDataKey,
  type EventEnvelope,
  type PairRequest,
  type Sodium,
} from "./index";

let s: Sodium;
beforeAll(async () => {
  s = await loadSodium();
}, 30_000);

const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const envelope: EventEnvelope = { v: 1, id: "ev-1", machineId: "m1", sessionId: "s1", seq: 7, ts: "2026-11-22T10:00:00.000Z", agent: "claude-code", type: "approval.requested", approvalId: "ap-1", expiresAt: "2026-11-22T10:10:00.000Z" };

function setup() {
  const laptopSign = generateSignKeyPair(s);
  const dataKey = generateDataKey(s);
  const dataKeys = (kid: number) => (kid === 1 ? dataKey : undefined);
  return { laptopSign, dataKey, dataKeys };
}

describe("vektor uji resmi", () => {
  test("Ed25519 RFC 8032 (uji 1): kunci publik dan tanda tangan dari seed yang diketahui", () => {
    const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    const pair = s.crypto_sign_seed_keypair(seed);
    expect(toHex(pair.publicKey)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const signature = s.crypto_sign_detached(new Uint8Array(0), pair.privateKey);
    expect(toHex(signature)).toBe("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  });

  test("XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha, A.3.1): ciphertext dan tag dari masukan yang diketahui", () => {
    const key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    const nonce = hex("404142434445464748494a4b4c4d4e4f5051525354555657");
    const aad = hex("50515253c0c1c2c3c4c5c6c7");
    const plaintext = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const out = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
    expect(toHex(out)).toBe(
      "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49",
    );
  });
});

describe("pengodean kanonis", () => {
  test("susunan kolom yang berbeda tidak pernah menghasilkan byte yang sama", () => {
    expect(toHex(canon("x", ["ab", "c"]))).not.toBe(toHex(canon("x", ["a", "bc"])));
    expect(toHex(canon("x", ["a"]))).not.toBe(toHex(canon("y", ["a"])));
  });
  test("angka hanya bilangan bulat tak negatif", () => {
    expect(() => canon("x", [-1])).toThrow(CryptoError);
    expect(() => canon("x", [1.5])).toThrow(CryptoError);
    expect(() => canon("x", [Number.NaN])).toThrow(CryptoError);
    expect(() => canon("x", [2 ** 60])).toThrow(CryptoError);
    expect(toHex(canon("x", [12]))).not.toBe(toHex(canon("x", ["12"]))); // angka berbeda dari teks
  });
});

describe("AEAD", () => {
  test("enkripsi lalu dekripsi menghasilkan data semula, dengan padding ke kelipatan blok", () => {
    const key = generateDataKey(s);
    const aad = utf8("aad");
    for (const size of [0, 1, 100, 255, 256, 257, 1000]) {
      const plaintext = s.randombytes_buf(size);
      const { n, c } = aeadSeal(s, key, aad, plaintext, PAD_BLOCK);
      expect((c.length - 16) % PAD_BLOCK).toBe(0);
      expect(aeadOpen(s, key, aad, n, c, PAD_BLOCK)).toEqual(plaintext);
    }
  });

  test("dua payload pendek yang panjangnya berbeda menghasilkan ciphertext sepanjang sama (panjang perintah tidak bocor)", () => {
    const key = generateDataKey(s);
    const a = aeadSeal(s, key, utf8("x"), utf8("ls"), PAD_BLOCK);
    const b = aeadSeal(s, key, utf8("x"), utf8("rm -rf node_modules && echo selesai"), PAD_BLOCK);
    expect(a.c.length).toBe(b.c.length);
  });

  test("nonce selalu baru: 2000 enkripsi tanpa satu pun nonce kembar", () => {
    const key = generateDataKey(s);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(toHex(aeadSeal(s, key, utf8("x"), utf8("p")).n));
    expect(seen.size).toBe(2000);
  });

  test("ditolak: satu bit diubah di mana pun, kunci salah, AAD salah, nonce salah, panjang kunci salah", () => {
    const key = generateDataKey(s);
    const aad = utf8("aad");
    const { n, c } = aeadSeal(s, key, aad, utf8("rahasia"), PAD_BLOCK);
    for (let i = 0; i < c.length; i += 7) {
      const bad = c.slice();
      bad[i] = bad[i]! ^ 1;
      expect(() => aeadOpen(s, key, aad, n, bad, PAD_BLOCK)).toThrow(CryptoError);
    }
    const badNonce = n.slice();
    badNonce[0] = badNonce[0]! ^ 1;
    expect(() => aeadOpen(s, key, aad, badNonce, c, PAD_BLOCK)).toThrow(CryptoError);
    expect(() => aeadOpen(s, generateDataKey(s), aad, n, c, PAD_BLOCK)).toThrow(CryptoError);
    expect(() => aeadOpen(s, key, utf8("lain"), n, c, PAD_BLOCK)).toThrow(CryptoError);
    expect(() => aeadOpen(s, key.slice(0, 31), aad, n, c, PAD_BLOCK)).toThrow(CryptoError);
    expect(() => aeadOpen(s, key, aad, n.slice(0, 23), c, PAD_BLOCK)).toThrow(CryptoError);
    expect(() => aeadOpen(s, key, aad, n, c.slice(0, 10), PAD_BLOCK)).toThrow(CryptoError);
    expect(() => aeadSeal(s, key.slice(0, 31), aad, utf8("x"))).toThrow(CryptoError);
  });
});

describe("event terenkripsi dan bertanda tangan", () => {
  const MARKER = "PENANDA-RAHASIA-JANGAN-BOCOR-12345";
  const plaintext = utf8(JSON.stringify({ toolInput: { command: `echo ${MARKER}` } }));

  test("bolak-balik: HP yang mengenal kunci data dan kunci laptop membaca persis isi semula", () => {
    const { laptopSign, dataKey, dataKeys } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    expect(openEvent(s, { expectedMachineId: "m1", payload, envelope, dataKeys, signPublicKey: laptopSign.publicKey }).plaintext).toEqual(plaintext);
  });

  test("data penanda TIDAK muncul sebagai plaintext di payload (bentuk yang disimpan relay), dalam bentuk apa pun", () => {
    const { laptopSign, dataKey } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    const json = JSON.stringify(payload);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(toB64(s, utf8(MARKER)));
    expect(json).not.toContain(toHex(utf8(MARKER)));
    expect(Object.keys(payload).sort()).toEqual(["c", "e", "kid", "n", "s"]);
  });

  test("ditolak: byte c, n, atau tanda tangan diubah satu bit", () => {
    const { laptopSign, dataKey, dataKeys } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    for (const field of ["c", "n", "s"] as const) {
      const bytes = fromB64(s, payload[field]);
      for (let i = 0; i < bytes.length; i += 5) {
        const bad = bytes.slice();
        bad[i] = bad[i]! ^ 1;
        expect(() => openEvent(s, { expectedMachineId: "m1", payload: { ...payload, [field]: toB64(s, bad) }, envelope, dataKeys, signPublicKey: laptopSign.publicKey }), `${field}[${i}]`).toThrow(CryptoError);
      }
    }
  });

  test("ditolak: payload dipindah ke amplop lain atau SATU kolom amplop diubah (id, sesi, seq, waktu, jenis, izin, kedaluwarsa, mesin, agen, versi)", () => {
    const { laptopSign, dataKey, dataKeys } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    const changes: Partial<EventEnvelope>[] = [
      { id: "ev-2" },
      { sessionId: "s2" },
      { machineId: "m2" },
      { seq: 8 },
      { ts: "2026-11-22T10:00:00.001Z" },
      { agent: "codex" },
      { type: "approval.resolved" },
      { approvalId: "ap-2" },
      { approvalId: undefined },
      { expiresAt: "2026-11-22T10:20:00.000Z" },
      { expiresAt: undefined },
      { v: 2 },
    ];
    for (const change of changes) {
      expect(() => openEvent(s, { expectedMachineId: "m1", payload, envelope: { ...envelope, ...change }, dataKeys, signPublicKey: laptopSign.publicKey }), JSON.stringify(change)).toThrow(CryptoError);
    }
  });

  test("ditolak: kunci data salah, kid tidak dikenal, kid diubah di payload, bidang asing, bentuk rusak", () => {
    const { laptopSign, dataKey, dataKeys } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    const input = { payload, envelope, dataKeys, signPublicKey: laptopSign.publicKey };
    expect(() => openEvent(s, { expectedMachineId: "m1", ...input, dataKeys: () => generateDataKey(s) })).toThrow(CryptoError);
    expect(() => openEvent(s, { expectedMachineId: "m1", ...input, dataKeys: () => undefined })).toThrow(CryptoError);
    expect(() => openEvent(s, { expectedMachineId: "m1", ...input, payload: { ...payload, kid: 2 } })).toThrow(CryptoError);
    expect(() => openEvent(s, { expectedMachineId: "m1", ...input, payload: { ...payload, extra: 1 } })).toThrow(CryptoError);
    expect(() => openEvent(s, { expectedMachineId: "m1", ...input, payload: { ...payload, e: 2 } })).toThrow(CryptoError);
    expect(() => openEvent(s, { expectedMachineId: "m1", ...input, payload: { ...payload, n: "***" } })).toThrow(CryptoError);
    for (const junk of [null, undefined, 1, "x", [], {}]) expect(() => openEvent(s, { expectedMachineId: "m1", ...input, payload: junk })).toThrow(CryptoError);
  });

  test("kid terikat ke tanda tangan dan AAD: walau kunci yang sama dipakai untuk kid lain, mengubah kid di payload ditolak", () => {
    const { laptopSign, dataKey } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    const sameKeyForAnyKid = () => dataKey;
    expect(openEvent(s, { expectedMachineId: "m1", payload, envelope, dataKeys: sameKeyForAnyKid, signPublicKey: laptopSign.publicKey }).plaintext).toEqual(plaintext);
    expect(() => openEvent(s, { expectedMachineId: "m1", payload: { ...payload, kid: 2 }, envelope, dataKeys: sameKeyForAnyKid, signPublicKey: laptopSign.publicKey })).toThrow(CryptoError);
  });

  test("PEMALSU yang memegang kunci data TIDAK bisa membuat event: HP lain atau relay tanpa kunci tanda tangan laptop ditolak", () => {
    const { laptopSign, dataKey, dataKeys } = setup();
    const impostor = generateSignKeyPair(s);
    const forged = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: impostor.privateKey });
    expect(() => openEvent(s, { expectedMachineId: "m1", payload: forged, envelope, dataKeys, signPublicKey: laptopSign.publicKey })).toThrow(CryptoError);
    // payload sah dari laptop lain juga ditolak oleh HP yang mengenal laptop ini
    const other = setup();
    const foreign = sealEvent(s, { dataKey: other.dataKey, kid: 1, envelope, plaintext, signPrivateKey: other.laptopSign.privateKey });
    expect(() => openEvent(s, { expectedMachineId: "m1", payload: foreign, envelope, dataKeys, signPublicKey: laptopSign.publicKey })).toThrow(CryptoError);
  });

  test("perangkat yang dicabut: setelah rotasi, kunci data lama tidak membuka event kid baru", () => {
    const { laptopSign } = setup();
    const keyV1 = generateDataKey(s);
    const keyV2 = generateDataKey(s);
    const payload = sealEvent(s, { dataKey: keyV2, kid: 2, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    const revokedPhone = (kid: number) => (kid === 1 ? keyV1 : undefined);
    expect(() => openEvent(s, { expectedMachineId: "m1", payload, envelope, dataKeys: revokedPhone, signPublicKey: laptopSign.publicKey })).toThrow(CryptoError);
    // walau penyerang menyodorkan kunci lama untuk kid baru, dekripsi gagal
    expect(() => openEvent(s, { expectedMachineId: "m1", payload, envelope, dataKeys: () => keyV1, signPublicKey: laptopSign.publicKey })).toThrow(CryptoError);
  });

  test("laptop lain: event bertanda tangan laptop A yang mengaku mesin B (atau diharapkan mesin lain) ditolak; kid dikembalikan ke pemanggil", () => {
    const { laptopSign, dataKey, dataKeys } = setup();
    const asB = { ...envelope, machineId: "mB" };
    const payload = sealEvent(s, { dataKey, kid: 1, envelope: asB, plaintext, signPrivateKey: laptopSign.privateKey });
    expect(() => openEvent(s, { payload, envelope: asB, expectedMachineId: "m1", dataKeys, signPublicKey: laptopSign.publicKey })).toThrow(CryptoError);
    const opened = openEvent(s, { payload, envelope: asB, expectedMachineId: "mB", dataKeys, signPublicKey: laptopSign.publicKey });
    expect(opened.kid).toBe(1);
  });

  test("galat dari penyimpanan kunci (dataKeys melempar) menjadi CryptoError yang sama, tanpa membocorkan pesannya", () => {
    const { laptopSign, dataKey } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    try {
      openEvent(s, { expectedMachineId: "m1", payload, envelope, dataKeys: () => { throw new Error("db: kid 1 tidak ada di tabel rahasia"); }, signPublicKey: laptopSign.publicKey });
      throw new Error("seharusnya gagal");
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as Error).message).toBe("invalid");
    }
  });

  test("jenis kolom diperiksa saat dijalankan: seq berbentuk teks, kolom kosong, atau tambahan relay tidak mengubah apa pun yang ditandatangani", () => {
    const { laptopSign, dataKey } = setup();
    const asText = { ...envelope, seq: "7" as unknown as number };
    expect(() => sealEvent(s, { dataKey, kid: 1, envelope: asText, plaintext, signPrivateKey: laptopSign.privateKey })).toThrow(CryptoError);
    expect(() => sealEvent(s, { dataKey, kid: 1, envelope: { ...envelope, v: "1" as unknown as number }, plaintext, signPrivateKey: laptopSign.privateKey })).toThrow(CryptoError);
    // kolom asing diabaikan: AAD sama dengan tanpa kolom itu
    expect(toHex(eventAad({ ...envelope, risk: "low" } as EventEnvelope, 1))).toBe(toHex(eventAad(envelope, 1)));
  });

  test("seluruh kegagalan memakai galat dan pesan yang SAMA (bukan oracle)", () => {
    const { laptopSign, dataKey, dataKeys } = setup();
    const payload = sealEvent(s, { dataKey, kid: 1, envelope, plaintext, signPrivateKey: laptopSign.privateKey });
    const attempts = [
      () => openEvent(s, { expectedMachineId: "m1", payload: { ...payload, s: toB64(s, new Uint8Array(64)) }, envelope, dataKeys, signPublicKey: laptopSign.publicKey }),
      () => openEvent(s, { expectedMachineId: "m1", payload, envelope, dataKeys: () => generateDataKey(s), signPublicKey: laptopSign.publicKey }),
      () => openEvent(s, { expectedMachineId: "m1", payload: "x", envelope, dataKeys, signPublicKey: laptopSign.publicKey }),
      () => openEvent(s, { expectedMachineId: "m1", payload, envelope: { ...envelope, seq: 9 }, dataKeys, signPublicKey: laptopSign.publicKey }),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        throw new Error("seharusnya gagal");
      } catch (error) {
        expect(error).toBeInstanceOf(CryptoError);
        expect((error as Error).message).toBe("invalid");
      }
    }
  });

  test("kolom opsional yang ada tidak boleh kosong (kosong berarti tidak ada)", () => {
    const { laptopSign, dataKey } = setup();
    expect(() => sealEvent(s, { dataKey, kid: 1, envelope: { ...envelope, approvalId: "" }, plaintext, signPrivateKey: laptopSign.privateKey })).toThrow(CryptoError);
    expect(() => sealEvent(s, { dataKey, kid: 0, envelope, plaintext, signPrivateKey: laptopSign.privateKey })).toThrow(CryptoError);
  });
});

describe("pairing", () => {
  const request = (phoneSign = generateSignKeyPair(s), phoneKx = generateKxKeyPair(s)): PairRequest => ({ code: "ABCD-1234", machineId: "m1", deviceName: "iPhone Dono", kxPublicKey: phoneKx.publicKey, signPublicKey: phoneSign.publicKey });

  test("bukti rahasia QR: sah dengan rahasia yang sama, ditolak untuk rahasia lain atau SATU kolom permintaan yang diubah", () => {
    const secret = generatePairingSecret(s);
    const req = request();
    const proof = makePairProof(s, req, secret);
    expect(verifyPairProof(s, proof, req, secret)).toBe(true);
    expect(verifyPairProof(s, proof, req, generatePairingSecret(s))).toBe(false);
    for (const change of [{ code: "ABCD-1235" }, { machineId: "m2" }, { deviceName: "iPhone Lain" }, { kxPublicKey: generateKxKeyPair(s).publicKey }, { signPublicKey: generateSignKeyPair(s).publicKey }]) {
      expect(verifyPairProof(s, proof, { ...req, ...change }, secret), JSON.stringify(Object.keys(change))).toBe(false);
    }
    expect(verifyPairProof(s, proof.slice(1), req, secret)).toBe(false);
    expect(verifyPairProof(s, proof, req, secret.slice(1))).toBe(false); // tidak melempar
  });

  test("perantara tanpa rahasia QR tidak bisa membuat bukti yang sah", () => {
    const secret = generatePairingSecret(s);
    const req = request();
    expect(verifyPairProof(s, makePairProof(s, req, generatePairingSecret(s)), req, secret)).toBe(false);
  });

  test("sidik jari: 6 digit, sama di kedua sisi, dan BERBEDA bila perantara menukar kunci atau tantangan laptop berubah", () => {
    const laptopSign = generateSignKeyPair(s);
    const req = request();
    const r = generatePairChallenge(s);
    const fp = pairingFingerprint(s, req, laptopSign.publicKey, r);
    expect(fp).toMatch(/^\d{6}$/);
    expect(pairingFingerprint(s, req, laptopSign.publicKey, r)).toBe(fp);
    expect(pairingFingerprint(s, { ...req, kxPublicKey: generateKxKeyPair(s).publicKey }, laptopSign.publicKey, r)).not.toBe(fp);
    expect(pairingFingerprint(s, { ...req, signPublicKey: generateSignKeyPair(s).publicKey }, laptopSign.publicKey, r)).not.toBe(fp);
    expect(pairingFingerprint(s, req, generateSignKeyPair(s).publicKey, r)).not.toBe(fp);
    expect(pairingFingerprint(s, req, laptopSign.publicKey, generatePairChallenge(s))).not.toBe(fp);
    expect(() => pairingFingerprint(s, req, laptopSign.publicKey, new Uint8Array(8))).toThrow(CryptoError);
  });

  test("PENGGILINGAN sidik jari gagal: permintaan penyerang yang angkanya cocok dengan tantangan LAMA tidak cocok dengan tantangan baru", () => {
    // Penyerang mencari permintaan sendiri yang angkanya sama dengan HP asli di bawah tantangan r0. Laptop memilih tantangan BARU
    // untuk permintaan penyerang, jadi hasil penggilingan itu tak berguna: angkanya hampir pasti berbeda.
    const laptopSign = generateSignKeyPair(s);
    const real = request();
    const r0 = generatePairChallenge(s);
    const target = pairingFingerprint(s, real, laptopSign.publicKey, r0);
    let matchesOld = 0;
    let matchesNew = 0;
    const rNew = generatePairChallenge(s);
    for (let i = 0; i < 400; i++) {
      const attacker = request();
      if (pairingFingerprint(s, attacker, laptopSign.publicKey, r0) === target) matchesOld += 1;
      if (pairingFingerprint(s, attacker, laptopSign.publicKey, rNew) === target) matchesNew += 1;
    }
    expect(matchesNew).toBeLessThanOrEqual(1); // peluang acak 1 dari sejuta per percobaan
    expect(matchesOld).toBeLessThanOrEqual(1);
  });

  test("tantangan bertanda tangan laptop dan terikat ke permintaan HP: relay tidak bisa menukarnya", () => {
    const laptopSign = generateSignKeyPair(s);
    const req = request();
    const r = generatePairChallenge(s);
    const signature = signPairChallenge(s, req, r, laptopSign.privateKey);
    expect(verifyPairChallenge(s, signature, req, r, laptopSign.publicKey)).toBe(true);
    expect(verifyPairChallenge(s, signature, req, generatePairChallenge(s), laptopSign.publicKey)).toBe(false);
    expect(verifyPairChallenge(s, signature, request(), r, laptopSign.publicKey)).toBe(false); // permintaan HP lain
    expect(verifyPairChallenge(s, signature, { ...req, code: "ZZZZ-9999" }, r, laptopSign.publicKey)).toBe(false);
    expect(verifyPairChallenge(s, signature, req, r, generateSignKeyPair(s).publicKey)).toBe(false);
    expect(verifyPairChallenge(s, signature, req, r.slice(1), laptopSign.publicKey)).toBe(false);
  });

  test("nama perangkat: karakter lebar-nol, kendali (ESC), bidi, dan baris ditolak; NFC dan spasi ujung dinormalkan", () => {
    expect(normalizeDeviceName("iPhone Dono")).toBe("iPhone Dono");
    expect(normalizeDeviceName("  iPhone Dono  ")).toBe("iPhone Dono");
    expect(normalizeDeviceName("Cafe\u0301")).toBe("Caf\u00e9");
    for (const bad of ["iPhone Dono\u200b", "iPhone\u200dDono", "iPhone\u2060", "\u001b[2Kiphone", "a\u202eb", "a\nb", "a\u2028b", "", "   ", "x".repeat(65)]) {
      expect(normalizeDeviceName(bad), JSON.stringify(bad)).toBeUndefined();
    }
    const secret = generatePairingSecret(s);
    const req = request();
    const sneaky = { ...req, deviceName: "iPhone Dono\u200b" };
    expect(() => makePairProof(s, sneaky, secret)).toThrow(CryptoError);
    expect(verifyPairProof(s, makePairProof(s, req, secret), sneaky, secret)).toBe(false);
    expect(() => pairingFingerprint(s, sneaky, generateSignKeyPair(s).publicKey, generatePairChallenge(s))).toThrow(CryptoError);
  });

  test("kunci pasangan: arahnya terpisah (laptop tx = HP rx, HP tx = laptop rx, dan keduanya berbeda)", () => {
    const laptopKx = generateKxKeyPair(s);
    const phoneKx = generateKxKeyPair(s);
    const laptop = laptopSessionKeys(s, laptopKx, phoneKx.publicKey);
    const phone = phoneSessionKeys(s, phoneKx, laptopKx.publicKey);
    expect(laptop.tx).toEqual(phone.rx);
    expect(phone.tx).toEqual(laptop.rx);
    expect(laptop.tx).not.toEqual(laptop.rx);
    expect(() => laptopSessionKeys(s, laptopKx, new Uint8Array(32))).toThrow(CryptoError);
  });

  test("pembungkus kunci data: HP yang tepat membukanya; HP, mesin, atau kid lain ditolak; salah kunci pasangan ditolak", () => {
    const laptopKx = generateKxKeyPair(s);
    const phoneKx = generateKxKeyPair(s);
    const other = generateKxKeyPair(s);
    const laptop = laptopSessionKeys(s, laptopKx, phoneKx.publicKey);
    const phone = phoneSessionKeys(s, phoneKx, laptopKx.publicKey);
    const dataKey = generateDataKey(s);
    const context = { machineId: "m1", deviceId: "d1", kid: 1 };
    const wrapped = wrapDataKey(s, laptop.tx, dataKey, context);
    expect(unwrapDataKey(s, phone.rx, wrapped, context)).toEqual(dataKey);
    for (const change of [{ deviceId: "d2" }, { machineId: "m2" }, { kid: 2 }]) expect(() => unwrapDataKey(s, phone.rx, wrapped, { ...context, ...change })).toThrow(CryptoError);
    expect(() => unwrapDataKey(s, phoneSessionKeys(s, other, laptopKx.publicKey).rx, wrapped, context)).toThrow(CryptoError);
    expect(() => unwrapDataKey(s, phone.tx, wrapped, context)).toThrow(CryptoError); // arah salah
  });

  test("jawaban laptop bertanda tangan: HP menolak bila kolom apa pun, termasuk bungkusan kunci, diubah relay", () => {
    const laptopSign = generateSignKeyPair(s);
    const laptopKx = generateKxKeyPair(s);
    const phoneKx = generateKxKeyPair(s);
    const phoneSign = generateSignKeyPair(s);
    const keys = laptopSessionKeys(s, laptopKx, phoneKx.publicKey);
    const wrapped = wrapDataKey(s, keys.tx, generateDataKey(s), { machineId: "m1", deviceId: "d1", kid: 1 });
    const response = { machineId: "m1", deviceId: "d1", machineName: "Laptop", laptopKxPublicKey: laptopKx.publicKey, code: "ABCD-1234", kid: 1, phoneKxPublicKey: phoneKx.publicKey, phoneSignPublicKey: phoneSign.publicKey, wrapped };
    const signature = signPairResponse(s, response, laptopSign.privateKey);
    expect(verifyPairResponse(s, signature, response, laptopSign.publicKey)).toBe(true);
    expect(verifyPairResponse(s, signature, response, generateSignKeyPair(s).publicKey)).toBe(false);
    const changes = [
      { machineId: "m2" },
      { deviceId: "d2" },
      { machineName: "Laptop Palsu" },
      { laptopKxPublicKey: generateKxKeyPair(s).publicKey },
      { code: "ZZZZ-0000" },
      { kid: 2 },
      { phoneKxPublicKey: generateKxKeyPair(s).publicKey },
      { phoneSignPublicKey: generateSignKeyPair(s).publicKey },
      { wrapped: { ...wrapped, c: toB64(s, new Uint8Array(48)) } },
    ];
    for (const change of changes) expect(verifyPairResponse(s, signature, { ...response, ...change }, laptopSign.publicKey), JSON.stringify(Object.keys(change))).toBe(false);
  });
});

describe("pengodean: kolom tidak ada berbeda dari teks kosong", () => {
  test("undefined berbeda dari teks kosong, dan jenis lain ditolak", () => {
    expect(toHex(canon("x", [undefined]))).not.toBe(toHex(canon("x", [""])));
    expect(() => canon("x", [{} as unknown as string])).toThrow(CryptoError);
    expect(() => canon("x", [null as unknown as string])).toThrow(CryptoError);
  });
});

describe("perintah HP dan balasan laptop (amplop tertutup + bertanda tangan)", () => {
  const ctx = (direction: "command" | "reply" = "command") => ({ direction, machineId: "m1", deviceId: "d1" });
  function pair() {
    const laptopKx = generateKxKeyPair(s);
    const phoneKx = generateKxKeyPair(s);
    return { laptop: laptopSessionKeys(s, laptopKx, phoneKx.publicKey), phone: phoneSessionKeys(s, phoneKx, laptopKx.publicKey), phoneSign: generateSignKeyPair(s), laptopSign: generateSignKeyPair(s) };
  }
  const message = utf8(JSON.stringify({ type: "approval.decision", approvalId: "ap-1", decision: "approve" }));

  test("H mencakup SELURUH payload: diff yang berbeda dengan perintah yang sama menghasilkan H berbeda (32 byte)", () => {
    const a = approvalHash(s, utf8('{"toolInput":{"command":"ls"},"diff":"aman"}'));
    const b = approvalHash(s, utf8('{"toolInput":{"command":"ls"},"diff":"BERBAHAYA"}'));
    expect(a).not.toEqual(b);
    expect(a.length).toBe(32);
  });

  test("perintah: laptop membuka dengan kunci rx dan kunci tanda tangan HP dari catatannya; isi persis sama", () => {
    const k = pair();
    const box = sealSigned(s, k.phone.tx, k.phoneSign.privateKey, ctx(), message);
    expect(openSigned(s, k.laptop.rx, k.phoneSign.publicKey, ctx(), box)).toEqual(message);
  });

  test("balasan: HP membuka dengan kunci rx dan kunci tanda tangan LAPTOP dari QR", () => {
    const k = pair();
    const box = sealSigned(s, k.laptop.tx, k.laptopSign.privateKey, ctx("reply"), message);
    expect(openSigned(s, k.phone.rx, k.laptopSign.publicKey, ctx("reply"), box)).toEqual(message);
  });

  test("ditolak: perangkat/mesin/arah lain, kunci salah, kunci tanda tangan lain, dan SATU bit di c, n, atau s", () => {
    const k = pair();
    const box = sealSigned(s, k.phone.tx, k.phoneSign.privateKey, ctx(), message);
    const open = (overrides: { key?: Uint8Array; sign?: Uint8Array; context?: ReturnType<typeof ctx>; box?: unknown } = {}) => openSigned(s, overrides.key ?? k.laptop.rx, overrides.sign ?? k.phoneSign.publicKey, overrides.context ?? ctx(), "box" in overrides ? overrides.box : box);
    expect(() => open({ context: { ...ctx(), deviceId: "d2" } })).toThrow(CryptoError);
    expect(() => open({ context: { ...ctx(), machineId: "m2" } })).toThrow(CryptoError);
    expect(() => open({ context: ctx("reply") })).toThrow(CryptoError); // perintah tidak bisa dipakai sebagai balasan
    expect(() => open({ key: k.laptop.tx })).toThrow(CryptoError);
    expect(() => open({ key: generateDataKey(s) })).toThrow(CryptoError);
    expect(() => open({ sign: generateSignKeyPair(s).publicKey })).toThrow(CryptoError);
    for (const field of ["n", "c", "s"] as const) {
      const bytes = fromB64(s, box[field]);
      bytes[0] = bytes[0]! ^ 1;
      expect(() => open({ box: { ...box, [field]: toB64(s, bytes) } }), field).toThrow(CryptoError);
    }
    for (const junk of [null, undefined, 1, "x", [], {}, { n: 1, c: 2, s: 3 }, { ...box, s: undefined }]) expect(() => open({ box: junk })).toThrow(CryptoError);
  });

  test("pemegang kunci pasangan TANPA kunci tanda tangan tidak bisa memalsukan perintah", () => {
    const k = pair();
    const forged = sealSigned(s, k.phone.tx, generateSignKeyPair(s).privateKey, ctx(), message);
    expect(() => openSigned(s, k.laptop.rx, k.phoneSign.publicKey, ctx(), forged)).toThrow(CryptoError);
  });

  test("tanda tangan terikat ke plaintext: tanda tangan perintah lain tidak berlaku untuk isi ini", () => {
    const k = pair();
    const a = sealSigned(s, k.phone.tx, k.phoneSign.privateKey, ctx(), utf8("A"));
    const b = sealSigned(s, k.phone.tx, k.phoneSign.privateKey, ctx(), utf8("B"));
    expect(() => openSigned(s, k.laptop.rx, k.phoneSign.publicKey, ctx(), { ...b, s: a.s })).toThrow(CryptoError);
  });

  test("nonce selalu baru: dua penutupan isi yang sama menghasilkan nonce dan ciphertext berbeda", () => {
    const k = pair();
    const a = sealSigned(s, k.phone.tx, k.phoneSign.privateKey, ctx(), message);
    const b = sealSigned(s, k.phone.tx, k.phoneSign.privateKey, ctx(), message);
    expect(a.n).not.toBe(b.n);
    expect(a.c).not.toBe(b.c);
  });
});
