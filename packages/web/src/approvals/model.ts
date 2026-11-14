// =====================================================================================
// FILE INI: model antrean izin di HP = "BUKU ANTREAN" yang diperbarui dari event dan riwayat.
// =====================================================================================
//
// Antrean izin yang menunggu datang dari dua jalur: dibaca dari relay (HP baru dibuka atau baru tersambung) dan
// event langsung (`approval.requested` menambah, `approval.resolved` dan `approval.auto_resolved` mengurangi).
// Fungsi-fungsi di sini murni (tanpa jaringan dan tanpa waktu sungguhan) supaya mudah diuji.
import { EventSchema, type Envelope, type FinalApprovalStatus, type PendingApproval } from "@agentmon/shared";

/** Kunci antrean: nomor izin hanya dijamin unik per laptop. */
export const approvalKey = (machineId: string, approvalId: string) => `${machineId}/${approvalId}`;

/** Hasil akhir sebuah izin yang sudah selesai: keputusan manusia, atau otomatis oleh aturan. */
export type Resolution = FinalApprovalStatus | "auto_approved" | "auto_denied";

/** Permintaan izin dari sebuah event `approval.requested`; undefined bila event itu bukan jenis tersebut atau rusak. */
export function approvalFromEvent(envelope: Envelope): PendingApproval | undefined {
  const parsed = EventSchema.safeParse(envelope);
  if (!parsed.success || parsed.data.type !== "approval.requested") return undefined;
  const event = parsed.data;
  return {
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
  };
}

/** Penyelesaian sebuah izin dari event `approval.resolved` atau `approval.auto_resolved`. */
export function resolutionFromEvent(envelope: Envelope): { machineId: string; approvalId: string; status: Resolution } | undefined {
  const parsed = EventSchema.safeParse(envelope);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  if (event.type === "approval.resolved" || event.type === "approval.auto_resolved") {
    return { machineId: event.machineId, approvalId: event.payload.approvalId, status: event.payload.status };
  }
  return undefined;
}

const LEVEL_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Urutan tampil: berisiko tinggi di atas (FR-27), lalu yang paling cepat kedaluwarsa. */
export function sortApprovals(approvals: readonly PendingApproval[]): PendingApproval[] {
  return [...approvals].sort(
    (a, b) =>
      (a.risk ? LEVEL_RANK[a.risk.level] : 1) - (b.risk ? LEVEL_RANK[b.risk.level] : 1) ||
      a.expiresAt.localeCompare(b.expiresAt) ||
      a.approvalId.localeCompare(b.approvalId),
  );
}

/**
 * Menyatukan daftar dari relay dengan yang diterima langsung selagi pengambilan berjalan. Yang sudah diketahui
 * selesai (`resolved`) dibuang walau relay masih menyebutnya (relay bisa sedikit tertinggal), dan yang sama tidak ganda.
 */
export function mergeApprovals(
  fetched: readonly PendingApproval[],
  local: readonly PendingApproval[],
  resolved: Readonly<Record<string, unknown>>,
): PendingApproval[] {
  const byKey = new Map<string, PendingApproval>();
  for (const approval of [...fetched, ...local]) {
    const key = approvalKey(approval.machineId, approval.approvalId);
    if (key in resolved) continue;
    byKey.set(key, approval);
  }
  return sortApprovals([...byKey.values()]);
}

/** Sisa waktu dalam milidetik (tidak negatif). */
export function remainingMs(approval: Pick<PendingApproval, "expiresAt">, nowMs: number): number {
  const expires = Date.parse(approval.expiresAt);
  return Number.isNaN(expires) ? 0 : Math.max(0, expires - nowMs);
}

export const isExpired = (approval: Pick<PendingApproval, "expiresAt">, nowMs: number) => remainingMs(approval, nowMs) <= 0;

/** "8:42" atau "0:07". */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
