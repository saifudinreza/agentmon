// =====================================================================================
// FILE INI: sisi LAPTOP dari pairing E2E = "PETUGAS YANG MEMERIKSA KTP LALU MEMBERI KUNCI" (docs/security-e2e.md bagian 4.2).
// =====================================================================================
//
// Urutan untuk satu HP yang baru menukar kode (dipanggil `runPair`):
//   1. Verifikasi BUKTI rahasia QR (`crypto_auth`) dengan rahasia dari catatan laptop sendiri. Relay tidak punya rahasia itu, jadi
//      relay tidak bisa membuat bukti yang cocok. Gagal: HP dicabut.
//   2. Pilih TANTANGAN acak, tanda tangani (terikat ke permintaan HP), titipkan ke HP lewat relay. HP memakainya untuk menghitung
//      sidik jari; laptop memakainya untuk menghitung yang sama. Tantangan dipilih SETELAH permintaan diterima, supaya penyerang
//      tidak bisa menggiling permintaan yang angkanya cocok (temuan tinjauan PR #96).
//   3. KONFIRMASI MANUSIA: nama dan sidik jari ditampilkan, pengguna membandingkannya dengan layar HP lalu menjawab y/N. Tanpa 'y'
//      tidak ada kunci yang dibagikan, dan HP dicabut. Tidak ada jawaban otomatis: stdin yang bukan terminal berarti TIDAK.
//   4. Percayai HP (kunci publiknya disimpan DI LAPTOP), bungkus kunci data dengan kunci pasangan, tanda tangani jawaban, titipkan ke HP.
import {
  CryptoError,
  fromB64,
  generatePairChallenge,
  laptopSessionKeys,
  loadSodium,
  pairingFingerprint,
  signPairChallenge,
  signPairResponse,
  toB64,
  verifyPairProof,
  wrapDataKey,
  type PairRequest,
  type Sodium,
} from "@agentmon/shared/crypto";
import { sanitizeForTerminal, type PairedDevice } from "@agentmon/shared";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { currentDataKey, loadOrCreateE2e, saveE2e, trustDevice, type StoredE2e } from "./e2e-store";
import { loadOrCreateMachineId } from "./home";
import { defaultMachineName } from "./register";

export type E2ePairOptions = {
  home: string;
  /** Nomor laptop di relay (sama dengan `machineId` pada event). */
  machineId: string;
  machineName: string;
  /** Menanyakan y/N ke pengguna. Bawaan: baca satu baris dari terminal; bukan terminal berarti TIDAK. */
  confirm?: (question: string) => Promise<boolean>;
  now?: () => Date;
};

/** Pengaturan bawaan untuk laptop ini: nomor mesin dari berkas data, nama dari nama komputer. */
export function defaultE2ePairOptions(home: string): E2ePairOptions {
  return { home, machineId: loadOrCreateMachineId(home), machineName: defaultMachineName(hostname()) };
}

export type E2eSession = {
  s: Sodium;
  state: StoredE2e;
  /** Rahasia QR 32 byte; hanya di memori proses `pair` ini, tidak pernah disimpan atau dikirim ke relay. */
  secret: Uint8Array;
  /** Untuk fragmen QR: rahasia (`s`) dan kunci publik Ed25519 laptop (`k`). */
  qr: { secret: string; laptopKey: string };
};

export async function prepareE2eSession(options: E2ePairOptions, generateSecret: (s: Sodium) => Uint8Array): Promise<E2eSession> {
  const s = await loadSodium();
  const state = loadOrCreateE2e(s, options.home);
  const secret = generateSecret(s);
  return { s, state, secret, qr: { secret: toB64(s, secret), laptopKey: state.sign.publicKey } };
}

/** Bawaan: bertanya di terminal. Tanpa terminal (pipa, otomatisasi) jawabannya TIDAK, supaya tidak pernah ada persetujuan otomatis. */
export async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "ya" || answer === "yes";
  } finally {
    rl.close();
  }
}

export type DeviceOutcome = "confirmed" | "rejected" | "failed";

export type DeviceIo = {
  /** Mengirim pesan ke HP lewat relay. true bila diterima relay. */
  post: (kind: "challenge" | "response", deviceId: string, body: Record<string, unknown>) => Promise<boolean>;
  /** Mencabut HP di relay. */
  revoke: (deviceId: string) => Promise<void>;
  out: (text: string) => void;
  err: (text: string) => void;
};

const spaced = (digits: string) => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/** Memproses satu HP berbahan E2E. Mengembalikan hasilnya; `session.state` diperbarui di tempat bila HP dipercaya. */
export async function confirmE2eDevice(options: E2ePairOptions, session: E2eSession, code: string, device: PairedDevice, io: DeviceIo): Promise<DeviceOutcome> {
  const material = device.e2e;
  if (!material) return "failed";
  const { s } = session;
  const confirm = options.confirm ?? promptYesNo;
  const now = options.now ?? (() => new Date());
  const shownName = sanitizeForTerminal(device.name);

  let request: PairRequest;
  let kx: Uint8Array;
  let sign: Uint8Array;
  try {
    kx = fromB64(s, material.kx);
    sign = fromB64(s, material.sign);
    request = { code, machineId: options.machineId, deviceName: device.name, kxPublicKey: kx, signPublicKey: sign };
    if (kx.length !== 32 || sign.length !== 32 || !verifyPairProof(s, fromB64(s, material.proof), request, session.secret)) throw new CryptoError();
  } catch {
    io.err(`Perangkat '${shownName}' DITOLAK: bukti rahasia QR tidak sah. Mungkin ada pihak lain yang ikut memakai kodenya. Perangkat itu dicabut.`);
    await io.revoke(device.id);
    return "rejected";
  }

  const signPrivateKey = fromB64(s, session.state.sign.privateKey);
  const signPublicKey = fromB64(s, session.state.sign.publicKey);
  const challenge = generatePairChallenge(s);
  const challengeSig = signPairChallenge(s, request, challenge, signPrivateKey);
  if (!(await io.post("challenge", device.id, { r: toB64(s, challenge), sig: toB64(s, challengeSig) }))) {
    io.err(`Gagal mengirim tantangan ke '${shownName}' lewat relay. Perangkat dicabut; jalankan pair lagi.`);
    await io.revoke(device.id);
    return "failed";
  }

  const fingerprint = pairingFingerprint(s, request, signPublicKey, challenge);
  io.out(`Perangkat meminta dipasangkan: '${shownName}'`);
  io.out(`Sidik jari: ${spaced(fingerprint)}   (harus SAMA PERSIS dengan angka di layar HP Anda)`);
  const accepted = await confirm(`Pasangkan '${shownName}'?`);
  if (!accepted) {
    io.err(`Tidak dipasangkan${process.stdin.isTTY ? "" : " (jawaban tidak bisa diminta: bukan terminal)"}. Perangkat '${shownName}' dicabut.`);
    await io.revoke(device.id);
    return "rejected";
  }

  // Dipercaya DULU dan disimpan, baru jawabannya dikirim: HP boleh langsung memberi perintah begitu menerimanya.
  const trusted = trustDevice(session.state, device.id, { name: device.name, kx: material.kx, sign: material.sign }, now());
  saveE2e(options.home, trusted);
  session.state = trusted;
  try {
    const keys = laptopSessionKeys(s, { publicKey: fromB64(s, trusted.kx.publicKey), privateKey: fromB64(s, trusted.kx.privateKey) }, kx);
    const dataKey = currentDataKey(s, trusted);
    const wrapped = wrapDataKey(s, keys.tx, dataKey, { machineId: options.machineId, deviceId: device.id, kid: trusted.kid });
    const response = {
      machineId: options.machineId,
      deviceId: device.id,
      machineName: options.machineName,
      laptopKxPublicKey: fromB64(s, trusted.kx.publicKey),
      code,
      kid: trusted.kid,
      phoneKxPublicKey: kx,
      phoneSignPublicKey: sign,
      wrapped,
    };
    const signature = signPairResponse(s, response, signPrivateKey);
    const posted = await io.post("response", device.id, { deviceId: device.id, machineName: options.machineName, laptopKx: trusted.kx.publicKey, kid: trusted.kid, wrapped, sig: toB64(s, signature) });
    if (!posted) throw new CryptoError();
  } catch {
    // Jawaban tidak sampai: jangan menyisakan kepercayaan pada HP yang tidak pernah menerima kunci.
    const rolled = { ...session.state, devices: { ...session.state.devices } };
    delete rolled.devices[device.id];
    saveE2e(options.home, rolled);
    session.state = rolled;
    io.err(`Gagal mengirim kunci ke '${shownName}'. Perangkat dicabut; jalankan pair lagi.`);
    await io.revoke(device.id);
    return "failed";
  }
  io.out(`Perangkat baru terpasang (terenkripsi ujung-ke-ujung): ${shownName}`);
  return "confirmed";
}
