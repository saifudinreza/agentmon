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
import { and, asc, desc, eq, gt, lt, isNotNull, notExists, or, sql } from "drizzle-orm";
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
      const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
      const rows = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.machineId, query.machineId),
            eq(events.sessionId, query.sessionId),
            gt(events.seq, query.afterSeq ?? -1),
          ),
        )
        .orderBy(asc(events.seq), asc(events.receivedAt))
        .limit(limit);

      return rows.map(
        (row): Envelope => ({
          v: 1,
          id: row.id,
          machineId: row.machineId,
          sessionId: row.sessionId,
          seq: row.seq,
          ts: row.ts.toISOString(),
          agent: row.agent as Agent,
          type: row.type,
          payload: JSON.parse(row.payload) as unknown,
        }),
      );
    },

    /** Sesi sebuah laptop, dari yang paling baru aktif. */
    async listSessions(machineId: string, options: { limit?: number } = {}): Promise<StoredSession[]> {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.machineId, machineId))
        .orderBy(desc(sessions.lastEventAt))
        .limit(Math.min(Math.max(1, Math.floor(options.limit ?? 50)), MAX_PAGE_SIZE));
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
    async purge(purgeOptions: { olderThan: Date }): Promise<PurgeResult> {
      return db.transaction(async (tx) => {
        const removedEvents = await tx.delete(events).where(lt(events.receivedAt, purgeOptions.olderThan)).returning({ id: events.id });
        const removedSessions = await tx
          .delete(sessions)
          .where(
            notExists(
              tx
                .select({ one: sql`1` })
                .from(events)
                .where(and(eq(events.machineId, sessions.machineId), eq(events.sessionId, sessions.sessionId))),
            ),
          )
          .returning({ id: sessions.sessionId });
        const removedCodes = await tx
          .delete(pairingCodes)
          .where(or(isNotNull(pairingCodes.usedAt), lt(pairingCodes.expiresAt, now())))
          .returning({ id: pairingCodes.codeHash });
        return { events: removedEvents.length, sessions: removedSessions.length, pairingCodes: removedCodes.length };
      });
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

  const runNow = async (): Promise<PurgeResult | undefined> => {
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

  void runNow();
  const timer = setInterval(() => void runNow(), options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), runNow };
}
