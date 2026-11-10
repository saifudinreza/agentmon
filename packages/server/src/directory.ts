// =====================================================================================
// FILE INI: direktori pemasangan = "BUKU TELEPON" milik relay.
// =====================================================================================
//
// Relay perlu menjawab tiga pertanyaan, dan semuanya ditanyakan lewat antarmuka ini:
//   1. Siapa yang sedang menelepon? (cek token -> nomor laptop atau HP)
//   2. HP mana saja yang dipasangkan dengan laptop ini?
//   3. Apakah laptop X dan HP Y dipasangkan?
//
// Antarmuka dipisah dari isinya supaya relay tidak peduli di mana datanya disimpan. Sekarang ada
// satu isi: versi di memori (di bawah), untuk test dan pengembangan. Versi database dibuat di
// issue skema database, dan pairing lewat QR di issue berikutnya.
//
// KEAMANAN TOKEN: token tidak pernah disimpan apa adanya, hanya hash-nya (SHA-256). Kalau data
// ini bocor, penyerang tidak bisa memakai hash itu untuk menyamar. Karena token dibuat acak dan
// panjang (bukan kata sandi buatan manusia), hash cepat seperti SHA-256 sudah cukup.
import { createHash } from "node:crypto";
import type { RelayRole } from "@agentmon/shared";

export interface RelayDirectory {
  /** Memeriksa token. Mengembalikan nomor laptop atau HP-nya, atau undefined bila tidak dikenal. */
  authenticate(role: RelayRole, token: string): Promise<string | undefined>;
  /** Nomor semua HP yang dipasangkan dengan sebuah laptop. */
  devicesOf(machineId: string): Promise<readonly string[]>;
  /** Apakah laptop dan HP ini dipasangkan? */
  isPaired(machineId: string, deviceId: string): Promise<boolean>;
}

/** Hash token yang disimpan sebagai pengganti token aslinya. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type MemoryDirectory = RelayDirectory & {
  addMachine(id: string, token: string): void;
  addDevice(id: string, token: string): void;
  pair(machineId: string, deviceId: string): void;
  unpair(machineId: string, deviceId: string): void;
};

/** Direktori di memori, untuk test dan pengembangan. Data hilang saat proses berhenti. */
export function createMemoryDirectory(): MemoryDirectory {
  // hash token -> nomor. Terpisah per peran, supaya token HP tidak bisa dipakai sebagai laptop.
  const machines = new Map<string, string>();
  const devices = new Map<string, string>();
  // nomor laptop -> kumpulan nomor HP yang dipasangkan
  const pairs = new Map<string, Set<string>>();

  return {
    addMachine: (id, token) => void machines.set(hashToken(token), id),
    addDevice: (id, token) => void devices.set(hashToken(token), id),
    pair(machineId, deviceId) {
      const set = pairs.get(machineId) ?? new Set<string>();
      set.add(deviceId);
      pairs.set(machineId, set);
    },
    unpair: (machineId, deviceId) => void pairs.get(machineId)?.delete(deviceId),

    async authenticate(role, token) {
      return (role === "machine" ? machines : devices).get(hashToken(token));
    },
    async devicesOf(machineId) {
      return [...(pairs.get(machineId) ?? [])];
    },
    async isPaired(machineId, deviceId) {
      return pairs.get(machineId)?.has(deviceId) ?? false;
    },
  };
}
