// =====================================================================================
// FILE INI: pelacak "apakah agent masih berjalan di sesi ini?" = lampu merah untuk rollback.
// =====================================================================================
//
// Daemon tidak punya sinyal langsung "agent sedang bekerja", jadi dibaca dari event terakhir sesi itu:
//   - agent.stopped / session.recap  -> agent selesai (diam).
//   - checkpoint.restored            -> hanya catatan rollback, tidak mengubah keadaan.
//   - event lain (alat, izin, notifikasi, sesi mulai)  -> agent sedang bekerja atau menunggu.
// Sesi yang tidak ada kabar lebih lama dari batas (agent mati mendadak tanpa Stop) dianggap diam, supaya
// rollback tidak terkunci selamanya.
const MAX_SESSIONS = 1000;
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

const IDLE_TYPES = new Set(["agent.stopped", "session.recap"]);

export function createSessionActivity(options: { now?: () => number; staleMs?: number } = {}) {
  const now = options.now ?? (() => Date.now());
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  // sesi -> { berjalan?, kapan }. Map mengingat urutan masuk: yang pertama adalah yang paling lama dipakai.
  const sessions = new Map<string, { running: boolean; at: number }>();

  const record = (event: { sessionId: string; type: string }): void => {
    if (event.type === "checkpoint.restored") return;
    sessions.delete(event.sessionId);
    sessions.set(event.sessionId, { running: !IDLE_TYPES.has(event.type), at: now() });
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  };

  return {
    /** Mencatat satu event (semua event, termasuk yang dibuat daemon sendiri). */
    record,
    /** Menandai sesi sedang bekerja tanpa event (mis. pengguna baru mengirim perintah ke agent). */
    touch(sessionId: string): void {
      record({ sessionId, type: "touch" });
    },
    /** Apakah agent diperkirakan masih berjalan di sesi ini? Sesi yang tidak dikenal dianggap diam. */
    isRunning(sessionId: string): boolean {
      const entry = sessions.get(sessionId);
      return entry !== undefined && entry.running && now() - entry.at < staleMs;
    },
  };
}

export type SessionActivity = ReturnType<typeof createSessionActivity>;
