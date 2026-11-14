// =====================================================================================
// FILE INI: tampilan ringkasan perubahan = "LEMBAR RINGKAS" di atas diff.
// =====================================================================================
//
// Ringkasan DATA dari daemon (deterministik, tanpa AI) disusun menjadi kalimat lewat i18n. Komponen ini ikut bundle awal
// (tidak lazy), jadi ringkasan terbaca tanpa memuat penampil diff. Hanya hal yang terbukti dari diff yang ditulis:
// berkas, jumlah baris, hunk, dan deklarasi yang BARIS deklarasinya sendiri berubah. Tidak ada klaim tentang maksud
// perubahan, dan ada catatan jelas tentang itu.
import type { Declaration, DiffSummary, FileSummary } from "@agentmon/shared";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/id";
import { escapeUnsafe } from "./format";

const KIND_KEY: Record<Declaration["kind"], MessageKey> = { function: "summary.kind.function", class: "summary.kind.class", type: "summary.kind.type" };
const STATUS_KEY: Record<Declaration["status"], MessageKey> = { added: "summary.status.added", removed: "summary.status.removed", changed: "summary.status.changed" };

function FileLine({ file }: { file: FileSummary }) {
  const { t } = useI18n();
  const path = escapeUnsafe(file.path);
  const params = { path, added: file.added ?? 0, removed: file.removed ?? 0, hunks: file.hunks ?? 0 };
  const line = (() => {
    switch (file.change) {
      case "modified":
        return t("summary.file.modified", params);
      case "new":
        return t("summary.file.new", params);
      case "unchanged":
        return t("summary.file.unchanged", params);
      case "format_only":
        return t("summary.file.formatOnly", params);
      case "binary":
        return t("summary.file.binary", params);
      case "too_large":
        return file.added !== undefined ? t("summary.file.tooLargeCounts", params) : t("summary.file.tooLarge", params);
      case "mismatch":
        return t("summary.file.mismatch", params);
    }
  })();
  const declarations = file.declarations ?? [];
  const textual = file.change === "modified" || file.change === "new";
  return (
    <li className="py-1.5">
      <p className="break-all">{line}</p>
      {declarations.length > 0 && (
        <p className="mt-0.5 text-muted">
          {t("summary.decl")}{" "}
          {declarations.map((d, i) => (
            <span key={`${d.kind}:${d.name}`}>
              {i > 0 ? ", " : ""}
              {t("summary.decl.item", { kind: t(KIND_KEY[d.kind]), name: escapeUnsafe(d.name), status: t(STATUS_KEY[d.status]) })}
            </span>
          ))}
          {file.moreDeclarations ? `, ${t("summary.decl.more")}` : ""}
        </p>
      )}
      {textual && file.language === undefined && <p className="mt-0.5 text-xs text-muted">{t("summary.unknownLanguage")}</p>}
      {textual && file.language !== undefined && <p className="mt-0.5 text-xs text-muted">{t("summary.decl.caveat")}</p>}
    </li>
  );
}

export function DiffSummaryView({ summary }: { summary: DiffSummary }) {
  const { t } = useI18n();
  if (summary.files.length === 0) return null;
  return (
    <div className="text-sm">
      <p className="font-medium">{summary.moreFiles ? t("summary.countMore", { count: summary.files.length }) : t("summary.count", { count: summary.files.length })}</p>
      <ul className="divide-y divide-line">
        {summary.files.map((file, i) => (
          <FileLine key={`${i}:${file.path}`} file={file} />
        ))}
      </ul>
      {summary.moreFiles && <p className="text-muted">{t("summary.moreFiles")}</p>}
      <p className="mt-2 text-xs text-muted">{t("summary.note")}</p>
    </div>
  );
}
