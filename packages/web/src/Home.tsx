// Beranda: laptop yang terpasang beserta sesinya, dan cara memasangkan laptop baru.
// Memilih layar menurut alamat juga ada di sini (Routes).
import { useEffect, useRef } from "react";
import type { PairingLink } from "@agentmon/shared";
import { ApprovalList } from "./approvals/ApprovalList";
import { ApprovalScreen } from "./approvals/ApprovalScreen";
import { DevicesScreen } from "./devices/DevicesScreen";
import { useI18n } from "./i18n/react";
import { Onboarding } from "./onboarding/Onboarding";
import { e2eStatus, getE2e } from "./e2e/runtime";
import { PairScreen } from "./pairing/PairScreen";
import { RollbackScreen } from "./rollback/RollbackScreen";
import { setPendingLink } from "./pairing/pending";
import { PasteLinkForm } from "./pairing/PasteLinkForm";
import { NotificationsSection } from "./push/NotificationsSection";
import { useRelayEntries, useRelayState, type RelayEntry } from "./relay/RelayProvider";
import { navigate, usePath } from "./router";
import { formatWhen } from "./timeline/format";
import { sessionState } from "./timeline/status";
import { TimelineScreen } from "./timeline/TimelineScreen";
import { Heading } from "./ui/Heading";
import { Link } from "./ui/Link";

// Menitipkan tautan hasil tempel (hanya di memori), lalu pindah ke layar pairing.
function startPairing(link: PairingLink) {
  setPendingLink(link);
  navigate("/pair");
}

const MAX_SESSIONS_SHOWN = 20;

function safeHost(relayUrl: string): string {
  try {
    return new URL(relayUrl).host;
  } catch {
    return relayUrl;
  }
}

function RelaySection({ entry }: { entry: RelayEntry }) {
  const { t, locale } = useI18n();
  const state = useRelayState(entry.store);
  const host = safeHost(entry.pairing.relayUrl);

  if (state.status === "revoked") {
    return (
      <section role="alert" className="rounded-2xl border border-line bg-surface p-4 text-muted">
        <p className="font-semibold text-fg">{t("conn.revoked")}</p>
        <p className="mt-1 text-sm">{t("conn.revoked.body")}</p>
      </section>
    );
  }

  // Sebelum daftar pertama tiba, tampilkan laptop yang tersimpan di perangkat (status belum diketahui).
  const machines = state.machinesLoaded ? state.machines : entry.pairing.machines.map((m) => ({ id: m.id, name: m.name, online: false }));

  return (
    <>
      <ApprovalList entry={entry} />
      {state.syncError && (
        <p role="status" className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-fg">
          {t("sync.error")}
        </p>
      )}
      {machines.map((machine) => {
        const sessions = state.sessions[machine.id];
        return (
          <section key={`${host}/${machine.id}`} aria-label={machine.name} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">{machine.name || machine.id}</h2>
              <p className="text-sm text-muted">{state.machinesLoaded ? (machine.online ? t("machine.online") : t("machine.offline")) : ""}</p>
            </div>
            <p className="text-xs text-muted">{t("home.machine.via", { host })}</p>
            {e2eStatus(machine.id) === "no-keys" && (
              <p role="alert" className="mt-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-fg">
                {t("home.machine.noKeys")}
              </p>
            )}
            {e2eStatus(machine.id) === "ok" && (getE2e()?.gate.stats().rejected ?? 0) + (getE2e()?.gate.stats().plaintextRejected ?? 0) > 0 && (
              <p role="status" className="mt-2 text-xs text-muted">
                {t("home.machine.rejected")}
              </p>
            )}

            {sessions === undefined ? (
              <p className="mt-3 text-sm text-muted">{t("sessions.loading")}</p>
            ) : sessions.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{t("sessions.empty")}</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {sessions.slice(0, MAX_SESSIONS_SHOWN).map((session) => (
                  <li key={session.sessionId}>
                    <Link
                      to={`/s/${encodeURIComponent(machine.id)}/${encodeURIComponent(session.sessionId)}`}
                      className="flex min-h-11 flex-col justify-center py-2 active:opacity-70"
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{t(`session.agent.${session.agent}`)}</span>
                        <span className={`text-xs ${sessionState(session) === "active" ? "text-ok" : "text-muted"}`}>{t(`session.status.${sessionState(session)}`)}</span>
                      </span>
                      <span className="text-sm text-muted">
                        {t("session.started", { time: formatWhen(session.startedAt, locale) })} · {t("session.last", { time: formatWhen(session.lastEventAt, locale) })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}

export function Home({ focusHeading = false }: { focusHeading?: boolean }) {
  const { t } = useI18n();
  const entries = useRelayEntries();
  const hasMachines = entries.some((e) => e.pairing.machines.length > 0);

  return (
    <div className="flex flex-col gap-4">
      {hasMachines ? (
        <>
          <Heading focus={focusHeading} className="sr-only">
            {t("home.machines.title")}
          </Heading>
          {entries.map((entry) => (
            <RelaySection key={entry.pairing.relayUrl} entry={entry} />
          ))}
        </>
      ) : (
        <section className="rounded-2xl border border-line bg-surface p-6 text-center">
          <Heading focus={focusHeading} className="text-xl font-semibold">
            {t("empty.title")}
          </Heading>
          <p className="mt-2 text-muted">{t("empty.body")}</p>
        </section>
      )}

      {/* Satu browser hanya bisa berlangganan ke satu kunci, jadi notifikasi terhubung ke relay pertama. */}
      {hasMachines && entries[0] && <NotificationsSection key={entries[0].pairing.relayUrl} entry={entries[0]} />}

      {hasMachines && (
        <Link to="/devices" className="inline-flex min-h-11 items-center self-start text-sm underline">
          {t("devices.link")}
        </Link>
      )}

      <Link to="/panduan" className="inline-flex min-h-11 items-center self-start text-sm underline">
        {t("guide.link")}
      </Link>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-semibold">{t("home.pair.title")}</h2>
        <p className="mt-1 mb-4 text-sm text-muted">{t("home.pair.body")}</p>
        <PasteLinkForm onLink={startPairing} />
      </section>
    </div>
  );
}

// Alamat /s/<laptop>/<sesi> menjadi timeline. Bagian yang tidak bisa didekode dianggap tidak sah.
function parseTimelinePath(path: string): { machineId: string; sessionId: string } | undefined {
  const match = /^\/s\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return undefined;
  try {
    return { machineId: decodeURIComponent(match[1] as string), sessionId: decodeURIComponent(match[2] as string) };
  } catch {
    return undefined;
  }
}

// Alamat /a/<laptop>/<izin> menjadi layar keputusan.
function parseApprovalPath(path: string): { machineId: string; approvalId: string } | undefined {
  const match = /^\/a\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return undefined;
  try {
    return { machineId: decodeURIComponent(match[1] as string), approvalId: decodeURIComponent(match[2] as string) };
  } catch {
    return undefined;
  }
}

// Alamat /r/<laptop>/<checkpoint> menjadi layar rollback.
function parseRollbackPath(path: string): { machineId: string; checkpointId: string } | undefined {
  const match = /^\/r\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return undefined;
  try {
    return { machineId: decodeURIComponent(match[1] as string), checkpointId: decodeURIComponent(match[2] as string) };
  } catch {
    return undefined;
  }
}

/** Memilih layar menurut alamat. */
export function Routes() {
  const path = usePath();
  // Fokus dipindahkan ke judul layar baru hanya untuk perpindahan setelah halaman terbuka, bukan saat pertama dimuat.
  const rendered = useRef(false);
  const focusHeading = rendered.current;
  useEffect(() => {
    rendered.current = true;
  }, []);

  if (path === "/pair") return <PairScreen key="pair" focusHeading={focusHeading} />;
  if (path === "/panduan") return <Onboarding key="panduan" focusHeading={focusHeading} />;
  if (path === "/devices") return <DevicesScreen key="devices" focusHeading={focusHeading} />;
  const approval = parseApprovalPath(path);
  if (approval) return <ApprovalScreen key={`a/${approval.machineId}/${approval.approvalId}`} {...approval} focusHeading={focusHeading} />;
  const rollback = parseRollbackPath(path);
  if (rollback) return <RollbackScreen key={`r/${rollback.machineId}/${rollback.checkpointId}`} {...rollback} focusHeading={focusHeading} />;
  const timeline = parseTimelinePath(path);
  if (timeline) return <TimelineScreen key={`s/${timeline.machineId}/${timeline.sessionId}`} {...timeline} focusHeading={focusHeading} />;
  return <Home key="home" focusHeading={focusHeading} />;
}
