// =====================================================================================
// FILE INI: layar "Perangkat" = DAFTAR KUNCI yang beredar, dengan tombol untuk menarik satu kunci.
// =====================================================================================
//
// Menampilkan perangkat yang berbagi laptop dengan HP ini, dan memungkinkan mencabut salah satunya (HP hilang,
// atau perangkat yang tidak lagi dipakai). Pencabutan berlaku seketika di relay: koneksinya diputus dan tokennya
// ditolak. Karena tidak bisa dibatalkan, tombolnya meminta konfirmasi dulu (ketukan kedua).
import type { ListedDevice } from "@agentmon/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import { RelayApiError } from "../relay/api";
import { useRelayEntries, type RelayEntry } from "../relay/RelayProvider";
import { cleanLine } from "../timeline/describe";
import { formatWhen } from "../timeline/format";
import { Heading } from "../ui/Heading";
import { Link } from "../ui/Link";

type LoadState = { phase: "loading" } | { phase: "error"; unauthorized: boolean } | { phase: "ready"; devices: ListedDevice[] };

function RelayDevices({ entry }: { entry: RelayEntry }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  // Perangkat yang sedang diminta konfirmasi, yang sedang dicabut, dan pesan hasil terakhir.
  const [confirming, setConfirming] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<{ text: string; bad: boolean } | undefined>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const devices = await entry.store.api.devices();
      if (alive.current) setState({ phase: "ready", devices });
    } catch (error) {
      if (alive.current) setState({ phase: "error", unauthorized: error instanceof RelayApiError && error.kind === "unauthorized" });
    }
  }, [entry]);
  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(device: ListedDevice) {
    setBusy(device.id);
    setMessage(undefined);
    try {
      await entry.store.api.revokeDevice(device.id);
      if (!alive.current) return;
      setConfirming(undefined);
      setMessage({ text: device.current ? t("devices.revoked.self") : t("devices.revoked", { name: cleanLine(device.name, 60) }), bad: false });
      // Mencabut diri sendiri membuat daftar tidak bisa dimuat lagi (token ditolak); cukup tampilkan pesannya.
      if (!device.current) await load();
    } catch {
      if (alive.current) setMessage({ text: t("devices.revoke.failed"), bad: true });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  }

  const host = (() => {
    try {
      return new URL(entry.pairing.relayUrl).host;
    } catch {
      return entry.pairing.relayUrl;
    }
  })();

  return (
    <section aria-label={t("devices.via", { host })} className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-xs text-muted">{t("home.machine.via", { host })}</p>
      {message && (
        <p role="status" className={`mt-2 rounded-lg px-3 py-2 text-sm ${message.bad ? "bg-warn-bg text-danger" : "bg-bg"}`}>
          {message.text}
        </p>
      )}
      {state.phase === "loading" && <p className="mt-3 text-sm text-muted">{t("devices.loading")}</p>}
      {state.phase === "error" && (
        <p role="alert" className="mt-3 text-sm text-muted">
          {state.unauthorized ? t("conn.revoked") : t("devices.error")}
          {!state.unauthorized && (
            <button type="button" onClick={() => void load()} className="ml-2 min-h-11 underline">
              {t("devices.retry")}
            </button>
          )}
        </p>
      )}
      {state.phase === "ready" && state.devices.length === 0 && <p className="mt-3 text-sm text-muted">{t("devices.empty")}</p>}
      {state.phase === "ready" && state.devices.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {state.devices.map((device) => (
            <li key={device.id} className="flex flex-col gap-2 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">
                  {cleanLine(device.name, 60) || device.id}
                  {device.current && <span className="ml-2 text-xs font-normal text-muted">{t("devices.current")}</span>}
                </span>
                <span className="text-xs text-muted">{t("devices.since", { time: formatWhen(device.pairedAt, locale) })}</span>
              </div>
              {confirming === device.id ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-danger">{device.current ? t("devices.confirm.self") : t("devices.confirm", { name: cleanLine(device.name, 60) })}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <button type="button" disabled={busy !== undefined} onClick={() => setConfirming(undefined)} className="min-h-12 rounded-lg border border-line px-4 font-semibold disabled:opacity-40">
                      {t("devices.cancel")}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== undefined}
                      onClick={() => void revoke(device)}
                      className="min-h-12 rounded-lg bg-danger px-4 font-semibold text-on-accent disabled:opacity-40"
                    >
                      {busy === device.id ? t("devices.revoking") : t("devices.revoke.confirm")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy !== undefined}
                  onClick={() => {
                    setMessage(undefined);
                    setConfirming(device.id);
                  }}
                  aria-label={t("devices.revoke.aria", { name: cleanLine(device.name, 60) || device.id })}
                  className="min-h-11 self-start rounded-lg border border-danger px-4 text-sm font-semibold text-danger disabled:opacity-40"
                >
                  {t("devices.revoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DevicesScreen({ focusHeading = false }: { focusHeading?: boolean }) {
  const { t } = useI18n();
  const entries = useRelayEntries();
  return (
    <div className="flex flex-col gap-3">
      <Link to="/" className="inline-flex min-h-11 items-center self-start text-sm text-muted underline">
        {t("approval.back")}
      </Link>
      <Heading focus={focusHeading} className="text-xl font-semibold">
        {t("devices.title")}
      </Heading>
      <p className="text-sm text-muted">{t("devices.body")}</p>
      {entries.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-6 text-center text-muted">{t("devices.none")}</p> : entries.map((entry) => <RelayDevices key={entry.pairing.relayUrl} entry={entry} />)}
    </div>
  );
}
