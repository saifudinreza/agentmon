// FILE INI: menghitung antrean izin yang masih menunggu dari riwayat event (dipindahkan dari relay ke shared, issue #033).
// Dengan E2E, relay tidak lagi bisa membaca isi event, jadi HP yang menghitungnya sendiri dari event yang sudah diverifikasi dan
// didekripsi. Fungsinya murni dan sama persis untuk relay (event polos, pairing lama) dan HP (event terdekripsi).
import { EventSchema, type Envelope } from "./events";
import type { PendingApproval } from "./commands";

// Permintaan izin yang lebih tua dari ini tidak mungkin masih menunggu (batas waktu bawaan 9 menit), jadi tidak perlu dibaca.
export const APPROVAL_LOOKBACK_MS = 30 * 60 * 1000;

export const APPROVAL_EVENT_TYPES = ["approval.requested", "approval.resolved", "approval.auto_resolved"] as const;

const LEVEL_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Permintaan yang masih menunggu menurut urutan event (berurutan menurut waktu diterima). Yang berisiko tinggi
 * di atas (FR-27), lalu yang paling cepat kedaluwarsa. Event yang bentuknya tidak sah diabaikan.
 */
export function computePendingApprovals(events: readonly Envelope[], now: Date): PendingApproval[] {
  const open = new Map<string, PendingApproval>();
  // Kunci menyertakan sesi: nomor izin hanya dijamin unik per daemon, jadi dua sesi tidak boleh saling menutup.
  const keyOf = (sessionId: string, approvalId: string) => `${sessionId}\u0000${approvalId}`;

  for (const envelope of events) {
    const parsed = EventSchema.safeParse(envelope);
    if (!parsed.success) continue;
    const event = parsed.data;

    if (event.type === "approval.requested") {
      open.set(keyOf(event.sessionId, event.payload.approvalId), {
        machineId: event.machineId,
        sessionId: event.sessionId,
        approvalId: event.payload.approvalId,
        toolName: event.payload.toolName,
        toolInput: event.payload.toolInput,
        ...(event.payload.summary !== undefined ? { summary: event.payload.summary } : {}),
        ...(event.payload.risk !== undefined ? { risk: event.payload.risk } : {}),
        ...(event.payload.diff !== undefined ? { diff: event.payload.diff } : {}),
        ...(event.payload.diffSummary !== undefined ? { diffSummary: event.payload.diffSummary } : {}),
        ...(event.payload.truncated ? { truncated: true } : {}),
        requestedAt: event.ts,
        expiresAt: event.payload.expiresAt,
      });
    } else if (event.type === "approval.resolved" || event.type === "approval.auto_resolved") {
      open.delete(keyOf(event.sessionId, event.payload.approvalId));
    }
  }

  return [...open.values()]
    .filter((approval) => Date.parse(approval.expiresAt) > now.getTime())
    .sort(
      (a, b) =>
        (a.risk ? LEVEL_RANK[a.risk.level] : 1) - (b.risk ? LEVEL_RANK[b.risk.level] : 1) || a.expiresAt.localeCompare(b.expiresAt) || a.approvalId.localeCompare(b.approvalId),
    );
}
