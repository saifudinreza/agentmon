// Status sesi untuk TAMPILAN. Relay hanya tahu "active" atau "ended"; "ended" baru ada bila daemon sempat mengirim rekap
// saat sesi berakhir. Sesi yang berakhir mendadak (laptop mati, daemon ditutup, Claude Code di-kill) tidak pernah
// mengirim rekap, jadi tanpa batas waktu ia akan tampil "Aktif" selamanya. Setelah cukup lama tanpa kabar ia ditampilkan
// "Tidak ada kabar": tidak mengaku selesai (kita tidak tahu), tetapi juga tidak mengaku aktif.
export const IDLE_AFTER_MS = 30 * 60_000;

export type SessionState = "active" | "idle" | "ended";

export function sessionState(summary: { status: "active" | "ended"; lastEventAt: string }, nowMs: number = Date.now()): SessionState {
  if (summary.status === "ended") return "ended";
  const last = Date.parse(summary.lastEventAt);
  // Waktu yang tidak terbaca tidak boleh membuat sesi tampak aktif.
  if (!Number.isFinite(last)) return "idle";
  return nowMs - last > IDLE_AFTER_MS ? "idle" : "active";
}
