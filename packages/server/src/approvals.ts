// Dipindahkan ke shared supaya HP (yang menghitung dari event terdekripsi) dan relay (event polos) memakai kode yang sama.
export { APPROVAL_EVENT_TYPES, APPROVAL_LOOKBACK_MS, computePendingApprovals } from "@agentmon/shared";

import { computePendingApprovals, type Envelope } from "@agentmon/shared";

/** Izin yang menunggu menurut AMPLOP saja (tanpa membaca isi): cukup untuk menghitung dan memberi notifikasi. */
export type WaitingApproval = { sessionId: string; approvalId: string; expiresAt: string };

/**
 * Izin yang masih menunggu, dihitung dari AMPLOP event izin (nomor acak dan tenggat di amplop, yang tidak rahasia). Dengan E2E relay tidak
 * bisa membaca isi event, tetapi amplop cukup untuk tahu berapa izin yang menunggu. Event lama (laptop tanpa E2E) yang amplopnya belum
 * memuat nomor izin dihitung dari isinya seperti dulu. Isi event TIDAK pernah dibaca untuk event yang amplopnya membawa nomor izin.
 */
export function waitingApprovals(events: readonly Envelope[], now: Date): WaitingApproval[] {
  const key = (sessionId: string, approvalId: string) => `${sessionId}\u0000${approvalId}`;
  const open = new Map<string, WaitingApproval>();
  const legacy: Envelope[] = [];
  for (const event of events) {
    if (event.approvalId === undefined) {
      legacy.push(event);
      continue;
    }
    if (event.type === "approval.requested") {
      if (event.expiresAt !== undefined) open.set(key(event.sessionId, event.approvalId), { sessionId: event.sessionId, approvalId: event.approvalId, expiresAt: event.expiresAt });
    } else if (event.type === "approval.resolved" || event.type === "approval.auto_resolved") {
      open.delete(key(event.sessionId, event.approvalId));
    }
  }
  for (const approval of computePendingApprovals(legacy, now)) open.set(key(approval.sessionId, approval.approvalId), { sessionId: approval.sessionId, approvalId: approval.approvalId, expiresAt: approval.expiresAt });
  return [...open.values()].filter((approval) => Date.parse(approval.expiresAt) > now.getTime());
}
