// Layar timeline satu sesi: riwayat event, bertambah secara langsung selagi layar terbuka.
import type { Envelope } from "@agentmon/shared";
import { useEffect } from "react";
import { useI18n } from "../i18n/react";
import { findEntryForMachine, useRelayEntries, useRelayState, type RelayEntry } from "../relay/RelayProvider";
import { sessionKey } from "../relay/relay-store";
import { Heading } from "../ui/Heading";
import { Link } from "../ui/Link";
import { formatWhen } from "./format";
import { TimelineList } from "./TimelineList";

const NO_EVENTS: readonly Envelope[] = [];

function Notice({ children, role }: { children: React.ReactNode; role?: "alert" | "status" }) {
  return (
    <section role={role} className="rounded-2xl border border-line bg-surface p-6 text-center text-muted">
      {children}
    </section>
  );
}

export function TimelineScreen({ machineId, sessionId, focusHeading = false }: { machineId: string; sessionId: string; focusHeading?: boolean }) {
  const { t } = useI18n();
  const entries = useRelayEntries();
  const entry = findEntryForMachine(entries, machineId);
  if (!entry) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Notice role="alert">{t("timeline.notFound")}</Notice>
      </div>
    );
  }
  return <TimelineBody entry={entry} machineId={machineId} sessionId={sessionId} focusHeading={focusHeading} />;
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link to="/" className="inline-flex min-h-11 items-center self-start text-sm text-muted underline">
      {t("timeline.back")}
    </Link>
  );
}

function TimelineBody({ entry, machineId, sessionId, focusHeading }: { entry: RelayEntry; machineId: string; sessionId: string; focusHeading: boolean }) {
  const { t, locale } = useI18n();
  const state = useRelayState(entry.store);
  const key = sessionKey(machineId, sessionId);

  // Membuka sesi memuat riwayatnya dan mengikutinya secara langsung; menutup membebaskan memori.
  useEffect(() => {
    entry.store.openSession(machineId, sessionId);
    return () => entry.store.closeSession(machineId, sessionId);
  }, [entry.store, machineId, sessionId]);

  const events = state.events[key] ?? NO_EVENTS;
  const load = state.load[key];
  const summary = state.sessions[machineId]?.find((s) => s.sessionId === sessionId);
  const agent = summary?.agent ?? events[0]?.agent;
  const agentLabel = agent ? t(`session.agent.${agent}`) : "";

  return (
    <div className="flex flex-col gap-3">
      <BackLink />
      <header>
        <Heading focus={focusHeading} className="text-xl font-semibold">
          {agentLabel ? t("timeline.title", { agent: agentLabel }) : t("timeline.titleUnknown")}
        </Heading>
        <p className="mt-1 text-sm text-muted">
          {summary ? `${t(`session.status.${summary.status}`)} · ${t("session.started", { time: formatWhen(summary.startedAt, locale) })} · ` : ""}
          {t("timeline.count", { count: events.length })}
        </p>
      </header>

      {state.status === "revoked" && <Notice role="alert">{t("conn.revoked.body")}</Notice>}
      {state.syncError && state.status !== "revoked" && (
        <p role="status" className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-fg">
          {t("sync.error")}
        </p>
      )}

      {load === "not-found" ? (
        <Notice role="alert">{t("timeline.notFound")}</Notice>
      ) : load === "error" ? (
        <Notice role="alert">
          <p>{t("timeline.error")}</p>
          <button
            type="button"
            onClick={() => entry.store.retrySession(machineId, sessionId)}
            className="mt-4 min-h-11 rounded-lg bg-accent px-4 font-semibold text-on-accent active:opacity-80"
          >
            {t("timeline.retry")}
          </button>
        </Notice>
      ) : events.length === 0 ? (
        <Notice role="status">{load === "ready" ? t("timeline.empty") : t("timeline.loading")}</Notice>
      ) : (
        <TimelineList events={events} />
      )}
    </div>
  );
}
