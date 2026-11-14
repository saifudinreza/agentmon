// =====================================================================================
// FILE INI: kartu "Notifikasi" di beranda = SAKLAR notifikasi untuk HP ini, beserta penjelasan bila tidak bisa.
// =====================================================================================
//
// Satu kartu, satu keadaan yang jujur: aktif, belum aktif, atau alasan kenapa tidak bisa (iOS belum di layar utama,
// izin diblokir, browser tidak mendukung, relay belum menyalakan push). Izin hanya diminta dari ketukan tombol
// "Aktifkan", tidak pernah otomatis saat halaman dibuka.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import type { RelayEntry } from "../relay/RelayProvider";
import { checkPush, currentPushEnv, disablePush, enablePush, type PushEnv, type PushStatus } from "./subscribe";

type View = { phase: "checking" } | { phase: "busy"; action: "enable" | "disable" } | { phase: "ready"; status: PushStatus };

export function NotificationsSection({ entry, env: injected }: { entry: RelayEntry; /** Hanya untuk test. */ env?: PushEnv }) {
  const { t } = useI18n();
  const env = useMemo(() => injected ?? currentPushEnv(entry.store.api), [injected, entry]);
  const [view, setView] = useState<View>({ phase: "checking" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setView({ phase: "checking" });
    const status = await checkPush(env);
    if (alive.current) setView({ phase: "ready", status });
  }, [env]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Dipanggil LANGSUNG dari ketukan: enablePush meminta izin sebelum menunggu apa pun.
  async function enable() {
    setView({ phase: "busy", action: "enable" });
    const status = await enablePush(env);
    if (alive.current) setView({ phase: "ready", status });
  }
  async function disable() {
    setView({ phase: "busy", action: "disable" });
    const status = await disablePush(env);
    if (alive.current) setView({ phase: "ready", status });
  }

  const status = view.phase === "ready" ? view.status : undefined;
  const button = "min-h-12 rounded-lg px-4 font-semibold disabled:opacity-40";

  return (
    <section aria-label={t("push.title")} className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-lg font-semibold">{t("push.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("push.body")}</p>

      {view.phase === "checking" && (
        <p role="status" className="mt-3 text-sm text-muted">
          {t("push.checking")}
        </p>
      )}

      {status?.kind === "needs-install" && (
        <div role="note" className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-fg">
          <p className="font-semibold">{t("push.ios.title")}</p>
          <p className="mt-1">{t("push.ios.body")}</p>
        </div>
      )}
      {status?.kind === "unsupported" && <p className="mt-3 text-sm text-muted">{t("push.unsupported")}</p>}
      {status?.kind === "denied" && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {t("push.denied")}
        </p>
      )}
      {status?.kind === "unavailable" && <p className="mt-3 text-sm text-muted">{t("push.unavailable")}</p>}
      {status?.kind === "no-sw" && (
        <p role="alert" className="mt-3 text-sm text-muted">
          {t("push.sw.missing")}
        </p>
      )}
      {status?.kind === "error" && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {status.during === "enable" ? t("push.error.enable") : t("push.error")}
        </p>
      )}
      {(status?.kind === "error" || status?.kind === "no-sw") && (
        <button type="button" onClick={() => void refresh()} className={`${button} mt-3 border border-line`}>
          {t("push.retry")}
        </button>
      )}

      {status?.kind === "off" && (
        <>
          <p role="status" className="mt-3 text-sm text-muted">
            {t("push.status.off")}
          </p>
          {status.relayPending && (
            <p role="status" className="mt-2 text-sm text-warn-fg">
              {t("push.error.disable")}
            </p>
          )}
          <button type="button" onClick={() => void enable()} className={`${button} mt-3 w-full bg-accent text-on-accent`}>
            {t("push.enable")}
          </button>
        </>
      )}

      {status?.kind === "on" && (
        <>
          <p role="status" className="mt-3 text-sm text-ok">
            {t("push.status.on")}
          </p>
          <button type="button" onClick={() => void disable()} className={`${button} mt-3 border border-line`}>
            {t("push.disable")}
          </button>
        </>
      )}

      {view.phase === "busy" && (
        <button type="button" disabled className={`${button} mt-3 w-full border border-line`}>
          {view.action === "enable" ? t("push.enabling") : t("push.disabling")}
        </button>
      )}
    </section>
  );
}
