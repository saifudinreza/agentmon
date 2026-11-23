// =====================================================================================
// FILE INI: pairing E2E dari sisi HP = "MENUKAR KODE LALU MENUNGGU LAPTOP MEMERIKSA KTP" (docs/security-e2e.md bagian 4.2).
// =====================================================================================
//
// Urutan:
//   1. Buat identitas HP (sekali), hitung BUKTI rahasia QR (`crypto_auth`) atas permintaan ini, tukar kode ke relay dengan menyertakan
//      kunci publik dan bukti. Relay hanya meneruskannya ke laptop; tanpa rahasia dari QR ia tidak bisa membuat bukti yang cocok.
//   2. Menunggu TANTANGAN dari laptop (kotak surat relay). Tanda tangannya DIVERIFIKASI dengan kunci laptop dari QR (bukan dari relay),
//      lalu sidik jari 6 digit dihitung dan DITAMPILKAN supaya pengguna mencocokkannya dengan layar laptop.
//   3. Menunggu JAWABAN laptop (hanya diterima SETELAH tantangan diverifikasi, jadi pengguna selalu sempat melihat sidik jari). Jawaban
//      diverifikasi: tanda tangan laptop, kunci HP kita sendiri, kode, dan nomor HP kita. Baru kunci data dibuka dan disimpan di brankas.
//   4. Gagal di tahap mana pun (ditolak laptop, kedaluwarsa, relay lama, jawaban tidak sah): laptop itu DIBUANG dari pairing HP ini, tidak
//      ada yang tersisa setengah jalan.
// Pesan yang tidak sah dari relay diabaikan (paling buruk menghasilkan kedaluwarsa), tidak pernah diterima setengah.
import { E2eChallengeBodySchema, E2eResponseBodySchema, normalizeDeviceName, type PairingLink } from "@agentmon/shared";
import {
  fromB64,
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
import { createRelayApi, RelayApiError, type RelayApi } from "../relay/api";
import { redeemPairing, type RedeemDeps, type RedeemOutcome } from "../pairing/redeem";
import { removeMachine } from "../pairing/storage";
import type { Keyring } from "./keyring";

export type E2ePairPhase = { step: "redeeming" } | { step: "waiting" } | { step: "confirm"; fingerprint: string };

export type E2ePairOutcome =
  | RedeemOutcome
  /** Tautan QR E2E tidak lengkap atau rusak (mis. ada kunci laptop tetapi rahasianya hilang). Tidak diturunkan diam-diam ke pairing polos. */
  | { status: "e2e-link" }
  /** Nama perangkat tidak baku (karakter kendali, lebar-nol, terlalu panjang/pendek). */
  | { status: "e2e-name" }
  /** Relay belum mendukung pairing E2E (versi lama). */
  | { status: "e2e-relay-old" }
  /** Laptop menolak (pengguna menjawab tidak, atau bukti tidak sah): pasangan dilepas di relay. */
  | { status: "e2e-rejected" }
  /** Jawaban laptop tidak sah, atau relay memberi nomor laptop yang berbeda dari QR. */
  | { status: "e2e-invalid" }
  /** Laptop tidak menjawab sampai batas waktu. */
  | { status: "e2e-timeout" }
  /** Penyimpanan kunci di HP ini tidak tersedia atau rusak. */
  | { status: "e2e-unavailable" };

export type E2ePairDeps = RedeemDeps & {
  s: Sodium;
  keyring: Keyring;
  /** Hanya untuk tes: pembuat klien relay (bawaan: `createRelayApi`). */
  makeApi?: (relayUrl: string, token: string) => Pick<RelayApi, "e2eMessages">;
  sleep?: (ms: number) => Promise<void>;
  /** Hanya untuk tes. */
  pollMs?: number;
  waitMs?: number;
};

const DEFAULT_POLL_MS = 1500;
// Kode berlaku 5 menit; laptop menunggu pengguna menjawab, jadi HP menunggu sedikit lebih lama.
const DEFAULT_WAIT_MS = 6 * 60_000;

export const isE2eLink = (link: PairingLink): boolean => link.secret !== undefined || link.laptopKey !== undefined || link.machineId !== undefined;

export async function pairE2e(link: PairingLink, name: string, deps: E2ePairDeps, onPhase: (phase: E2ePairPhase) => void): Promise<E2ePairOutcome> {
  const { s, keyring } = deps;
  if (link.secret === undefined || link.laptopKey === undefined || link.machineId === undefined) return { status: "e2e-link" };
  const deviceName = normalizeDeviceName(name);
  if (deviceName === undefined) return { status: "e2e-name" };

  let secret: Uint8Array;
  let laptopSign: Uint8Array;
  try {
    secret = fromB64(s, link.secret);
    laptopSign = fromB64(s, link.laptopKey);
    if (secret.length !== 32 || laptopSign.length !== 32) return { status: "e2e-link" };
  } catch {
    return { status: "e2e-link" };
  }
  const machineId = link.machineId;

  const phone = await keyring.ensurePhone();
  const request: PairRequest = { code: link.code, machineId, deviceName, kxPublicKey: phone.kx.publicKey, signPublicKey: phone.sign.publicKey };
  const proof = makePairProof(s, request, secret);

  onPhase({ step: "redeeming" });
  const redeemed = await redeemPairing(link, deviceName, deps, { kx: toB64(s, phone.kx.publicKey), sign: toB64(s, phone.sign.publicKey), proof: toB64(s, proof) });
  if (redeemed.status !== "success") return redeemed;

  const { pairing } = redeemed;
  // Yang dibuang adalah laptop yang BENAR-BENAR tersimpan oleh penukaran tadi (nomor dari relay), yang bisa berbeda dari nomor di QR.
  const drop = () => removeMachine(deps.storage as Storage | undefined, pairing.relayUrl, redeemed.machine.id);
  // Relay harus memberi nomor laptop yang sama dengan yang ada di QR (nomor itu sudah ikut di dalam bukti).
  if (redeemed.machine.id !== machineId) {
    drop();
    return { status: "e2e-invalid" };
  }

  const api = (deps.makeApi ?? ((relayUrl, token) => createRelayApi({ relayUrl, token })))(pairing.relayUrl, pairing.deviceToken);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now().getTime() + (deps.waitMs ?? DEFAULT_WAIT_MS);

  onPhase({ step: "waiting" });
  let after = 0;
  let challengeSeen = false;
  let reachedRelay = false;
  while (now().getTime() < deadline) {
    let messages;
    try {
      messages = await api.e2eMessages(machineId, after);
      reachedRelay = true;
    } catch (error) {
      if (error instanceof RelayApiError && error.kind === "unauthorized") {
        // Perangkat ini dicabut (laptop menolak pairing dan tidak ada pasangan lain): selesai.
        drop();
        return { status: "e2e-rejected" };
      }
      if (error instanceof RelayApiError && error.kind === "not-found" && !reachedRelay) {
        drop();
        return { status: "e2e-relay-old" };
      }
      await sleep(pollMs);
      continue;
    }

    for (const message of messages) {
      after = Math.max(after, message.id);
      if (message.kind === "challenge" && !challengeSeen) {
        const body = E2eChallengeBodySchema.safeParse(message.body);
        if (!body.success) continue;
        try {
          const r = fromB64(s, body.data.r);
          if (!verifyPairChallenge(s, fromB64(s, body.data.sig), request, r, laptopSign)) continue;
          challengeSeen = true;
          onPhase({ step: "confirm", fingerprint: pairingFingerprint(s, request, laptopSign, r) });
        } catch {
          continue;
        }
      } else if (message.kind === "response" && challengeSeen) {
        const body = E2eResponseBodySchema.safeParse(message.body);
        // Nomor HP ini HARUS yang ditentukan laptop dan ikut ditandatangani; yang lain tidak diterima.
        if (!body.success || body.data.deviceId !== pairing.deviceId) continue;
        try {
          const laptopKx = fromB64(s, body.data.laptopKx);
          const full = {
            machineId,
            deviceId: body.data.deviceId,
            machineName: body.data.machineName,
            laptopKxPublicKey: laptopKx,
            code: link.code,
            kid: body.data.kid,
            phoneKxPublicKey: phone.kx.publicKey,
            phoneSignPublicKey: phone.sign.publicKey,
            wrapped: body.data.wrapped,
          };
          if (!verifyPairResponse(s, fromB64(s, body.data.sig), full, laptopSign)) continue;
          const session = phoneSessionKeys(s, phone.kx, laptopKx);
          const dataKey = unwrapDataKey(s, session.rx, body.data.wrapped, { machineId, deviceId: body.data.deviceId, kid: body.data.kid });
          await keyring.saveMachine({ machineId, relayUrl: pairing.relayUrl, deviceId: body.data.deviceId, laptopSignPublicKey: laptopSign, laptopKxPublicKey: laptopKx, kid: body.data.kid, dataKey });
          return redeemed;
        } catch {
          continue;
        }
      }
    }
    await sleep(pollMs);
  }
  drop();
  return { status: "e2e-timeout" };
}
