// =====================================================================================
// FILE INI: sisi LAPTOP dari pairing E2E = "PETUGAS YANG MEMERIKSA KTP LALU MEMBERI KUNCI" (docs/security-e2e.md bagian 4.2).
// =====================================================================================
//
// Urutan untuk satu HP yang menukar KODE MILIK laptop ini (dipanggil `runPair`):
//   1. Verifikasi BUKTI rahasia QR (`crypto_auth`) dengan rahasia dari catatan laptop sendiri. Relay tidak punya rahasia itu, jadi
//      relay tidak bisa membuat bukti yang cocok. Gagal: pasangan HP ini dilepas (hanya di laptop ini).
//   2. Pilih TANTANGAN acak, tanda tangani (terikat ke permintaan HP), titipkan ke HP lewat relay. HP memakainya untuk menghitung
//      sidik jari; laptop memakainya untuk menghitung yang sama. Tantangan dipilih SETELAH permintaan diterima, supaya penyerang
//      tidak bisa menggiling permintaan yang angkanya cocok (temuan tinjauan PR #96).
//   3. KONFIRMASI MANUSIA: nama dan sidik jari ditampilkan, pengguna membandingkannya dengan layar HP lalu menjawab y/N. Tanpa 'y'
//      tidak ada kunci yang dibagikan, dan pasangannya dilepas. Tidak ada jawaban otomatis: stdin yang bukan terminal berarti TIDAK.
//   4. Percayai HP (kunci publiknya disimpan DI LAPTOP, di dalam kunci berkas), bungkus kunci data dengan kunci pasangan, tanda tangani
//      jawaban, titipkan ke HP. Gagal di mana pun (termasuk menyimpan): kepercayaan dikembalikan ke keadaan SEBELUMNYA.
//
// "Dilepas" = `DELETE /pair/devices/:id?scope=pairing`: HANYA pasangan dengan laptop ini; HP yang sama di laptop lain tidak terganggu.
// Pelepasan yang gagal dilaporkan jujur (HP MASIH terpasang di relay), bukan diklaim berhasil.
//
// HP versi lama (tanpa bahan E2E) yang memakai QR ini juga HARUS dikonfirmasi pengguna: tanpa itu, QR yang bocor cukup dipakai tanpa
// mengirim bahan E2E untuk melewati sidik jari.
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
import { currentDataKey, loadE2e, trustDevice, updateE2e, type StoredE2e, type TrustedDevice } from "./e2e-store";
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
  /** Rahasia QR 32 byte; hanya di memori proses `pair` ini, tidak pernah disimpan atau dikirim ke relay. */
  secret: Uint8Array;
  /** Untuk fragmen QR: rahasia (`s`), kunci publik Ed25519 laptop (`k`), dan nomor laptop (`m`, dipakai HP untuk membuat bukti). */
  qr: { secret: string; laptopKey: string; machineId: string };
};

/** Menyiapkan sesi: memuat (atau membuat, di dalam kunci berkas) identitas laptop dan membuat rahasia QR baru. */
export async function prepareE2eSession(options: E2ePairOptions, generateSecret: (s: Sodium) => Uint8Array): Promise<E2eSession> {
  const s = await loadSodium();
  const state = await updateE2e(s, options.home, (current) => current);
  const secret = generateSecret(s);
  return { s, secret, qr: { secret: toB64(s, secret), laptopKey: state.sign.publicKey, machineId: options.machineId } };
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
  /** Melepas pasangan HP ini dengan laptop ini di relay (bukan pencabutan global). true bila relay mengonfirmasi. */
  unpair: (deviceId: string) => Promise<boolean>;
  out: (text: string) => void;
  err: (text: string) => void;
};

const spaced = (digits: string) => `${digits.slice(0, 3)} ${digits.slice(3)}`;

/** Melepas pasangan dengan jujur: bila relay tidak mengonfirmasi, pengguna diberi tahu bahwa HP MASIH terpasang di relay. */
async function release(io: DeviceIo, device: PairedDevice, shownName: string): Promise<void> {
  let ok: boolean;
  try {
    ok = await io.unpair(device.id);
  } catch {
    ok = false;
  }
  if (!ok) io.err(`PERINGATAN: '${shownName}' MASIH terpasang di relay (pelepasan gagal). Lepaskan dengan: devices lalu revoke ${sanitizeForTerminal(device.id)}`);
}

/** Memperbarui kepercayaan di dalam kunci berkas, dan mengembalikan keadaan SEBELUMNYA untuk entri itu (untuk rollback). */
async function trust(options: E2ePairOptions, s: Sodium, device: PairedDevice, material: { kx: string; sign: string }): Promise<{ state: StoredE2e; previous: TrustedDevice | undefined }> {
  let previous: TrustedDevice | undefined;
  const state = await updateE2e(s, options.home, (current) => {
    previous = current.devices[device.id];
    return trustDevice(current, device.id, { name: device.name, kx: material.kx, sign: material.sign }, (options.now ?? (() => new Date()))());
  });
  return { state, previous };
}

async function rollback(options: E2ePairOptions, s: Sodium, deviceId: string, previous: TrustedDevice | undefined): Promise<void> {
  await updateE2e(s, options.home, (current) => {
    const devices = { ...current.devices };
    if (previous) devices[deviceId] = previous;
    else delete devices[deviceId];
    return { ...current, devices };
  });
}

/** Memproses satu HP berbahan E2E dari kode ini. Mengembalikan hasilnya. */
export async function confirmE2eDevice(options: E2ePairOptions, session: E2eSession, code: string, device: PairedDevice, io: DeviceIo): Promise<DeviceOutcome> {
  const material = device.e2e;
  if (!material) return "failed";
  const { s } = session;
  const confirm = options.confirm ?? promptYesNo;
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
    io.err(`Perangkat '${shownName}' DITOLAK: bukti rahasia QR tidak sah. Mungkin ada pihak lain yang ikut memakai kodenya. Pasangannya dilepas.`);
    await release(io, device, shownName);
    return "rejected";
  }

  const state = loadE2e(options.home);
  if (!state) {
    io.err("Kunci enkripsi laptop tidak ditemukan. Pasangannya dilepas; jalankan pair lagi.");
    await release(io, device, shownName);
    return "failed";
  }
  const signPrivateKey = fromB64(s, state.sign.privateKey);
  const signPublicKey = fromB64(s, state.sign.publicKey);
  const challenge = generatePairChallenge(s);
  const challengeSig = signPairChallenge(s, request, challenge, signPrivateKey);
  if (!(await io.post("challenge", device.id, { r: toB64(s, challenge), sig: toB64(s, challengeSig) }))) {
    io.err(`Gagal mengirim tantangan ke '${shownName}' lewat relay. Pasangannya dilepas; jalankan pair lagi.`);
    await release(io, device, shownName);
    return "failed";
  }

  const fingerprint = pairingFingerprint(s, request, signPublicKey, challenge);
  io.out(`Perangkat meminta dipasangkan: '${shownName}'`);
  // HP yang nomornya SUDAH dipercaya tetapi kuncinya berbeda: pengguna harus tahu ini PENGGANTIAN (nomor berasal dari relay).
  const existing = state.devices[device.id];
  if (existing && existing.revokedAt === undefined && (existing.sign !== material.sign || existing.kx !== material.kx)) {
    io.out(`  PERHATIAN: ini MENGGANTI kunci perangkat tepercaya '${sanitizeForTerminal(existing.name)}' (dipasangkan ${sanitizeForTerminal(existing.confirmedAt)}). Hanya lanjutkan bila Anda memang memasangkan ulang HP itu.`);
  }
  io.out(`Sidik jari: ${spaced(fingerprint)}   (harus SAMA PERSIS dengan angka di layar HP Anda)`);
  const accepted = await confirm(`Pasangkan '${shownName}'?`);
  if (!accepted) {
    io.err(`Tidak dipasangkan${process.stdin.isTTY ? "" : " (jawaban tidak bisa diminta: bukan terminal)"}. Pasangan '${shownName}' dilepas.`);
    await release(io, device, shownName);
    return "rejected";
  }

  // Dipercaya DULU dan disimpan, baru jawabannya dikirim: HP boleh langsung memberi perintah begitu menerimanya. Seluruh langkah ini,
  // termasuk menyimpan dan membatalkan, ada dalam satu try: apa pun yang gagal berujung pada keadaan semula dan pasangan dilepas.
  let previous: TrustedDevice | undefined;
  let changed = false;
  try {
    const trusted = await trust(options, s, device, material);
    previous = trusted.previous;
    changed = true;
    const keys = laptopSessionKeys(s, { publicKey: fromB64(s, trusted.state.kx.publicKey), privateKey: fromB64(s, trusted.state.kx.privateKey) }, kx);
    const dataKey = currentDataKey(s, trusted.state);
    const wrapped = wrapDataKey(s, keys.tx, dataKey, { machineId: options.machineId, deviceId: device.id, kid: trusted.state.kid });
    const response = {
      machineId: options.machineId,
      deviceId: device.id,
      machineName: options.machineName,
      laptopKxPublicKey: fromB64(s, trusted.state.kx.publicKey),
      code,
      kid: trusted.state.kid,
      phoneKxPublicKey: kx,
      phoneSignPublicKey: sign,
      wrapped,
    };
    const signature = signPairResponse(s, response, signPrivateKey);
    const posted = await io.post("response", device.id, { deviceId: device.id, machineName: options.machineName, laptopKx: trusted.state.kx.publicKey, kid: trusted.state.kid, wrapped, sig: toB64(s, signature) });
    if (!posted) throw new CryptoError();
  } catch {
    if (changed) {
      try {
        await rollback(options, s, device.id, previous);
      } catch {
        io.err(`PERINGATAN: kepercayaan untuk '${shownName}' tidak bisa dibatalkan di berkas kunci. Periksa ${options.home} (e2e.json) sebelum memakai AgentMon.`);
      }
    }
    io.err(`Gagal menyelesaikan pairing '${shownName}'. Pasangannya dilepas; jalankan pair lagi.`);
    await release(io, device, shownName);
    return "failed";
  }
  io.out(`Perangkat baru terpasang (terenkripsi ujung-ke-ujung): ${shownName}`);
  return "confirmed";
}

/** HP versi lama (tanpa bahan E2E) yang memakai QR E2E: tetap harus dikonfirmasi pengguna (tanpa terminal berarti TIDAK). */
export async function confirmLegacyDevice(options: E2ePairOptions, device: PairedDevice, io: DeviceIo): Promise<DeviceOutcome> {
  const confirm = options.confirm ?? promptYesNo;
  const shownName = sanitizeForTerminal(device.name);
  io.out(`Perangkat meminta dipasangkan TANPA enkripsi ujung-ke-ujung: '${shownName}'`);
  io.out("  HP ini memakai aplikasi versi lama, atau seseorang memakai QR ini tanpa kunci enkripsi (QR bocor). Event tidak akan terenkripsi untuknya, dan begitu ada HP terenkripsi ia tidak akan menerima apa-apa.");
  if (!(await confirm(`Tetap pasangkan '${shownName}' tanpa enkripsi?`))) {
    io.err(`Tidak dipasangkan${process.stdin.isTTY ? "" : " (jawaban tidak bisa diminta: bukan terminal)"}. Pasangan '${shownName}' dilepas.`);
    await release(io, device, shownName);
    return "rejected";
  }
  io.out(`Perangkat baru terpasang (TANPA enkripsi ujung-ke-ujung): ${shownName}`);
  return "confirmed";
}
