// =====================================================================================
// FILE INI: kartu "Notifikasi" di beranda = SAKLAR notifikasi untuk HP ini, beserta penjelasan bila tidak bisa.
// =====================================================================================
//
// Satu kartu, satu keadaan yang jujur: aktif, belum aktif, atau alasan kenapa tidak bisa (iOS belum di layar utama,
// izin diblokir, browser tidak mendukung, relay belum menyalakan push). Izin hanya diminta dari ketukan tombol
// "Aktifkan", tidak pernah otomatis saat halaman dibuka.
//
// AKSESIBILITAS: hanya SATU elemen tombol yang tetap terpasang di antara semua keadaan (label dan perilakunya yang
// berganti, dan selama proses ia memakai aria-disabled, bukan disabled). Bila tombolnya dilepas lalu diganti, fokus
// pengguna pembaca layar dan keyboard jatuh ke awal halaman. Teks status ada di satu wilayah aria-live yang selalu ada,
// supaya perubahannya diumumkan.
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

  const busy = view.phase === "busy";
  const status = view.phase === "ready" ? view.status : undefined;

  // Pesan status (satu wilayah aria-live yang selalu ada).
  let message: { text: string; tone: "muted" | "ok" | "danger" } | undefined;
  if (view.phase === "checking") message = { text: t("push.checking"), tone: "muted" };
  else if (view.phase === "busy") message = { text: view.action === "enable" ? t("push.enabling") : t("push.disabling"), tone: "muted" };
  else if (status?.kind === "on") message = { text: t("push.status.on"), tone: "ok" };
  else if (status?.kind === "off") message = { text: t("push.status.off"), tone: "muted" };
  else if (status?.kind === "unsupported") message = { text: t("push.unsupported"), tone: "muted" };
  else if (status?.kind === "denied") message = { text: t("push.denied"), tone: "danger" };
  else if (status?.kind === "unavailable") message = { text: t("push.unavailable"), tone: "muted" };
  else if (status?.kind === "no-sw") message = { text: t("push.sw.missing"), tone: "muted" };
  else if (status?.kind === "error") message = { text: status.during === "enable" ? t("push.error.enable") : t("push.error"), tone: "danger" };

  // Satu tombol untuk semua keadaan; yang berganti hanya label dan perilakunya.
  let action: { label: string; run?: () => void; primary?: boolean } | undefined;
  if (view.phase === "busy") action = { label: view.action === "enable" ? t("push.enabling") : t("push.disabling"), primary: view.action === "enable" };
  else if (status?.kind === "off") action = { label: t("push.enable"), run: () => void enable(), primary: true };
  else if (status?.kind === "on") action = { label: t("push.disable"), run: () => void disable() };
  else if (status?.kind === "error" || status?.kind === "no-sw") action = { label: t("push.retry"), run: () => void refresh() };

  const tone = { muted: "text-muted", ok: "text-ok", danger: "text-danger" } as const;

  return (
    <section aria-label={t("push.title")} className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-lg font-semibold">{t("push.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("push.body")}</p>

      <div role="status" aria-live="polite" className="mt-3 flex flex-col gap-2 text-sm">
        {message && <p className={tone[message.tone]}>{message.text}</p>}
        {status?.kind === "needs-install" && (
          <div className="rounded-lg bg-warn-bg px-3 py-2 text-warn-fg">
            <p className="font-semibold">{t("push.ios.title")}</p>
            <p className="mt-1">{t("push.ios.body")}</p>
          </div>
        )}
        {status?.kind === "off" && status.relayPending && <p className="text-warn-fg">{t("push.error.disable")}</p>}
      </div>

      {action && (
        <button
          type="button"
          // aria-disabled (bukan disabled): tombol yang di-disable kehilangan fokus di sebagian browser. Selama sibuk
          // aksinya tidak punya perilaku (`run` kosong), jadi ketukan tambahan tidak menjalankan apa-apa.
          aria-disabled={busy}
          onClick={() => action.run?.()}
          className={`mt-3 min-h-12 rounded-lg px-4 font-semibold aria-disabled:opacity-40 ${action.primary ? "w-full bg-accent text-on-accent" : "border border-line"}`}
        >
          {action.label}
        </button>
      )}
    </section>
  );
}
