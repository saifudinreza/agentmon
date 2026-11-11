// =====================================================================================
// FILE INI: direktori pemasangan berbasis database = "BUKU TELEPON PERMANEN".
// =====================================================================================
//
// Menggantikan versi memori (../directory.ts) dengan data yang bertahan setelah relay dimulai ulang.
// Antarmukanya sama (RelayDirectory), jadi hub tidak perlu diubah: ia hanya bertanya, dan
// pertanyaannya dijawab dari database.
//
// KEAMANAN TOKEN: token tidak pernah masuk database. Yang disimpan hash SHA-256-nya, dan batasan
// CHECK di skema menolak apa pun yang bukan hash (jaring pengaman bila ada kode yang tak sengaja
// menyimpan token mentah).
//
// PERANGKAT YANG DICABUT: baris HP tetap ada (jejaknya terjaga) tetapi `revokedAt` terisi, dan sejak
// itu HP tersebut tidak bisa tersambung dan tidak dianggap dipasangkan dengan siapa pun.
import { and, asc, eq, isNull } from "drizzle-orm";
import { hashToken, type RelayDirectory } from "../directory";
import type { Database } from "./connect";
import { devices, machines, pairings, pushSubscriptions } from "./schema";

export type DbDirectory = RelayDirectory & {
  registerMachine(input: { id: string; name: string; token: string }): Promise<void>;
  registerDevice(input: { id: string; name: string; token: string; publicKey?: string }): Promise<void>;
  pair(machineId: string, deviceId: string): Promise<void>;
  unpair(machineId: string, deviceId: string): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  devicesWithPush(machineId: string): Promise<readonly string[]>;
  /** Laptop yang dipasangkan dengan sebuah HP (HP yang dicabut tidak mendapat apa pun), berurutan menurut nama. */
  machinesOf(deviceId: string): Promise<Array<{ id: string; name: string }>>;
};

// Sama dengan batas minimum token di bingkai `hello`. Token yang lebih pendek tidak mungkin dipakai
// untuk tersambung, jadi tidak ada gunanya didaftarkan.
const MIN_TOKEN_LENGTH = 16;

function assertToken(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) throw new RangeError(`Token minimal ${MIN_TOKEN_LENGTH} karakter`);
}

export function createDbDirectory(db: Database, options: { now?: () => Date } = {}): DbDirectory {
  const now = options.now ?? (() => new Date());

  return {
    async authenticate(role, token) {
      const hash = hashToken(token);
      if (role === "machine") {
        const [row] = await db.select({ id: machines.id }).from(machines).where(eq(machines.tokenHash, hash)).limit(1);
        if (!row) return undefined;
        // Mencatat "terakhir terlihat" hanya pembukuan, bukan bagian dari keputusan autentikasi. Bila
        // hanya pencatatan ini yang gagal (misalnya batas waktu sesaat), laptop yang tokennya sah tidak
        // boleh ikut ditolak. "Gagal tertutup" berlaku untuk keputusan: pencarian token di atas, yang
        // bila gagal tetap melempar galat dan membuat hub menolak.
        try {
          await db.update(machines).set({ lastSeenAt: now() }).where(eq(machines.id, row.id));
        } catch {
          // diabaikan: hanya pembukuan
        }
        return row.id;
      }
      // HP yang dicabut tidak bisa tersambung.
      const [row] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.tokenHash, hash), isNull(devices.revokedAt)))
        .limit(1);
      return row?.id;
    },

    async devicesOf(machineId) {
      const rows = await db
        .select({ id: devices.id })
        .from(pairings)
        .innerJoin(devices, eq(devices.id, pairings.deviceId))
        .where(and(eq(pairings.machineId, machineId), isNull(devices.revokedAt)));
      return rows.map((row) => row.id);
    },

    async devicesWithPush(machineId) {
      const rows = await db
        .selectDistinct({ id: devices.id })
        .from(pairings)
        .innerJoin(devices, eq(devices.id, pairings.deviceId))
        .innerJoin(pushSubscriptions, eq(pushSubscriptions.deviceId, devices.id))
        .where(and(eq(pairings.machineId, machineId), isNull(devices.revokedAt)));
      return rows.map((row) => row.id);
    },

    async machinesOf(deviceId) {
      const rows = await db
        .select({ id: machines.id, name: machines.name })
        .from(pairings)
        .innerJoin(machines, eq(machines.id, pairings.machineId))
        .innerJoin(devices, eq(devices.id, pairings.deviceId))
        .where(and(eq(pairings.deviceId, deviceId), isNull(devices.revokedAt)))
        .orderBy(asc(machines.name), asc(machines.id));
      return rows;
    },

    async isPaired(machineId, deviceId) {
      const rows = await db
        .select({ id: devices.id })
        .from(pairings)
        .innerJoin(devices, eq(devices.id, pairings.deviceId))
        .where(and(eq(pairings.machineId, machineId), eq(pairings.deviceId, deviceId), isNull(devices.revokedAt)))
        .limit(1);
      return rows.length > 0;
    },

    async registerMachine({ id, name, token }) {
      assertToken(token);
      await db.insert(machines).values({ id, name, tokenHash: hashToken(token) });
    },

    async registerDevice({ id, name, token, publicKey }) {
      assertToken(token);
      await db.insert(devices).values({ id, name, tokenHash: hashToken(token), ...(publicKey !== undefined ? { publicKey } : {}) });
    },

    async pair(machineId, deviceId) {
      // Memasangkan dua kali tidak menggandakan dan tidak error.
      await db.insert(pairings).values({ machineId, deviceId }).onConflictDoNothing();
    },

    async unpair(machineId, deviceId) {
      await db.delete(pairings).where(and(eq(pairings.machineId, machineId), eq(pairings.deviceId, deviceId)));
    },

    async revokeDevice(deviceId) {
      await db.update(devices).set({ revokedAt: now() }).where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
    },
  };
}
