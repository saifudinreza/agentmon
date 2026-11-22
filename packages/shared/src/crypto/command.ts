// =====================================================================================
// FILE INI: perintah HP ke laptop (keputusan, rollback, pencabutan) = AMPLOP TERTUTUP + TANDA TANGAN (docs/security-e2e.md 4.5).
// =====================================================================================
//
// Dua lapis: (1) AEAD dengan kunci pasangan HP ke laptop (kerahasiaan, terikat ke mesin dan perangkat), (2) tanda tangan Ed25519
// HP atas isi keputusan, termasuk `H` = hash SELURUH payload izin yang HP lihat (bukan hanya toolInput), supaya relay tidak bisa
// menyodorkan diff atau risiko palsu dengan perintah yang sama. Urutan pemeriksaan di laptop (docs 4.5) dan penyimpanan anti-replay
// ada di issue #034; di sini hanya primitifnya.
import { aeadOpen, aeadSeal } from "./event";
import { canon, CryptoError, fromB64, toB64, type Field } from "./encoding";
import type { Sodium } from "./sodium";

export const DECISION_LABEL = "agentmon/decision/v1";
export const COMMAND_LABEL = "agentmon/cmd/v1";

/** H = hash 32 byte atas SELURUH plaintext payload `approval.requested` persis seperti yang laptop kirim. */
export function approvalHash(s: Sodium, plaintext: Uint8Array): Uint8Array {
  return s.crypto_generichash(32, plaintext, null);
}

export type DecisionFields = {
  machineId: string;
  deviceId: string;
  sessionId: string;
  approvalId: string;
  /** Nomor event `approval.requested` yang diputuskan. */
  eventId: string;
  h: Uint8Array;
  decision: "approve" | "deny";
  /** Keputusan per bagian (hunk), bentuk kanonis ditentukan #034. Kosong = seluruhnya. */
  hunks?: string;
  comment?: string;
  /** Nomor acak perintah ini; laptop menolak yang sudah pernah dipakai. */
  commandId: string;
};

function decisionInput(d: DecisionFields): Uint8Array {
  if (d.h.length !== 32) throw new CryptoError();
  const fields: Field[] = [d.machineId, d.deviceId, d.sessionId, d.approvalId, d.eventId, d.h, d.decision, d.hunks, d.comment, d.commandId];
  return canon(DECISION_LABEL, fields);
}

export function signDecision(s: Sodium, fields: DecisionFields, phoneSignPrivateKey: Uint8Array): Uint8Array {
  return s.crypto_sign_detached(decisionInput(fields), phoneSignPrivateKey);
}

/** Laptop memverifikasi dengan kunci HP dari BERKASNYA sendiri. Tidak pernah melempar. */
export function verifyDecision(s: Sodium, signature: Uint8Array, fields: DecisionFields, phoneSignPublicKey: Uint8Array): boolean {
  try {
    return s.crypto_sign_verify_detached(signature, decisionInput(fields), phoneSignPublicKey);
  } catch {
    return false;
  }
}

export type CommandContext = { machineId: string; deviceId: string };
export type SealedCommand = { n: string; c: string };

const commandAad = (context: CommandContext): Uint8Array => canon(COMMAND_LABEL, [context.machineId, context.deviceId]);

/** HP menutup perintah dengan kunci `tx` pasangannya (HP ke laptop). */
export function sealCommand(s: Sodium, phoneToLaptopKey: Uint8Array, context: CommandContext, plaintext: Uint8Array): SealedCommand {
  const { n, c } = aeadSeal(s, phoneToLaptopKey, commandAad(context), plaintext);
  return { n: toB64(s, n), c: toB64(s, c) };
}

/** Laptop membuka dengan kunci `rx` untuk HP itu. Gagal = `CryptoError`, tidak ada keputusan. */
export function openCommand(s: Sodium, phoneToLaptopKey: Uint8Array, context: CommandContext, sealed: SealedCommand): Uint8Array {
  return aeadOpen(s, phoneToLaptopKey, commandAad(context), fromB64(s, sealed.n), fromB64(s, sealed.c));
}
