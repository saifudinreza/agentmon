// =====================================================================================
// FILE INI: layar panduan pemasangan = "PEMANDU" yang menuntun pengguna awam dari nol sampai notifikasi uji tiba (FR-54, FR-55).
// =====================================================================================
//
// Urutannya: pasang ke layar utama, pasangkan laptop, aktifkan notifikasi, uji notifikasi. Petunjuk menyesuaikan perangkat
// (environment.ts, guide.ts). Dua hal yang dijaga:
//   - iOS: tombol notifikasi TIDAK dipasang sebelum app dibuka dari ikon layar utama, jadi izin tidak mungkin diminta dari
//     tab Safari (iOS menolaknya dan pengguna bisa terjebak).
//   - Notifikasi uji dikirim lewat relay dan layanan push sungguhan, bukan notifikasi lokal, supaya yang dibuktikan adalah
//     jalur yang akan dipakai izin sungguhan.
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/id";
import { NotificationsSection } from "../push/NotificationsSection";
import type { PushEnv, PushStatus } from "../push/subscribe";
import { RelayApiError, type RelayApi } from "../relay/api";
import { useRelayEntries } from "../relay/RelayProvider";
import { Heading } from "../ui/Heading";
import { Link } from "../ui/Link";
import { currentEnvironment, type DeviceEnvironment } from "./environment";
import { buildGuide, type Blocker, type Step, type StepState } from "./guide";

type TestPhase = "idle" | "sending" | "sent" | { error: MessageKey };

export function errorKey(error: unknown): MessageKey {
  if (error instanceof RelayApiError) {
    if (error.kind === "not-found") return "guide.step.test.error.notFound";
    if (error.kind === "rate-limited") return "guide.step.test.error.rateLimited";
    if (error.kind === "unreachable") return "guide.step.test.error.unreachable";
    if (error.kind === "server") return "guide.step.test.error.server";
  }
  return "guide.step.test.error.other";
}

const STATE_STYLE: Record<StepState, string> = {
  done: "text-ok",
  current: "text-accent font-semibold",
  todo: "text-muted",
  locked: "text-muted",
};

export function Onboarding({ focusHeading = false, env: injectedEnv, pushEnv }: { focusHeading?: boolean; env?: DeviceEnvironment; /** Hanya untuk test. */ pushEnv?: PushEnv }) {
  const { t } = useI18n();
  const entries = useRelayEntries();
  const env = useMemo(() => injectedEnv ?? currentEnvironment(), [injectedEnv]);
  const paired = entries.some((e) => e.pairing.machines.length > 0);
  const entry = entries[0];
  const [notifying, setNotifying] = useState(false);
  const [test, setTest] = useState<TestPhase>("idle");
  const tested = test === "sent";
  const guide = buildGuide(env, { paired, notifying, tested });

  const onStatus = (status: PushStatus) => setNotifying(status.kind === "on");

  // Ref (bukan state): dua ketukan dalam satu putaran render melihat state yang sama, dan keduanya akan lolos.
  const sending = useRef(false);
  async function sendTest(api: Pick<RelayApi, "sendTestPush">) {
    if (sending.current) return;
    sending.current = true;
    setTest("sending");
    try {
      await api.sendTestPush();
      setTest("sent");
    } catch (error) {
      setTest({ error: errorKey(error) });
    } finally {
      sending.current = false;
    }
  }

  const device = t(`guide.os.${env.os}`);
  const browser = t(`guide.browser.${env.browser}`);
  const mode = t(env.installed ? "guide.mode.installed" : "guide.mode.tab");
  const iosTab = env.os === "ios" && !env.installed;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <Heading focus={focusHeading} className="text-xl font-semibold">
          {t("guide.title")}
        </Heading>
        <p className="mt-1 text-sm text-muted">{t("guide.intro")}</p>
        <p className="mt-2 text-xs text-muted">{t("guide.detected", { device, browser, mode })}</p>
      </section>

      {guide.blocker && <BlockerCard blocker={guide.blocker} env={env} />}
      {guide.notes.map((note) => (
        <p key={note} role="note" className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-fg">
          {t(note === "ios-browser" ? "guide.note.iosBrowser" : "guide.note.desktop")}
        </p>
      ))}

      <ol className="flex flex-col gap-3">
        {guide.steps.map((step, index) => (
          <li key={step.id} aria-current={step.id === guide.current ? "step" : undefined} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-semibold">
                {index + 1}. {t(`guide.step.${step.id}.title`)}
                {step.optional && step.state !== "done" && <span className="ml-2 text-xs font-normal text-muted">({t("guide.optional")})</span>}
              </h3>
              <span className={`shrink-0 text-xs ${STATE_STYLE[step.state]}`}>{t(`guide.state.${step.state}`)}</span>
            </div>
            <StepBody
              step={step}
              env={env}
              iosTab={iosTab}
              blocked={guide.blocker !== undefined}
              paired={paired}
              notifySection={entry ? <NotificationsSection key={entry.pairing.relayUrl} entry={entry} onStatus={onStatus} {...(pushEnv ? { env: pushEnv } : {})} /> : null}
              test={test}
              onSendTest={entry ? () => void sendTest(entry.store.api) : undefined}
            />
          </li>
        ))}
      </ol>

      {tested && !guide.blocker && (
        <p role="status" className="rounded-lg border border-line px-3 py-2 text-sm text-ok">
          {t("guide.finished")}
        </p>
      )}
      <Link to="/" className="inline-flex min-h-11 items-center self-start text-sm underline">
        {t("guide.back")}
      </Link>
    </div>
  );
}

function BlockerCard({ blocker, env }: { blocker: Blocker; env: DeviceEnvironment }) {
  const { t } = useI18n();
  const iosVersion = env.iosVersion ? `${env.iosVersion.major}.${env.iosVersion.minor}` : "";
  const content =
    blocker === "inapp"
      ? { title: t("guide.block.inapp.title"), body: t(`guide.block.inapp.body.${env.os}`) }
      : blocker === "ios-too-old"
        ? { title: t("guide.block.iosOld.title"), body: t("guide.block.iosOld.body", { version: iosVersion }) }
        : { title: t("guide.block.noPush.title"), body: t("guide.block.noPush.body") };
  return (
    <section role="alert" className="rounded-2xl border border-line bg-warn-bg p-4 text-warn-fg">
      <p className="font-semibold">{content.title}</p>
      <p className="mt-1 text-sm">{content.body}</p>
    </section>
  );
}

function StepBody({
  step,
  env,
  iosTab,
  blocked,
  paired,
  notifySection,
  test,
  onSendTest,
}: {
  step: Step;
  env: DeviceEnvironment;
  iosTab: boolean;
  blocked: boolean;
  paired: boolean;
  notifySection: React.ReactNode;
  test: TestPhase;
  onSendTest: (() => void) | undefined;
}) {
  const { t } = useI18n();

  if (step.id === "install") {
    if (env.installed) return <p className="mt-2 text-sm text-muted">{t("guide.step.install.done")}</p>;
    if (env.os === "desktop" || blocked) return null;
    const kind = env.os === "ios" ? "ios" : "android";
    return (
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
        {([1, 2, 3] as const).map((n) => (
          <li key={n}>{t(`guide.step.install.${kind}.${n}`)}</li>
        ))}
      </ol>
    );
  }

  if (step.id === "pair") {
    if (paired) return <p className="mt-2 text-sm text-muted">{t("guide.step.pair.done")}</p>;
    return (
      <>
        <p className="mt-2 text-sm text-muted">{t("guide.step.pair.body")}</p>
        <Link to="/" className="mt-2 inline-flex min-h-11 items-center text-sm underline">
          {t("guide.step.pair.go")}
        </Link>
      </>
    );
  }

  if (step.id === "notify") {
    if (step.state === "locked") {
      // Urutan alasan: terhalang, lalu iOS belum dari layar utama, lalu belum berpasangan. Tombol TIDAK dipasang saat terkunci.
      const reason = blocked ? "guide.step.notify.locked.blocked" : iosTab ? "guide.step.notify.locked.ios" : "guide.step.notify.locked.pair";
      return <p className="mt-2 text-sm text-muted">{t(reason)}</p>;
    }
    return <div className="mt-2">{notifySection}</div>;
  }

  // test
  if (step.state === "locked") return <p className="mt-2 text-sm text-muted">{t("guide.step.test.locked")}</p>;
  const sending = test === "sending";
  return (
    <>
      <p className="mt-2 text-sm text-muted">{t("guide.step.test.body")}</p>
      <button
        type="button"
        aria-disabled={sending || onSendTest === undefined}
        onClick={() => onSendTest?.()}
        className="mt-3 min-h-12 w-full rounded-lg bg-accent px-4 font-semibold text-on-accent aria-disabled:opacity-40"
      >
        {sending ? t("guide.step.test.sending") : t("guide.step.test.send")}
      </button>
      <div role="status" aria-live="polite" className="mt-2 text-sm">
        {test === "sent" && (
          <>
            <p className="text-ok">{t("guide.step.test.sent")}</p>
            <p className="mt-1 text-muted">{t("guide.step.test.missing")}</p>
          </>
        )}
        {typeof test === "object" && <p className="text-danger">{t(test.error)}</p>}
      </div>
    </>
  );
}
