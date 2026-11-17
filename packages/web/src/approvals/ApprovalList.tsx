// Antrean izin yang menunggu keputusan, di beranda. Yang berisiko tinggi di atas (FR-27) dan tiap baris
// menampilkan sisa waktu. Permintaan yang sudah lewat batas waktunya tidak ditampilkan (tidak bisa diputuskan).
import type { PendingApproval } from "@agentmon/shared";
import { useI18n } from "../i18n/react";
import { useRelayState, type RelayEntry } from "../relay/RelayProvider";
import { cleanLine } from "../timeline/describe";
import { PATH_KEYS, shortenPath } from "../timeline/path";
import { Link } from "../ui/Link";
import { describeInput } from "./format";
import { RiskBadge } from "./risk";
import { formatRemaining, isExpired, remainingMs } from "./model";
import { useNow } from "./useNow";


/** Satu baris yang menggambarkan apa yang diminta: perintah, berkas, atau ringkasan. */
export function targetOf(approval: PendingApproval): string {
  const field = describeInput(approval.toolName, approval.toolInput)[0];
  if (approval.summary !== undefined || !field) return cleanLine(approval.summary ?? "", 100);
  // Jalur berkas diringkas untuk daftar; layar keputusan (yang dibuka dengan mengetuk baris) menampilkan jalur UTUH.
  return PATH_KEYS.has(field.label) ? shortenPath(cleanLine(field.value, 500)) : cleanLine(field.value, 100);
}

export const approvalPath = (machineId: string, approvalId: string) => `/a/${encodeURIComponent(machineId)}/${encodeURIComponent(approvalId)}`;

export function ApprovalList({ entry }: { entry: RelayEntry }) {
  const { t } = useI18n();
  const state = useRelayState(entry.store);
  const now = useNow();
  const items = state.approvals.filter((a) => !isExpired(a, now));
  if (items.length === 0) return null;

  const machineName = (id: string) => state.machines.find((m) => m.id === id)?.name ?? entry.pairing.machines.find((m) => m.id === id)?.name ?? id;

  return (
    <section aria-label={t("approval.queue.title")} className="rounded-2xl border border-warn bg-surface p-4">
      <h2 className="text-lg font-semibold">
        {t("approval.queue.title")} ({items.length})
      </h2>
      <ul className="mt-2 divide-y divide-line">
        {items.map((approval) => {
          const left = remainingMs(approval, now);
          const level = approval.risk?.level;
          return (
            <li key={`${approval.machineId}/${approval.approvalId}`}>
              <Link
                to={approvalPath(approval.machineId, approval.approvalId)}
                aria-label={`${t("approval.queue.item", { tool: approval.toolName })}. ${t("approval.remaining", { time: formatRemaining(left) })}`}
                className="flex min-h-11 flex-col justify-center py-2 active:opacity-70"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{cleanLine(approval.toolName, 60)}</span>
                  <span className={`text-sm tabular-nums ${left < 60_000 ? "text-danger" : "text-muted"}`}>{t("approval.remaining", { time: formatRemaining(left) })}</span>
                </span>
                {(level || targetOf(approval)) && (
                  <span className="text-sm text-muted">
                    {level ? <RiskBadge level={level} /> : null}
                    {level && targetOf(approval) ? " · " : null}
                    {targetOf(approval)}
                  </span>
                )}
                {approval.risk?.reasons[0] && <span className="text-sm text-muted">{cleanLine(approval.risk.reasons[0].message, 120)}</span>}
                <span className="text-xs text-muted">{machineName(approval.machineId)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
