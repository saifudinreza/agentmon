// =====================================================================================
// FILE INI: penyimpanan langganan Web Push = "BUKU ALAMAT NOTIFIKASI" tiap HP.
// =====================================================================================
//
// Satu HP memegang SATU langganan (satu browser atau PWA terpasang). Mendaftar ulang menggantikan yang lama,
// jadi baris tidak menumpuk walau browser berkali-kali mengganti alamat langganannya.
//
// SIAPA YANG DIHUBUNGI: untuk sebuah laptop, hanya HP yang MASIH dipasangkan dengannya dan BELUM dicabut. HP yang
// dicabut tidak boleh menerima notifikasi lagi walau barisnya belum terhapus.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "./connect";
import { devices, pairings, pushSubscriptions } from "./schema";

export type StoredSubscription = {
  id: string;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Jenis notifikasi yang diinginkan HP ini (FR-33). */
  notifyApprovals: boolean;
  notifyDone: boolean;
};
export type SubscriptionInput = { endpoint: string; p256dh: string; auth: string };

// Pengaman: satu laptop tidak mungkin dipasangkan dengan sebanyak ini HP.
const MAX_SUBSCRIPTIONS_PER_MACHINE = 200;

export type PushStore = {
  /** Menyimpan langganan sebuah HP dan MENGGANTIKAN yang lama. Alamat yang sama dipindahkan ke HP ini. */
  replace(deviceId: string, input: SubscriptionInput): Promise<void>;
  /** Menghapus semua langganan sebuah HP. Mengembalikan jumlah yang terhapus. */
  removeAll(deviceId: string): Promise<number>;
  /** Menghapus langganan menurut nomor barisnya (dipakai untuk langganan yang sudah mati). */
  removeByIds(ids: readonly string[]): Promise<void>;
  /** Langganan semua HP yang masih dipasangkan dengan laptop ini dan belum dicabut. */
  forMachine(machineId: string): Promise<StoredSubscription[]>;
  /** Langganan satu HP yang belum dicabut (kosong bila belum berlangganan). */
  forDevice(deviceId: string): Promise<StoredSubscription[]>;
  /** Pengaturan jenis notifikasi HP ini, atau undefined bila belum berlangganan. */
  getPreferences(deviceId: string): Promise<{ approvals: boolean; done: boolean } | undefined>;
  /** Mengubah pengaturan HP ini (yang tidak disebut tetap). false bila HP belum berlangganan. */
  setPreferences(deviceId: string, update: { approvals?: boolean; done?: boolean }): Promise<boolean>;
};

const columns = {
  id: pushSubscriptions.id,
  deviceId: pushSubscriptions.deviceId,
  endpoint: pushSubscriptions.endpoint,
  p256dh: pushSubscriptions.p256dh,
  auth: pushSubscriptions.auth,
  notifyApprovals: pushSubscriptions.notifyApprovals,
  notifyDone: pushSubscriptions.notifyDone,
};

export function createPushStore(db: Database): PushStore {
  return {
    async replace(deviceId, input) {
      await db.transaction(async (tx) => {
        // Pengaturan HP ini diwariskan ke langganan baru: berlangganan ulang (alamat berganti, kunci berganti) tidak boleh
        // mengembalikan notifikasi yang sengaja sudah dimatikan.
        const [previous] = await tx
          .select({ notifyApprovals: pushSubscriptions.notifyApprovals, notifyDone: pushSubscriptions.notifyDone })
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.deviceId, deviceId))
          .limit(1)
          .for("update"); // dikunci: PUT /preferences yang bersamaan menunggu, jadi pengaturan barunya tidak hilang
        await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.deviceId, deviceId), ne(pushSubscriptions.endpoint, input.endpoint)));
        await tx
          .insert(pushSubscriptions)
          .values({ deviceId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, ...(previous ?? {}) })
          .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { deviceId, p256dh: input.p256dh, auth: input.auth, ...(previous ?? {}) } });
      });
    },

    async removeAll(deviceId) {
      const rows = await db.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, deviceId)).returning({ id: pushSubscriptions.id });
      return rows.length;
    },

    async removeByIds(ids) {
      if (ids.length === 0) return;
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, [...ids]));
    },

    async forMachine(machineId) {
      return db
        .select(columns)
        .from(pairings)
        .innerJoin(devices, eq(devices.id, pairings.deviceId))
        .innerJoin(pushSubscriptions, eq(pushSubscriptions.deviceId, devices.id))
        .where(and(eq(pairings.machineId, machineId), isNull(devices.revokedAt)))
        .limit(MAX_SUBSCRIPTIONS_PER_MACHINE);
    },

    async getPreferences(deviceId) {
      const [row] = await db
        .select({ approvals: pushSubscriptions.notifyApprovals, done: pushSubscriptions.notifyDone })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.deviceId, deviceId))
        .limit(1);
      return row;
    },

    async setPreferences(deviceId, update) {
      const set = { ...(update.approvals !== undefined ? { notifyApprovals: update.approvals } : {}), ...(update.done !== undefined ? { notifyDone: update.done } : {}) };
      if (Object.keys(set).length === 0) return (await this.getPreferences(deviceId)) !== undefined;
      const rows = await db.update(pushSubscriptions).set(set).where(eq(pushSubscriptions.deviceId, deviceId)).returning({ id: pushSubscriptions.id });
      return rows.length > 0;
    },

    async forDevice(deviceId) {
      // HP yang dicabut tidak dikembalikan walau barisnya masih ada (mis. pendaftaran yang menyusul setelah pencabutan).
      return db
        .select(columns)
        .from(pushSubscriptions)
        .innerJoin(devices, eq(devices.id, pushSubscriptions.deviceId))
        .where(and(eq(pushSubscriptions.deviceId, deviceId), isNull(devices.revokedAt)));
    },
  };
}
