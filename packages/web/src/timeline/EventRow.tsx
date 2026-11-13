import type { Envelope } from "@agentmon/shared";
import { memo, useMemo } from "react";
import { useI18n } from "../i18n/react";
import { describeEvent, type Tone } from "./describe";
import { rollbackPath } from "../rollback/RollbackScreen";
import { Link } from "../ui/Link";
import { formatClock } from "./format";

// Garis penanda di kiri baris menurut "nada" event: permintaan izin menonjol, kegagalan merah, dan seterusnya.
const TONE_BORDER: Record<Tone, string> = {
  neutral: "border-line",
  ok: "border-ok",
  warn: "border-warn",
  bad: "border-danger",
  info: "border-info",
};

/**
 * Satu baris timeline. Dibungkus `memo`: bila event baru ditambahkan, baris yang sudah ada tidak digambar
 * ulang (event tidak pernah berubah), sehingga sesi dengan ribuan event tetap lancar.
 * `content-visibility: auto` membuat browser melewati penataan baris yang jauh di luar layar.
 */
export const EventRow = memo(function EventRow({ event }: { event: Envelope }) {
  const { t, locale } = useI18n();
  const view = useMemo(() => describeEvent(event), [event]);
  // Titik simpan: tawarkan "Kembalikan ke sini".
  const rawId = event.type === "checkpoint.created" ? (event.payload as { checkpointId?: unknown }).checkpointId : undefined;
  const checkpointId = typeof rawId === "string" && rawId !== "" ? rawId : undefined;
  return (
    <li className={`rounded-lg border-l-4 bg-surface px-3 py-2 [contain-intrinsic-size:auto_56px] [content-visibility:auto] ${TONE_BORDER[view.tone]}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{t(view.titleKey, view.titleParams)}</span>
        <time dateTime={event.ts} className="shrink-0 text-xs tabular-nums text-muted">
          {formatClock(event.ts, locale)}
        </time>
      </div>
      {view.detail ? <p className="mt-0.5 break-words text-sm text-muted">{view.detail}</p> : null}
      {checkpointId ? (
        <Link to={rollbackPath(event.machineId, checkpointId)} className="mt-1 inline-flex min-h-11 items-center text-sm underline">
          {t("rollback.link")}
        </Link>
      ) : null}
    </li>
  );
});
