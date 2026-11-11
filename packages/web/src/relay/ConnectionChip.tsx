import { useSyncExternalStore } from "react";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/id";
import type { ConnectionStatus } from "./connection";
import { useRelayEntries, type RelayEntry } from "./RelayProvider";

// Gabungan status semua relay: yang paling "buruk" menentukan (dicabut, lalu terputus, lalu menyambung).
const PRIORITY: ConnectionStatus[] = ["revoked", "offline", "connecting", "online"];

export function aggregateStatus(statuses: ConnectionStatus[]): ConnectionStatus | undefined {
  return PRIORITY.find((status) => statuses.includes(status));
}

function useAggregateStatus(entries: RelayEntry[]): ConnectionStatus | undefined {
  return useSyncExternalStore(
    (notify) => {
      const unsubscribers = entries.map((e) => e.store.subscribe(notify));
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
    () => aggregateStatus(entries.map((e) => e.store.getState().status)),
  );
}

const DOT: Record<ConnectionStatus, string> = { online: "bg-ok", connecting: "bg-warn", offline: "bg-danger", revoked: "bg-danger" };
const LABEL: Record<ConnectionStatus, MessageKey> = { online: "conn.online", connecting: "conn.connecting", offline: "conn.offline", revoked: "conn.revoked" };

/** Status koneksi ke relay. Tidak tampil bila belum ada laptop terpasang. Perubahannya diumumkan ke pembaca layar. */
export function ConnectionChip() {
  const { t } = useI18n();
  const status = useAggregateStatus(useRelayEntries());
  if (!status) return null;
  const label = t(LABEL[status]);
  return (
    <p aria-live="polite" aria-label={t("conn.label", { status: label })} className="flex items-center gap-1.5 text-xs text-muted">
      <span aria-hidden="true" className={`size-2 rounded-full ${DOT[status]}`} />
      {label}
    </p>
  );
}
