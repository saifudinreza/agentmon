// =====================================================================================
// FILE INI: menyimpan dan membaca riwayat event = "PETUGAS ARSIP".
// =====================================================================================
//
// Tugasnya:
//   - saveEvent:      menyimpan satu event (dan membuat/memperbarui sesinya). Event yang dikirim
//                     ulang TIDAK tersimpan dua kali.
//   - listEvents:     mengambil riwayat satu sesi, berurutan, bisa dilanjutkan dari nomor tertentu.
//   - listSessions:   daftar sesi sebuah laptop, yang terbaru di atas.
//   - purge:          menghapus riwayat yang sudah lewat masa simpan.
//   - startRetention: menjalankan penghapusan itu secara berkala.
//
// Yang disimpan adalah AMPLOP event apa adanya. `payload` sampai tahap 3 berupa objek, sejak
// tahap 4 berupa teks terenkripsi; relay tidak membukanya, dan kolom jsonb menerima keduanya.
import type { Agent, Envelope } from "@agentmon/shared";
import { and, asc, desc, eq, gt, gte, inArray, lt, isNotNull, or, sql } from "drizzle-orm";
import type { Logger } from "../logger";
import { silentLogger } from "../logger";
import type { Database } from "./connect";
import { events, pairingCodes, sessions } from "./schema";

// Riwayat dihapus otomatis setelah 30 hari (PRD §12).
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // dicek tiap 6 jam

// Batas jumlah event dalam satu pengambilan riwayat, supaya satu permintaan tidak menarik jutaan baris.
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

// Banyak baris yang dihapus per pernyataan saat penghapusan otomatis.
export const DEFAULT_PURGE_BATCH = 5000;

// Bilangan bulat dari nilai yang mungkin bukan angka sah. Selain angka berhingga, dipakai nilai bawaan.
function finiteInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
}

// Jumlah baris hasil `db.execute`. Bentuk hasilnya sedikit berbeda antar driver, tetapi semuanya punya `rows`.
function rowCount(result: unknown): number {
  return (result as { rows: unknown[] }).rows.length;
}

// Menjalankan penghapusan potongan demi potongan sampai tidak ada lagi. Mengembalikan jumlah totalnya.
async function deleteInBatches(batch: number, deleteOne: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await deleteOne();
    total += removed;
    if (removed < batch) return total;
  }
}

// Baris database menjadi amplop event. Isi disimpan sebagai teks JSON (lihat schema.ts).
function toEnvelope(row: typeof events.$inferSelect): Envelope {
  return {
    v: 1,
    id: row.id,
    machineId: row.machineId,
    sessionId: row.sessionId,
    seq: row.seq,
    ts: row.ts.toISOString(),
    agent: row.agent as Agent,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    ...(row.approvalId !== null ? { approvalId: row.approvalId } : {}),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt.toISOString() } : {}),
  };
}

export type StoredSession = {
  sessionId: string;
  agent: Agent;
  status: "active" | "ended";
  startedAt: string;
  lastEventAt: string;
  endedAt: string | null;
};

export type PurgeResult = { events: number; sessions: number; pairingCodes: number };

export type Store = ReturnType<typeof createStore>;

export function createStore(db: Database, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  return {
    /**
     * Menyimpan satu event. Mengembalikan `inserted: false` bila event itu SUDAH ADA (dikirim ulang),
     * dan dalam kasus itu tidak ada yang berubah. Event yang sama dari laptop berbeda dianggap
     * event berbeda: yang unik adalah pasangan (laptop, nomor event).
     */
    async saveEvent(event: Envelope): Promise<{ inserted: boolean }> {
      const ts = new Date(event.ts);
      return db.transaction(async (tx) => {
        // Sesi dibuat bila belum ada. Waktu mulainya hanya boleh mundur dan waktu terakhirnya hanya
        // boleh maju, walau event datang tidak berurutan.
        await tx
          .insert(sessions)
          .values({ machineId: event.machineId, sessionId: event.sessionId, agent: event.agent, startedAt: ts, lastEventAt: ts })
          .onConflictDoUpdate({
            target: [sessions.machineId, sessions.sessionId],
            set: {
              startedAt: sql`least(${sessions.startedAt}, excluded.started_at)`,
              lastEventAt: sql`greatest(${sessions.lastEventAt}, excluded.last_event_at)`,
            },
          });

        // ON CONFLICT DO NOTHING: bila event sudah ada, tidak ada baris yang dikembalikan.
        const stored = await tx
          .insert(events)
          .values({
            machineId: event.machineId,
            id: event.id,
            sessionId: event.sessionId,
            seq: event.seq,
            ts,
            agent: event.agent,
            type: event.type,
            // Disimpan sebagai teks JSON. Amplop tanpa isi menjadi "null".
            payload: JSON.stringify(event.payload ?? null),
            approvalId: event.approvalId ?? null,
            expiresAt: event.expiresAt !== undefined ? new Date(event.expiresAt) : null,
            receivedAt: now(),
          })
          .onConflictDoNothing()
          .returning({ id: events.id });

        // Rekap sesi menandai sesinya selesai.
        if (stored.length > 0 && event.type === "session.recap") {
          await tx
            .update(sessions)
            .set({ status: "ended", endedAt: ts })
            .where(and(eq(sessions.machineId, event.machineId), eq(sessions.sessionId, event.sessionId)));
        }
        return { inserted: stored.length > 0 };
      });
    },

    /**
     * Riwayat satu sesi, berurutan menurut nomor urut. `afterSeq` melanjutkan dari event setelah
     * nomor itu (untuk HP yang menyambung ulang dan hanya butuh yang terlewat).
     */
    async listEvents(query: { machineId: string; sessionId: string; afterSeq?: number; limit?: number }): Promise<Envelope[]> {
      // Nilai yang bukan angka berhingga (NaN, Infinity) memakai nilai bawaan, bukan diteruskan ke SQL
      // yang akan menolaknya. Nilainya nanti datang dari parameter permintaan HP.
      const limit = Math.min(Math.max(1, finiteInt(query.limit, DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
      const rows = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.machineId, query.machineId),
            eq(events.sessionId, query.sessionId),
            gt(events.seq, finiteInt(query.afterSeq, -1)),
          ),
        )
        .orderBy(asc(events.seq), asc(events.receivedAt))
        .limit(limit);

      return rows.map(toEnvelope);
    },

    /**
     * Event dari jenis tertentu yang DITERIMA relay sejak `since`, berurutan menurut waktu diterima. Dipakai untuk
     * menghitung antrean izin yang menunggu (approvals.ts). Dibatasi supaya tidak menarik ribuan baris.
     */
    async listRecentByType(machineId: string, types: readonly string[], since: Date, limit = 2000): Promise<Envelope[]> {
      if (types.length === 0) return [];
      const rows = await db
        .select()
        .from(events)
        .where(and(eq(events.machineId, machineId), inArray(events.type, [...types]), gte(events.receivedAt, since)))
        .orderBy(desc(events.receivedAt), desc(events.seq))
        .limit(Math.min(Math.max(1, finiteInt(limit, 2000)), 5000));
      // Bila batas tercapai, yang terpotong adalah yang paling LAMA; urutan dikembalikan menaik.
      return rows.reverse().map(toEnvelope);
    },

    /** Sesi sebuah laptop, dari yang paling baru aktif. */
    async listSessions(machineId: string, options: { limit?: number } = {}): Promise<StoredSession[]> {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.machineId, machineId))
        .orderBy(desc(sessions.lastEventAt))
        .limit(Math.min(Math.max(1, finiteInt(options.limit, 50)), MAX_PAGE_SIZE));
      return rows.map((row) => ({
        sessionId: row.sessionId,
        agent: row.agent as Agent,
        status: row.status as "active" | "ended",
        startedAt: row.startedAt.toISOString(),
        lastEventAt: row.lastEventAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
      }));
    },

    /**
     * Menghapus yang sudah lewat masa simpan:
     *   - event yang DITERIMA relay sebelum `olderThan` (jam relay, bukan jam pengirim yang bisa
     *     keliru atau dipalsukan);
     *   - sesi yang sudah tidak punya event lagi;
     *   - kode pairing yang sudah dipakai atau kedaluwarsa (tidak berguna lagi).
     */
    async purge(purgeOptions: { olderThan: Date; batchSize?: number }): Promise<PurgeResult> {
      const batch = Math.max(1, finiteInt(purgeOptions.batchSize, DEFAULT_PURGE_BATCH));

      // Dihapus BERTAHAP, bukan dalam satu pernyataan raksasa: setelah berbulan-bulan, jumlah event
      // yang lewat masa simpan bisa jutaan. Satu DELETE sebesar itu menahan kunci lama, membengkakkan
      // log transaksi, dan bisa melewati batas waktu pernyataan, padahal relay harus tetap menulis
      // event baru. Tiap potongan adalah pernyataan sendiri yang pendek.
      const removedEvents = await deleteInBatches(batch, async () => {
        const rows = await db.execute(sql`
          delete from events
          where (machine_id, id) in (
            select machine_id, id from events where received_at < ${purgeOptions.olderThan} limit ${batch}
          )
          returning 1`);
        return rowCount(rows);
      });

      // Sesi yang sudah kosong. `for update skip locked` melewati sesi yang sedang dipakai saveEvent
      // yang berjalan bersamaan, supaya event yang BARU tiba untuk sesi lama tidak ikut terhapus
      // (kunci asing berantai akan menghapusnya bersama sesinya).
      const removedSessions = await deleteInBatches(batch, async () => {
        const rows = await db.execute(sql`
          delete from sessions
          where (machine_id, session_id) in (
            select s.machine_id, s.session_id from sessions s
            where not exists (select 1 from events e where e.machine_id = s.machine_id and e.session_id = s.session_id)
            limit ${batch}
            for update of s skip locked
          )
          returning 1`);
        return rowCount(rows);
      });

      // Kode pairing biasanya sedikit, jadi satu pernyataan cukup.
      const removedCodes = await db
        .delete(pairingCodes)
        .where(or(isNotNull(pairingCodes.usedAt), lt(pairingCodes.expiresAt, now())))
        .returning({ id: pairingCodes.codeHash });

      return { events: removedEvents, sessions: removedSessions, pairingCodes: removedCodes.length };
    },
  };
}

export type RetentionOptions = {
  store: Store;
  retentionDays?: number;
  intervalMs?: number;
  now?: () => Date;
  logger?: Logger;
};

/**
 * Menjalankan penghapusan otomatis: sekali segera, lalu berkala. Kegagalan hanya dicatat dan tidak
 * menghentikan jadwalnya. Mengembalikan fungsi untuk menghentikannya.
 */
export function startRetention(options: RetentionOptions): { stop(): void; runNow(): Promise<PurgeResult | undefined> } {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const runOnce = async (): Promise<PurgeResult | undefined> => {
    try {
      const olderThan = new Date(now().getTime() - days * 24 * 60 * 60 * 1000);
      const result = await options.store.purge({ olderThan });
      logger.info(`retensi: ${result.events} event, ${result.sessions} sesi, ${result.pairingCodes} kode pairing dihapus`);
      return result;
    } catch (error) {
      logger.error(`retensi gagal: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  // Penjaga tumpang tindih: bila putaran sebelumnya belum selesai (jadwal berikutnya tiba, atau ada
  // yang memanggil runNow), putaran baru TIDAK dimulai. Pemanggil mendapat hasil putaran yang sedang
  // berjalan. Dua penghapusan besar yang berjalan serentak hanya saling berebut baris.
  let running: Promise<PurgeResult | undefined> | undefined;
  const runNow = (): Promise<PurgeResult | undefined> => {
    running ??= runOnce().finally(() => {
      running = undefined;
    });
    return running;
  };

  void runNow();
  const timer = setInterval(() => void runNow(), options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), runNow };
}
