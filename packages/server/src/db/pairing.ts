// =====================================================================================
// FILE INI: layanan pairing = "LOKET PENUKARAN KUNCI SEMENTARA".
// =====================================================================================
//
// Alurnya:
//   1. Laptop minta kode  -> createCode()  : relay mencatat HASH kode itu dan batas waktunya.
//   2. HP memindai QR     -> redeem()      : kode ditukar dengan kredensial tetap untuk HP itu.
//   3. Laptop melihat siapa yang baru terpasang -> listDevices().
//
// ANALOGI: laptop mencetak tiket sekali pakai di loket. Petugas hanya menyimpan CAP tiket (hash),
// bukan tiketnya, jadi bila catatan petugas bocor tidak ada tiket yang bisa dipakai. Tiket yang
// sudah dipakai atau lewat waktu ditolak, dan petugas menjawab "tiket tidak berlaku" untuk SEMUA
// penyebab itu, supaya penebak tidak bisa membedakan "pernah ada" dari "tidak pernah ada".
//
// ATOMIK: "tandai terpakai" adalah SATU pernyataan UPDATE ... WHERE belum terpakai AND belum
// kedaluwarsa. Bila dua HP menukar kode yang sama persis bersamaan, database hanya meluluskan
// satu. Tidak ada celah antara "periksa" dan "tandai".
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, min, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { hashToken } from "../directory";
import type { Database } from "./connect";
import type { E2eMessage, E2eMessageKind, E2ePairingMaterial } from "@agentmon/shared";
import { deviceE2e, devices, e2eMessages, machines, pairingCodes, pairings, pushSubscriptions } from "./schema";

export const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000; // kode berlaku 5 menit
export const DEFAULT_MAX_ACTIVE_CODES = 5; // kode yang belum terpakai per laptop
/** Pesan laptop ke HP yang boleh menumpuk per HP (kotak surat). Lebih dari ini ditolak, supaya laptop yang salah tidak memenuhi database. */
export const MAX_E2E_MESSAGES_PER_DEVICE = 200;
export const MAX_E2E_MESSAGES_PER_READ = 100;

export type CreateCodeResult =
  | { ok: true; code: string; expiresAt: Date }
  // Laptop sudah punya terlalu banyak kode yang masih berlaku. Menunggu salah satunya kedaluwarsa.
  | { ok: false; reason: "too-many-codes" | "unknown-machine" };

export type RedeemInput = {
  code: string;
  name: string;
  /** Token HP yang SUDAH terdaftar (HP yang memasangkan laptop kedua). Tanpa ini dibuat perangkat baru. */
  existingDeviceToken?: string;
  /** Bahan pairing E2E dari HP (kunci publik dan bukti). Hanya disimpan; relay tidak memercayainya. */
  e2e?: E2ePairingMaterial;
};

export type RedeemResult =
  | { ok: true; deviceId: string; machineId: string; machineName: string; deviceToken?: string }
  // `invalid-code` mencakup: tidak dikenal, sudah terpakai, dan kedaluwarsa (sengaja tidak dibedakan).
  | { ok: false; reason: "invalid-code" | "invalid-device" };

export type PairingService = ReturnType<typeof createPairingService>;

export type PairingOptions = {
  now?: () => Date;
  codeTtlMs?: number;
  maxActiveCodes?: number;
};

export function createPairingService(db: Database, options: PairingOptions = {}) {
  const now = options.now ?? (() => new Date());
  const ttl = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
  const maxActive = options.maxActiveCodes ?? DEFAULT_MAX_ACTIVE_CODES;

  return {
    /** Membuat kode sekali pakai untuk sebuah laptop. Kode mentah hanya dikembalikan di sini, tidak disimpan. */
    async createCode(machineId: string): Promise<CreateCodeResult> {
      return db.transaction(async (tx) => {
        // Mengunci baris laptop: dua permintaan kode bersamaan dari laptop yang sama dijalankan
        // bergantian, jadi batas jumlah kode tidak bisa dilampaui lewat balapan.
        const [machine] = await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, machineId)).for("update");
        if (!machine) return { ok: false, reason: "unknown-machine" };

        const current = now();
        const [counted] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(pairingCodes)
          .where(and(eq(pairingCodes.machineId, machineId), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, current)));
        if ((counted?.n ?? 0) >= maxActive) return { ok: false, reason: "too-many-codes" };

        // 24 byte acak = 192 bit; tidak mungkin ditebak. base64url aman dipakai di alamat web.
        const code = randomBytes(24).toString("base64url");
        const expiresAt = new Date(current.getTime() + ttl);
        await tx.insert(pairingCodes).values({ codeHash: hashToken(code), machineId, expiresAt });
        return { ok: true, code, expiresAt };
      });
    },

    /** Menukar kode dengan kredensial. Semua langkah dalam satu transaksi: gagal di tengah = tidak ada yang berubah. */
    async redeem(input: RedeemInput): Promise<RedeemResult> {
      return db.transaction(async (tx) => {
        // HP lama diperiksa DULU, sebelum kode dihabiskan: token HP yang salah tidak boleh
        // menghanguskan kode milik laptop.
        let existingId: string | undefined;
        if (input.existingDeviceToken !== undefined) {
          const [device] = await tx
            .select({ id: devices.id })
            .from(devices)
            .where(and(eq(devices.tokenHash, hashToken(input.existingDeviceToken)), isNull(devices.revokedAt)))
            .limit(1);
          if (!device) return { ok: false, reason: "invalid-device" };
          existingId = device.id;
        }

        const current = now();
        const [used] = await tx
          .update(pairingCodes)
          .set({ usedAt: current })
          .where(and(eq(pairingCodes.codeHash, hashToken(input.code)), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, current)))
          .returning({ machineId: pairingCodes.machineId });
        if (!used) return { ok: false, reason: "invalid-code" };

        const [machine] = await tx.select({ name: machines.name }).from(machines).where(eq(machines.id, used.machineId)).limit(1);

        let deviceId = existingId;
        let deviceToken: string | undefined;
        if (deviceId === undefined) {
          deviceId = randomUUID();
          deviceToken = randomBytes(32).toString("hex");
          await tx.insert(devices).values({ id: deviceId, name: input.name, tokenHash: hashToken(deviceToken) });
        }
        // Memasangkan dua kali tidak menggandakan dan tidak error.
        await tx.insert(pairings).values({ machineId: used.machineId, deviceId, createdAt: current }).onConflictDoNothing();
        if (input.e2e) {
          // Satu baris per (laptop, HP). Memasangkan ulang menimpa bahan lama (kunci HP bisa berganti setelah HP dipasang ulang).
          await tx
            .insert(deviceE2e)
            .values({ machineId: used.machineId, deviceId, kxPublicKey: input.e2e.kx, signPublicKey: input.e2e.sign, proof: input.e2e.proof, createdAt: current })
            .onConflictDoUpdate({ target: [deviceE2e.machineId, deviceE2e.deviceId], set: { kxPublicKey: input.e2e.kx, signPublicKey: input.e2e.sign, proof: input.e2e.proof, createdAt: current } });
        }

        return {
          ok: true,
          deviceId,
          machineId: used.machineId,
          machineName: machine?.name ?? "",
          ...(deviceToken !== undefined ? { deviceToken } : {}),
        };
      });
    },

    /**
     * Perangkat (yang belum dicabut) yang berbagi laptop dengan HP ini, termasuk HP itu sendiri, dari yang paling lama
     * terpasang. HP hanya melihat sesamanya yang memegang laptop yang sama, tidak pernah seluruh isi relay.
     */
    async listPeerDevices(deviceId: string): Promise<Array<{ id: string; name: string; pairedAt: string }>> {
      const mine = db.select({ machineId: pairings.machineId }).from(pairings).where(eq(pairings.deviceId, deviceId));
      const pairedAt = min(pairings.createdAt);
      const rows = await db
        .select({ id: devices.id, name: devices.name, pairedAt })
        .from(pairings)
        .innerJoin(devices, eq(devices.id, pairings.deviceId))
        .where(and(inArray(pairings.machineId, mine), isNull(devices.revokedAt)))
        .groupBy(devices.id, devices.name)
        .orderBy(asc(pairedAt), asc(devices.id));
      return rows.map((row) => ({ id: row.id, name: row.name, pairedAt: (row.pairedAt ?? new Date(0)).toISOString() }));
    },

    /**
     * Laptop mencabut DIRINYA SENDIRI dari relay (uninstall): barisnya dihapus, dan basis data menghapus turunannya (pasangan dengan HP,
     * sesi, event, dan kode pairing yang belum terpakai) karena kunci asingnya bertipe cascade. HP yang tadinya dipasangkan hanya
     * kehilangan hubungannya; perangkatnya sendiri tidak dihapus (bisa dipasangkan ke laptop lain). `false` bila laptopnya sudah tidak ada.
     */
    async forgetMachine(machineId: string): Promise<boolean> {
      const rows = await db.delete(machines).where(eq(machines.id, machineId)).returning({ id: machines.id });
      return rows.length > 0;
    },

    /**
     * Mencabut sebuah perangkat. Pencabut harus punya hubungan dengannya: laptop yang dipasangkan dengan perangkat itu,
     * atau HP yang berbagi laptop dengannya (termasuk dirinya sendiri). Selain itu ditolak (false), dan jawabannya sama
     * untuk "tidak ada" dan "bukan urusanmu", supaya nomor perangkat tidak bisa dicari tahu. Mencabut dua kali aman.
     */
    async revokeDevice(actor: { machineId: string } | { deviceId: string }, targetId: string): Promise<boolean> {
      let related: boolean;
      if ("machineId" in actor) {
        const rows = await db
          .select({ id: pairings.deviceId })
          .from(pairings)
          .where(and(eq(pairings.machineId, actor.machineId), eq(pairings.deviceId, targetId)))
          .limit(1);
        related = rows.length > 0;
      } else {
        const theirs = alias(pairings, "theirs");
        const rows = await db
          .select({ id: pairings.deviceId })
          .from(pairings)
          .innerJoin(theirs, eq(theirs.machineId, pairings.machineId))
          .where(and(eq(pairings.deviceId, actor.deviceId), eq(theirs.deviceId, targetId)))
          .limit(1);
        related = rows.length > 0;
      }
      if (!related) return false;
      await db.update(devices).set({ revokedAt: now() }).where(and(eq(devices.id, targetId), isNull(devices.revokedAt)));
      // HP yang dicabut tidak boleh lagi menerima notifikasi, dan alamat notifikasinya tidak perlu disimpan.
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, targetId));
      return true;
    },

    /** HP yang terpasang dengan sebuah laptop (yang belum dicabut), dari yang paling lama. */
    async listDevices(machineId: string): Promise<Array<{ id: string; name: string; pairedAt: string; e2e?: E2ePairingMaterial }>> {
      const rows = await db
        .select({ id: devices.id, name: devices.name, pairedAt: pairings.createdAt, kx: deviceE2e.kxPublicKey, sign: deviceE2e.signPublicKey, proof: deviceE2e.proof })
        .from(pairings)
        .innerJoin(devices, eq(devices.id, pairings.deviceId))
        .leftJoin(deviceE2e, and(eq(deviceE2e.machineId, pairings.machineId), eq(deviceE2e.deviceId, pairings.deviceId)))
        .where(and(eq(pairings.machineId, machineId), isNull(devices.revokedAt)))
        .orderBy(asc(pairings.createdAt), asc(devices.id));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        pairedAt: row.pairedAt.toISOString(),
        ...(row.kx !== null && row.sign !== null && row.proof !== null ? { e2e: { kx: row.kx, sign: row.sign, proof: row.proof } } : {}),
      }));
    },

    /**
     * Laptop menitipkan pesan untuk satu HP-nya (tantangan, jawaban pairing, kunci baru). `false` bila HP itu tidak dipasangkan dengan
     * laptop ini, sudah dicabut, atau kotak suratnya penuh. Isinya tidak dibaca di sini.
     */
    async postE2eMessage(machineId: string, deviceId: string, kind: E2eMessageKind, body: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [paired] = await tx
          .select({ id: pairings.deviceId })
          .from(pairings)
          .innerJoin(devices, eq(devices.id, pairings.deviceId))
          .where(and(eq(pairings.machineId, machineId), eq(pairings.deviceId, deviceId), isNull(devices.revokedAt)))
          .limit(1)
          .for("update");
        if (!paired) return false;
        const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(e2eMessages).where(and(eq(e2eMessages.machineId, machineId), eq(e2eMessages.deviceId, deviceId)));
        if ((counted?.n ?? 0) >= MAX_E2E_MESSAGES_PER_DEVICE) return false;
        await tx.insert(e2eMessages).values({ machineId, deviceId, kind, body });
        return true;
      });
    },

    /** Pesan untuk HP ini dari satu laptop, yang lebih baru dari `afterId`. Kosong bila HP tidak dipasangkan dengan laptop itu. */
    async listE2eMessages(deviceId: string, machineId: string, afterId: number): Promise<E2eMessage[]> {
      const rows = await db
        .select({ id: e2eMessages.id, kind: e2eMessages.kind, body: e2eMessages.body })
        .from(e2eMessages)
        .innerJoin(pairings, and(eq(pairings.machineId, e2eMessages.machineId), eq(pairings.deviceId, e2eMessages.deviceId)))
        .where(and(eq(e2eMessages.deviceId, deviceId), eq(e2eMessages.machineId, machineId), sql`${e2eMessages.id} > ${afterId}`))
        .orderBy(asc(e2eMessages.id))
        .limit(MAX_E2E_MESSAGES_PER_READ);
      const out: E2eMessage[] = [];
      for (const row of rows) {
        try {
          const body: unknown = JSON.parse(row.body);
          if (typeof body === "object" && body !== null && !Array.isArray(body)) out.push({ id: row.id, kind: row.kind as E2eMessageKind, body: body as Record<string, unknown> });
        } catch {
          // baris rusak dilewati
        }
      }
      return out;
    },
  };
}
