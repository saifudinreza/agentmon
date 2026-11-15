// =====================================================================================
// FILE INI: pembersih notifikasi usang = "PETUGAS KEBERSIHAN" yang menyingkirkan pengumuman yang sudah tidak berlaku.
// =====================================================================================
//
// Relay tidak bisa menghapus notifikasi dari jauh: iOS mewajibkan SETIAP push menampilkan notifikasi, sehingga push
// "senyap" untuk menghapus justru membuat notifikasi baru di tiap keputusan (dan bisa membuat Apple mencabut langganan).
// Jadi notifikasi izin dibersihkan di sini, saat aplikasi dibuka dan antrean izin dari relay sudah dimuat: yang sesinya
// tidak lagi punya izin menunggu (diputuskan di perangkat lain, atau kedaluwarsa) ditutup. Yang tidak sempat dibersihkan
// kedaluwarsa sendiri (TTL push), dan bila diketuk, layar keputusan menyebut bahwa izinnya sudah diputuskan.
import { useEffect } from "react";
import type { RelayEntry } from "../relay/RelayProvider";
import { useRelayState } from "../relay/RelayProvider";
import { approvalTag } from "./notification";

export type NotificationLike = { tag: string; close(): void };

/**
 * Menutup notifikasi izin yang sesinya tidak punya izin menunggu. Mengembalikan berapa yang ditutup. Hanya menyentuh
 * notifikasi izin (`approval:`); "agent selesai" dan lainnya dibiarkan. Gagal membaca daftar berarti tidak menutup apa pun.
 */
export async function closeStaleApprovalNotifications(
  registration: { getNotifications(): Promise<NotificationLike[]> } | undefined,
  pending: ReadonlyArray<{ machineId: string; sessionId: string }>,
): Promise<number> {
  if (!registration) return 0;
  const keep = new Set(pending.map((approval) => approvalTag(approval.machineId, approval.sessionId)));
  let shown: NotificationLike[];
  try {
    shown = await registration.getNotifications();
  } catch {
    return 0;
  }
  let closed = 0;
  for (const notification of shown) {
    if (notification.tag.startsWith("approval:") && !keep.has(notification.tag)) {
      notification.close();
      closed += 1;
    }
  }
  return closed;
}

/**
 * Tidak menampilkan apa pun. Menjalankan pembersihan setiap kali antrean izin berubah, dan HANYA setelah antrean dimuat dari
 * relay: antrean yang belum dimuat kosong, dan kosong bukan berarti tidak ada yang menunggu.
 */
export function StaleNotificationCleaner({ entry }: { entry: RelayEntry }) {
  const state = useRelayState(entry.store);
  useEffect(() => {
    if (!state.approvalsLoaded) return;
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) return;
    void container
      .getRegistration()
      .then((registration) => closeStaleApprovalNotifications(registration, state.approvals))
      .catch(() => undefined);
  }, [state.approvalsLoaded, state.approvals]);
  return null;
}
