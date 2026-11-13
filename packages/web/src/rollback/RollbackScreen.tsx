// =====================================================================================
// FILE INI: layar rollback = "TOMBOL KEMBALIKAN" dengan pratinjau dan konfirmasi dua langkah.
// =====================================================================================
//
// Rollback itu destruktif, jadi layar ini sengaja berhati-hati:
//   1. Meminta PRATINJAU dari laptop: daftar berkas yang akan dibuat lagi, dikembalikan, atau DIHAPUS.
//   2. Menampilkan semuanya (termasuk pekerjaan setelah checkpoint) beserta hal yang tidak bisa dibatalkan.
//   3. Konfirmasi dua ketukan. Yang dikirim membawa sidik pratinjau; bila isi proyek berubah, laptop menolak.
//   4. Setelah berhasil, ada tautan untuk MEMBATALKAN rollback (kembali ke keadaan sebelumnya).
// Yang menentukan boleh atau tidaknya adalah laptop (agent masih berjalan, checkpoint hilang, dan seterusnya).
import { RollbackResultSchema, type RollbackChangeKind, type RollbackResult } from "@agentmon/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { escapeUnsafe } from "../approvals/format";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/id";
import { findEntryForMachine, useRelayEntries, useRelayState, type RelayEntry } from "../relay/RelayProvider";
import type { RequestFailure } from "../relay/relay-store";
import { Heading } from "../ui/Heading";
import { Link } from "../ui/Link";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; reason: RequestFailure | "bad-reply" }
  | { kind: "preview"; result: Extract<RollbackResult, { outcome: "preview" }> }
  | { kind: "applying"; result: Extract<RollbackResult, { outcome: "preview" }> }
  | { kind: "done"; result: Exclude<RollbackResult, { outcome: "preview" }> };

const CHANGE_LABEL: Record<RollbackChangeKind, MessageKey> = {
  restore: "rollback.change.restore",
  overwrite: "rollback.change.overwrite",
  delete: "rollback.change.delete",
};
const CHANGE_CLASS: Record<RollbackChangeKind, string> = { restore: "text-ok", overwrite: "text-muted", delete: "font-semibold text-danger" };
const ERROR_KEY: Record<RequestFailure | "bad-reply", MessageKey> = {
  offline: "rollback.error.offline",
  "laptop-offline": "rollback.error.laptopOffline",
  "not-allowed": "rollback.error.notAllowed",
  "rate-limited": "rollback.error.rateLimited",
  unconfirmed: "rollback.error.unconfirmed",
  "bad-reply": "rollback.error.badReply",
};

export function rollbackPath(machineId: string, checkpointId: string): string {
  return `/r/${encodeURIComponent(machineId)}/${encodeURIComponent(checkpointId)}`;
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link to="/" className="inline-flex min-h-11 items-center self-start text-sm text-muted underline">
      {t("approval.back")}
    </Link>
  );
}

export function RollbackScreen({ machineId, checkpointId, focusHeading = false }: { machineId: string; checkpointId: string; focusHeading?: boolean }) {
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
  return <RollbackBody entry={entry} machineId={machineId} checkpointId={checkpointId} focusHeading={focusHeading} />;
}

function RollbackBody({ entry, machineId, checkpointId, focusHeading }: { entry: RelayEntry; machineId: string; checkpointId: string; focusHeading: boolean }) {
  const { t } = useI18n();
  const state = useRelayState(entry.store);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadPreview = useCallback(async () => {
    setPhase({ kind: "loading" });
    setConfirming(false);
    const result = await entry.store.request(machineId, { type: "rollback.preview", checkpointId });
    if (!alive.current) return;
    if (!result.ok) return setPhase({ kind: "error", reason: result.reason });
    const parsed = RollbackResultSchema.safeParse(result.reply);
    if (!parsed.success || parsed.data.checkpointId !== checkpointId) return setPhase({ kind: "error", reason: "bad-reply" });
    setPhase(parsed.data.outcome === "preview" ? { kind: "preview", result: parsed.data } : { kind: "done", result: parsed.data });
  }, [entry, machineId, checkpointId]);

  // Pratinjau diminta SEKALI, begitu koneksi ke relay siap. Layar yang dibuka langsung dari alamat (muat ulang)
  // muncul sebelum koneksi tersambung, dan perintah yang dikirim saat itu pasti gagal.
  const started = useRef(false);
  const online = state.status === "online";
  useEffect(() => {
    if (!online || started.current) return;
    started.current = true;
    void loadPreview();
  }, [online, loadPreview]);

  async function apply(preview: Extract<RollbackResult, { outcome: "preview" }>) {
    setPhase({ kind: "applying", result: preview });
    const result = await entry.store.request(machineId, { type: "rollback.apply", checkpointId, previewHash: preview.previewHash });
    if (!alive.current) return;
    if (!result.ok) return setPhase({ kind: "error", reason: result.reason });
    const parsed = RollbackResultSchema.safeParse(result.reply);
    if (!parsed.success || parsed.data.outcome === "preview") return setPhase({ kind: "error", reason: "bad-reply" });
    setPhase({ kind: "done", result: parsed.data });
  }

  return (
    <div className="flex flex-col gap-3">
      <BackLink />
      <Heading focus={focusHeading} className="text-xl font-semibold">
        {t("rollback.title")}
      </Heading>

      <div aria-live="polite" className="flex flex-col gap-3">
        {state.status === "revoked" && (
          <p role="alert" className="rounded-2xl border border-line bg-surface p-4">
            {t("conn.revoked")}
          </p>
        )}
        {phase.kind === "loading" && state.status !== "revoked" && <p className="text-sm text-muted">{online || started.current ? t("rollback.loading") : t("rollback.connecting")}</p>}

        {phase.kind === "error" && (
          <div role="alert" className="rounded-2xl border border-line bg-surface p-4">
            <p>{t(ERROR_KEY[phase.reason])}</p>
            {phase.reason !== "bad-reply" && (
              <button type="button" onClick={() => void loadPreview()} className="mt-2 min-h-11 rounded-lg border border-line px-4 text-sm">
                {t("devices.retry")}
              </button>
            )}
          </div>
        )}

        {(phase.kind === "preview" || phase.kind === "applying") && (
          <Preview
            result={phase.result}
            busy={phase.kind === "applying"}
            confirming={confirming}
            onAsk={() => setConfirming(true)}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void apply(phase.result)}
          />
        )}

        {phase.kind === "done" && <Outcome result={phase.result} machineId={machineId} onRetry={() => void loadPreview()} />}
      </div>
    </div>
  );
}

function Preview({
  result,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  result: Extract<RollbackResult, { outcome: "preview" }>;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const counts = { restore: 0, overwrite: 0, delete: 0 };
  for (const file of result.files) counts[file.change]++;

  if (result.total === 0) return <p className="rounded-2xl border border-line bg-surface p-4">{t("rollback.nothing")}</p>;

  return (
    <>
      <section className="rounded-2xl border border-warn bg-surface p-4">
        <h3 className="font-semibold">{t("rollback.summary", { count: result.total })}</h3>
        <p className="mt-1 text-sm text-muted">{t("rollback.summary.detail", { restore: counts.restore, overwrite: counts.overwrite, delete: counts.delete })}</p>
        <ul className="mt-2 max-h-72 divide-y divide-line overflow-auto text-sm">
          {result.files.map((file) => (
            <li key={`${file.change}:${file.path}`} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0 break-all font-mono">{escapeUnsafe(file.path)}</span>
              <span className={`shrink-0 text-xs ${CHANGE_CLASS[file.change]}`}>{t(CHANGE_LABEL[file.change])}</span>
            </li>
          ))}
        </ul>
        {result.truncated && <p className="mt-1 text-xs text-muted">{t("rollback.truncated", { shown: result.files.length, total: result.total })}</p>}
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4 text-sm">
        <h3 className="font-semibold">{t("rollback.limits.title")}</h3>
        <ul className="mt-1 list-disc pl-5 text-muted">
          <li>{t("rollback.limits.work")}</li>
          <li>{t("rollback.limits.ignored")}</li>
          <li>{t("rollback.limits.external")}</li>
          <li>{t("rollback.limits.undo")}</li>
        </ul>
      </section>

      {result.agentRunning && (
        <p role="alert" className="rounded-lg bg-warn-bg px-3 py-2 text-sm font-semibold text-warn-fg">
          {t("rollback.agentRunning")}
        </p>
      )}

      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-danger">{t("rollback.confirm", { count: result.total })}</p>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" disabled={busy} onClick={onCancel} className="min-h-12 rounded-lg border border-line px-4 font-semibold disabled:opacity-40">
              {t("devices.cancel")}
            </button>
            <button type="button" disabled={busy || result.agentRunning} onClick={onConfirm} className="min-h-12 rounded-lg bg-danger px-4 font-semibold text-on-accent disabled:opacity-40">
              {busy ? t("rollback.applying") : t("rollback.confirm.yes")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={result.agentRunning} onClick={onAsk} className="min-h-12 rounded-lg border border-danger px-4 font-semibold text-danger disabled:opacity-40">
          {t("rollback.start")}
        </button>
      )}
    </>
  );
}

function Outcome({ result, machineId, onRetry }: { result: Exclude<RollbackResult, { outcome: "preview" }>; machineId: string; onRetry: () => void }) {
  const { t } = useI18n();
  if (result.outcome === "applied") {
    return (
      <section role="status" className="rounded-2xl border border-ok bg-surface p-4">
        <p className="font-semibold">{result.changed === 0 ? t("rollback.done.none") : t("rollback.done", { count: result.changed })}</p>
        {result.safetyCheckpointId && (
          <>
            <p className="mt-1 text-sm text-muted">{t("rollback.done.undo")}</p>
            <Link to={rollbackPath(machineId, result.safetyCheckpointId)} className="mt-2 inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold">
              {t("rollback.undo")}
            </Link>
          </>
        )}
      </section>
    );
  }
  if (result.outcome === "failed") {
    return (
      <section role="alert" className="rounded-2xl border border-danger bg-surface p-4">
        <p className="font-semibold">{t("rollback.failed")}</p>
        <p className="mt-1 text-sm">{escapeUnsafe(result.message)}</p>
        <p className="mt-1 text-sm text-muted">{result.recovered ? t("rollback.failed.recovered") : t("rollback.failed.notRecovered")}</p>
      </section>
    );
  }
  return (
    <section role="alert" className="rounded-2xl border border-line bg-surface p-4">
      <p className="font-semibold">{t("rollback.refused")}</p>
      <p className="mt-1 text-sm">{escapeUnsafe(result.message)}</p>
      {(result.reason === "preview_changed" || result.reason === "busy" || result.reason === "agent_running") && (
        <button type="button" onClick={onRetry} className="mt-2 min-h-11 rounded-lg border border-line px-4 text-sm">
          {t("rollback.refresh")}
        </button>
      )}
    </section>
  );
}
