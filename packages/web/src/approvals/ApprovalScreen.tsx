// =====================================================================================
// FILE INI: layar keputusan = "MEJA TANDA TANGAN" tempat pengguna menyetujui atau menolak dari HP.
// =====================================================================================
//
// Menampilkan APA yang diminta agent secara utuh (perintah shell tanpa dipotong, perubahan berkas sebagai teks
// polos), sisa waktu, dan dua pilihan: setujui, atau tolak dengan alasan yang dibaca agent. Setelah memutuskan,
// layar menjelaskan nasib keputusan itu: dikirim, berhasil, dikalahkan perangkat lain, atau kedaluwarsa.
//
// Yang menentukan sah atau tidaknya keputusan adalah laptop (keputusan pertama yang berlaku, dan yang
// kedaluwarsa ditolak). Layar ini hanya mencegah yang jelas sia-sia: tombol mati saat waktu habis, atau saat
// keputusan sedang jalan atau sudah selesai.
import type { FileDiff, PendingApproval } from "@agentmon/shared";
import { useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/id";
import { findEntryForMachine, useRelayEntries, useRelayState, type RelayEntry } from "../relay/RelayProvider";
import { Heading } from "../ui/Heading";
import { Link } from "../ui/Link";
import { cleanLine } from "../timeline/describe";
import { LazyDiffViewer } from "../diff/LazyDiffViewer";
import { RISK_LABEL } from "./ApprovalList";
import { describeInput, formatDiff } from "./format";
import { approvalKey, formatRemaining, isExpired, remainingMs, type Resolution } from "./model";
import { useNow } from "./useNow";
import type { DecisionState } from "../relay/relay-store";

const FINAL_LABEL: Record<Resolution, MessageKey> = {
  approved: "approval.final.approved",
  partially_approved: "approval.final.partially_approved",
  denied: "approval.final.denied",
  timed_out: "approval.final.timed_out",
  cancelled: "approval.final.cancelled",
  auto_approved: "approval.final.auto_approved",
  auto_denied: "approval.final.auto_denied",
};

const MAX_COMMENT = 2000;

export function ApprovalScreen({ machineId, approvalId, focusHeading = false }: { machineId: string; approvalId: string; focusHeading?: boolean }) {
  const { t } = useI18n();
  const entries = useRelayEntries();
  const entry = findEntryForMachine(entries, machineId);
  if (!entry) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p role="alert" className="rounded-2xl border border-line bg-surface p-6 text-center text-muted">
          {t("approval.notFound")}
        </p>
      </div>
    );
  }
  return <ApprovalBody entry={entry} machineId={machineId} approvalId={approvalId} focusHeading={focusHeading} />;
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link to="/" className="inline-flex min-h-11 items-center self-start text-sm text-muted underline">
      {t("approval.back")}
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold text-muted">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

// Teks yang harus terbaca UTUH: dibungkus (tidak melebar ke samping), bisa digulir bila sangat panjang, dan bisa dipilih.
function Pre({ children, label }: { children: string; label: string }) {
  return (
    <pre tabIndex={0} aria-label={label} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg p-3 font-mono text-sm">
      {children}
    </pre>
  );
}

function DiffBlock({ diff }: { diff: FileDiff }) {
  const { t } = useI18n();
  const view = formatDiff(diff);
  return (
    <>
      <p className="text-sm text-muted">{view.kind === "text" && view.isNew ? t("approval.diff.newFile", { path: cleanLine(diff.path, 120) }) : t("approval.diff.file", { path: cleanLine(diff.path, 120) })}</p>
      {diff.sensitive.map((reason) => (
        <p key={reason.code} className="mt-1 rounded-lg bg-warn-bg px-3 py-1.5 text-sm font-semibold text-warn-fg">
          {t("approval.diff.sensitive", { reason: cleanLine(reason.message, 120) })}
        </p>
      ))}
      <div className="mt-2">
        {view.kind === "text" ? (
          view.lines.length === 0 ? (
            <p className="text-sm text-muted">{t("approval.diff.unchanged")}</p>
          ) : (
            <>
              <Pre label={t("approval.diff")}>{view.lines.join("\n")}</Pre>
              {view.hiddenLines > 0 && <p className="mt-1 text-xs text-muted">{t("approval.diff.hidden", { count: view.hiddenLines })}</p>}
            </>
          )
        ) : view.kind === "unchanged" ? (
          <p className="text-sm text-muted">{view.formatChanged ? t("approval.diff.formatOnly") : t("approval.diff.unchanged")}</p>
        ) : view.kind === "binary" ? (
          <p className="text-sm text-muted">{t("approval.diff.binary")}</p>
        ) : view.kind === "too_large" ? (
          <p className="text-sm text-muted">{t("approval.diff.tooLarge", { message: view.message })}</p>
        ) : (
          <p className="text-sm text-muted">{t("approval.diff.mismatch", { message: view.message })}</p>
        )}
      </div>
    </>
  );
}

// Diff teks yang punya hunk memakai penampil yang dimuat belakangan; selama belum siap (atau gagal dimuat), teks biasa
// yang sama tampil, jadi isi yang akan disetujui tetap terbaca. Jenis lain (biner, terlalu besar, dan seterusnya) cukup teks.
function DiffSection({ diff }: { diff: FileDiff }) {
  const plain = <DiffBlock diff={diff} />;
  if (diff.change.type !== "text" || diff.change.hunks.length === 0) return plain;
  return <LazyDiffViewer diffs={[diff]} fallback={plain} />;
}

// Teks status keputusan dalam bahasa manusia, atau undefined bila belum ada keputusan.
function useDecisionText(decision: DecisionState | undefined): { text: string; tone: "info" | "ok" | "warn" | "bad" } | undefined {
  const { t } = useI18n();
  if (!decision) return undefined;
  const status = decision.status ? t(FINAL_LABEL[decision.status]).toLowerCase() : "";
  switch (decision.phase) {
    case "sending":
      return { text: t("approval.status.sending"), tone: "info" };
    case "sent":
      return { text: t("approval.status.sent"), tone: "info" };
    case "applied":
      return { text: t("approval.status.applied", { status: status || t(decision.decision === "approve" ? "approval.final.approved" : "approval.final.denied").toLowerCase() }), tone: "ok" };
    case "conflict":
      return decision.status === "timed_out" ? { text: t("approval.status.conflictTimedOut"), tone: "warn" } : { text: t("approval.status.conflict", { status }), tone: "warn" };
    case "expired":
      return { text: t("approval.status.expired"), tone: "warn" };
    case "failed":
      return { text: t(`approval.status.failed.${decision.reason ?? "unconfirmed"}`), tone: "bad" };
  }
}

function ApprovalBody({ entry, machineId, approvalId, focusHeading }: { entry: RelayEntry; machineId: string; approvalId: string; focusHeading: boolean }) {
  const { t } = useI18n();
  const state = useRelayState(entry.store);
  const now = useNow();
  const [comment, setComment] = useState("");

  const key = approvalKey(machineId, approvalId);
  const pending = state.approvals.find((a) => approvalKey(a.machineId, a.approvalId) === key);
  // Isi permintaan tetap tampil setelah selesai (agar pengguna melihat apa yang diputuskan), walau sudah keluar dari antrean.
  const last = useRef<PendingApproval | undefined>(undefined);
  if (pending) last.current = pending;
  const approval = pending ?? last.current;

  const decision = state.decisions[key];
  const resolution = state.resolved[key];
  const decisionText = useDecisionText(decision);
  const machineName = state.machines.find((m) => m.id === machineId)?.name ?? entry.pairing.machines.find((m) => m.id === machineId)?.name ?? machineId;

  // Aksi yang masih mungkin dilakukan.
  const expired = approval ? isExpired(approval, now) : true;
  const inFlight = decision?.phase === "sending" || decision?.phase === "sent";
  const finished = decision !== undefined && decision.phase !== "failed";
  const canDecide = pending !== undefined && !expired && !inFlight && !finished && resolution === undefined && state.status === "online";

  // Isi yang terpotong tidak boleh disetujui: pengguna tidak melihat semuanya. Menolak tetap bisa.
  const canApprove = canDecide && !approval?.truncated;

  const textareaId = "approval-comment";

  if (!approval) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p role="alert" className="rounded-2xl border border-line bg-surface p-6 text-center text-muted">
          {resolution ? t("approval.resolved", { status: t(FINAL_LABEL[resolution]).toLowerCase() }) : t("approval.notFound")}
        </p>
      </div>
    );
  }

  const fields = describeInput(approval.toolName, approval.toolInput);
  const shell = fields.find((f) => f.kind === "shell");
  const others = fields.filter((f) => f !== shell);
  const level = approval.risk?.level;
  const left = remainingMs(approval, now);

  return (
    <div className="flex flex-col gap-3">
      <BackLink />
      <header>
        <Heading focus={focusHeading} className="text-xl font-semibold">
          {t("approval.screen.title", { tool: cleanLine(approval.toolName, 60) })}
        </Heading>
        <p className="mt-1 text-sm text-muted">{t("approval.from", { machine: machineName })}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm">
          <span className={`tabular-nums ${expired ? "font-semibold text-danger" : left < 60_000 ? "text-danger" : "text-muted"}`}>
            {expired ? t("approval.expired") : t("approval.remaining", { time: formatRemaining(left) })}
          </span>
          {level && <span className={level === "high" ? "font-semibold text-danger" : "text-muted"}>{t(RISK_LABEL[level])}</span>}
        </p>
        {approval.summary && <p className="mt-1 text-sm">{cleanLine(approval.summary, 200)}</p>}
        {approval.risk?.reasons.map((reason) => (
          <p key={reason.code} className="text-sm text-muted">
            {cleanLine(reason.message, 160)}
          </p>
        ))}
      </header>

      {approval.truncated && (
        <p role="alert" className="rounded-lg bg-warn-bg px-3 py-2 text-sm font-semibold text-warn-fg">
          {t("approval.truncated")}
        </p>
      )}
      {shell && (
        <Section title={t("approval.command")}>
          <Pre label={t("approval.command")}>{shell.value}</Pre>
        </Section>
      )}
      {others.length > 0 && (
        <Section title={t("approval.input")}>
          <dl className="flex flex-col gap-2">
            {others.map((field) => (
              <div key={field.label}>
                <dt className="text-xs text-muted">{cleanLine(field.label, 40)}</dt>
                <dd>
                  <Pre label={cleanLine(field.label, 40)}>{field.value}</Pre>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      <Section title={t("approval.diff")}>{approval.diff ? <DiffSection diff={approval.diff} /> : <p className="text-sm text-muted">{t("approval.diff.none")}</p>}</Section>

      <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
        <label htmlFor={textareaId} className="text-sm font-medium">
          {t("approval.comment.label")}
        </label>
        <textarea
          id={textareaId}
          value={comment}
          maxLength={MAX_COMMENT}
          rows={3}
          disabled={!canDecide}
          onChange={(event) => setComment(event.target.value)}
          aria-describedby="approval-comment-hint"
          className="w-full rounded-lg border border-line bg-bg p-3 text-base text-fg disabled:opacity-60"
        />
        <p id="approval-comment-hint" className="text-xs text-muted">
          {t("approval.comment.hint")}
        </p>
        <div className="mt-1 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={!canDecide}
            onClick={() => entry.store.decide(machineId, approvalId, "deny", comment)}
            className="min-h-12 rounded-lg border border-danger px-4 font-semibold text-danger active:opacity-80 disabled:opacity-40"
          >
            {t("approval.deny")}
          </button>
          <button
            type="button"
            disabled={!canApprove}
            onClick={() => entry.store.decide(machineId, approvalId, "approve")}
            className="min-h-12 rounded-lg bg-accent px-4 font-semibold text-on-accent active:opacity-80 disabled:opacity-40"
          >
            {t("approval.approve")}
          </button>
        </div>
      </section>

      {/* Status keputusan dan penjelasan; diumumkan ke pembaca layar setiap kali berubah. */}
      <div aria-live="polite" role="status" className="min-h-6">
        {decisionText ? (
          <p className={`rounded-lg px-3 py-2 text-sm ${decisionText.tone === "bad" ? "bg-warn-bg text-danger" : decisionText.tone === "warn" ? "bg-warn-bg text-warn-fg" : "bg-surface text-fg"}`}>{decisionText.text}</p>
        ) : expired && resolution === undefined ? (
          <p className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-fg">{t("approval.status.expired")}</p>
        ) : resolution !== undefined ? (
          <p className="rounded-lg bg-surface px-3 py-2 text-sm">{t("approval.resolved", { status: t(FINAL_LABEL[resolution]).toLowerCase() })}</p>
        ) : null}
        {decision?.phase === "failed" && pending && !expired && (
          <button type="button" onClick={() => entry.store.decide(machineId, approvalId, decision.decision, decision.decision === "deny" ? comment : undefined)} className="mt-2 min-h-11 rounded-lg border border-line bg-surface px-4 text-sm">
            {t("approval.retry")}
          </button>
        )}
      </div>
    </div>
  );
}
