// =====================================================================================
// FILE INI: penampil diff untuk layar HP = "KACA PEMBESAR" yang nyaman di layar kecil.
// =====================================================================================
//
// Dimuat BELAKANGAN (React.lazy) supaya tidak masuk bundle awal; selama belum siap, layar memakai teks diff biasa.
// Data hunk sudah terstruktur dari daemon, jadi tidak perlu pustaka diff pihak ketiga (lihat docs/web.md): tiap hunk
// adalah komponen sendiri yang nanti dipakai ulang untuk swipe per hunk (#040).
//
// Prinsip yang sama dengan layar keputusan: yang disetujui harus sama dengan yang terlihat. Karakter kontrol dan
// pembalik arah tulisan di baris ditampilkan sebagai kodenya (escapeUnsafe), bukan dibuang. Warna sintaks hanya
// bantuan baca; ia memecah teks yang SUDAH di-escape tanpa mengubah isinya.
import type { DiffHunk, FileDiff } from "@agentmon/shared";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { escapeUnsafe } from "../approvals/format";
import { useI18n } from "../i18n/react";
import { cleanLine } from "../timeline/describe";
import { languageOf, type Language } from "./language";
import type { TokenKind, tokenizeLine } from "./highlight";

/** Jumlah baris yang digambar sekaligus; sisanya lewat tombol (supaya diff sangat besar tidak membekukan HP). */
export const INITIAL_LINE_BUDGET = 1500;

type Highlighter = { tokenizeLine: typeof tokenizeLine };

const KIND_CLASS: Record<TokenKind, string> = {
  plain: "",
  keyword: "text-info font-semibold",
  string: "text-ok",
  comment: "italic text-muted",
  number: "text-warn-fg",
};

const ROW_CLASS = { add: "bg-ok/10", remove: "bg-danger/10", context: "" } as const;
const SIGN = { add: "+", remove: "-", context: " " } as const;

const Line = memo(function Line({
  type,
  oldLine,
  newLine,
  text,
  wrap,
  language,
  highlighter,
}: {
  type: "add" | "remove" | "context";
  oldLine: number | undefined;
  newLine: number | undefined;
  text: string;
  wrap: boolean;
  language: Language;
  highlighter: Highlighter | undefined;
}) {
  const { t } = useI18n();
  const shown = useMemo(() => escapeUnsafe(text), [text]);
  const tokens = useMemo(() => (highlighter ? highlighter.tokenizeLine(shown, language) : undefined), [highlighter, shown, language]);
  return (
    <div className={`flex font-mono text-[13px] leading-5 ${ROW_CLASS[type]}`}>
      <span aria-hidden="true" className="w-9 shrink-0 select-none pr-1 text-right text-xs tabular-nums text-muted">
        {oldLine ?? ""}
      </span>
      <span aria-hidden="true" className="w-9 shrink-0 select-none pr-1 text-right text-xs tabular-nums text-muted">
        {newLine ?? ""}
      </span>
      <span aria-hidden="true" className={`w-4 shrink-0 select-none text-center ${type === "add" ? "text-ok" : type === "remove" ? "text-danger" : ""}`}>
        {SIGN[type]}
      </span>
      {type !== "context" && <span className="sr-only">{type === "add" ? t("diffv.line.added") : t("diffv.line.removed")}</span>}
      <span className={wrap ? "min-w-0 whitespace-pre-wrap break-all" : "whitespace-pre"}>
        {tokens ? tokens.map((tok, i) => (tok.kind === "plain" ? tok.text : <span key={i} className={KIND_CLASS[tok.kind]}>{tok.text}</span>)) : shown}
      </span>
    </div>
  );
});

/** Satu hunk: judul "@@ -a,b +c,d @@" dan barisnya. Komponen mandiri supaya bisa dipakai ulang (swipe per hunk). */
export const Hunk = memo(function Hunk({
  hunk,
  index,
  total,
  wrap,
  language,
  highlighter,
  lineLimit,
}: {
  hunk: DiffHunk;
  index: number;
  total: number;
  wrap: boolean;
  language: Language;
  highlighter: Highlighter | undefined;
  /** Berapa baris hunk ini yang digambar (sisanya dipotong). */
  lineLimit: number;
}) {
  const { t } = useI18n();
  const lines = lineLimit >= hunk.lines.length ? hunk.lines : hunk.lines.slice(0, Math.max(0, lineLimit));
  return (
    <section id={`hunk-${hunk.id}`} aria-label={t("diffv.hunk.of", { n: index + 1, total })} className="rounded-lg border border-line [contain-intrinsic-size:auto_200px] [content-visibility:auto]">
      <h4 className="bg-bg px-2 py-1 font-mono text-xs text-muted">{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</h4>
      <div className={wrap ? "" : "overflow-x-auto"}>
        <div className={wrap ? "" : "w-max min-w-full"}>
          {lines.map((line, i) => (
            <Line key={i} type={line.type} oldLine={line.oldLine} newLine={line.newLine} text={line.text} wrap={wrap} language={language} highlighter={highlighter} />
          ))}
          {lines.length < hunk.lines.length && <p className="bg-warn-bg px-2 py-1 text-xs font-semibold text-warn-fg">{t("diffv.hunk.cut", { count: hunk.lines.length - lines.length })}</p>}
        </div>
      </div>
    </section>
  );
});

function scrollToHunk(id: string) {
  const el = document.getElementById(`hunk-${id}`);
  // jsdom tidak punya scrollIntoView; di browser, hunk menggulir ke atas layar.
  el?.scrollIntoView?.({ block: "start", behavior: "smooth" });
}

function FileView({ diff, highlighter }: { diff: FileDiff; highlighter: Highlighter | undefined }) {
  const { t } = useI18n();
  const [wrap, setWrap] = useState(true);
  const [budget, setBudget] = useState(INITIAL_LINE_BUDGET);
  const [active, setActive] = useState(0);
  const language = useMemo(() => languageOf(diff.path), [diff.path]);
  const change = diff.change;

  if (change.type !== "text") {
    const message =
      change.type === "binary"
        ? t("approval.diff.binary")
        : change.type === "unchanged"
          ? change.formatChanged
            ? t("approval.diff.formatOnly")
            : t("approval.diff.unchanged")
          : change.type === "too_large"
            ? t("approval.diff.tooLarge", { message: escapeUnsafe(change.message) })
            : t("approval.diff.mismatch", { message: escapeUnsafe(change.message) });
    return <p className="text-sm text-muted">{message}</p>;
  }

  const hunks = change.hunks;
  if (hunks.length === 0) return <p className="text-sm text-muted">{change.isNew ? t("diffv.emptyNew") : t("approval.diff.unchanged")}</p>;

  // Anggaran baris dibagi berurutan per hunk; hunk setelah anggaran habis tidak digambar sampai diminta.
  let left = budget;
  const limits = hunks.map((hunk) => {
    const take = Math.min(left, hunk.lines.length);
    left -= take;
    return take;
  });
  const hidden = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) - limits.reduce((a, b) => a + b, 0);

  const go = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), hunks.length - 1);
    setActive(clamped);
    const hunk = hunks[clamped];
    if (!hunk) return;
    // Hunk yang belum digambar (anggaran habis): naikkan anggaran sampai hunk itu tampil, baru gulir.
    if (limits[clamped] === 0) {
      const needed = hunks.slice(0, clamped + 1).reduce((sum, h) => sum + h.lines.length, 0);
      setBudget((b) => Math.max(b, needed));
      setTimeout(() => scrollToHunk(hunk.id), 0);
      return;
    }
    scrollToHunk(hunk.id);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="tabular-nums text-muted">
          <span className="text-ok">+{change.added}</span> <span className="text-danger">-{change.removed}</span>
          {change.isNew ? ` · ${t("diffv.newFile")}` : ""}
        </span>
        <label className="inline-flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} className="h-5 w-5" />
          {t("diffv.wrap")}
        </label>
      </div>

      {hidden > 0 && (
        <p role="status" className="rounded-lg bg-warn-bg px-3 py-1.5 text-sm font-semibold text-warn-fg">
          {t("diffv.hiddenNotice", { count: hidden })}
        </p>
      )}

      {hunks.length > 1 && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <button type="button" disabled={active === 0} onClick={() => go(active - 1)} className="min-h-11 rounded-lg border border-line px-3 disabled:opacity-40">
            {t("diffv.hunk.prev")}
          </button>
          <span aria-live="polite" className="tabular-nums text-muted">
            {t("diffv.hunk.of", { n: active + 1, total: hunks.length })}
          </span>
          <button type="button" disabled={active === hunks.length - 1} onClick={() => go(active + 1)} className="min-h-11 rounded-lg border border-line px-3 disabled:opacity-40">
            {t("diffv.hunk.next")}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {hunks.map((hunk, i) => (limits[i] === 0 ? null : <Hunk key={hunk.id} hunk={hunk} index={i} total={hunks.length} wrap={wrap} language={language} highlighter={highlighter} lineLimit={limits[i] as number} />))}
      </div>

      {hidden > 0 && (
        <button type="button" onClick={() => setBudget((b) => b + INITIAL_LINE_BUDGET)} className="min-h-11 rounded-lg border border-line px-3 text-sm">
          {t("diffv.more", { count: Math.min(hidden, INITIAL_LINE_BUDGET), hidden })}
        </button>
      )}
    </div>
  );
}

/**
 * Penampil diff. `diffs` boleh berisi beberapa berkas: ada navigasi antar berkas, dan di dalam berkas navigasi antar
 * hunk. Peringatan path sensitif ditampilkan paling atas untuk berkas yang sedang dilihat.
 */
export default function DiffViewer({ diffs }: { diffs: FileDiff[] }) {
  const { t } = useI18n();
  const [fileIndex, setFileIndex] = useState(0);
  const [highlighter, setHighlighter] = useState<Highlighter | undefined>();
  const alive = useRef(true);

  // Pewarna dimuat belakangan: diff sudah terbaca sebagai teks biasa sebelum ini selesai. Gagal memuat = tetap teks biasa.
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void import("./highlight")
      .then((mod) => {
        if (!cancelled && alive.current) setHighlighter({ tokenizeLine: mod.tokenizeLine });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, []);

  if (diffs.length === 0) return <p className="text-sm text-muted">{t("approval.diff.none")}</p>;
  const index = Math.min(fileIndex, diffs.length - 1);
  const diff = diffs[index] as FileDiff;

  return (
    <div className="flex flex-col gap-2" data-diff-viewer="agentmon">
      {diffs.length > 1 && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <button type="button" disabled={index === 0} onClick={() => setFileIndex(index - 1)} className="min-h-11 rounded-lg border border-line px-3 disabled:opacity-40">
            {t("diffv.file.prev")}
          </button>
          <span aria-live="polite" className="tabular-nums text-muted">
            {t("diffv.file.of", { n: index + 1, total: diffs.length })}
          </span>
          <button type="button" disabled={index === diffs.length - 1} onClick={() => setFileIndex(index + 1)} className="min-h-11 rounded-lg border border-line px-3 disabled:opacity-40">
            {t("diffv.file.next")}
          </button>
        </div>
      )}
      <p className="break-all text-sm font-medium">{escapeUnsafe(diff.path)}</p>
      {diff.sensitive.map((reason) => (
        <p key={reason.code} role="alert" className="rounded-lg bg-warn-bg px-3 py-1.5 text-sm font-semibold text-warn-fg">
          {t("approval.diff.sensitive", { reason: cleanLine(reason.message, 160) })}
        </p>
      ))}
      <FileView key={`${index}:${diff.path}`} diff={diff} highlighter={highlighter} />
    </div>
  );
}
