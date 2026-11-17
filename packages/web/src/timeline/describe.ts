// =====================================================================================
// FILE INI: menerjemahkan event menjadi tampilan = "JURU BAHASA" antara data mentah dan manusia.
// =====================================================================================
//
// Setiap jenis event punya tampilan sendiri (judul, keterangan, dan "nada" warna): permintaan izin menonjol,
// alat yang selesai tenang, kegagalan merah. Semua teks lewat i18n. Jenis event yang belum dikenal (dari
// versi daemon yang lebih baru) ditampilkan secara umum, tidak membuat layar gagal.
//
// KEAMANAN TAMPILAN: isi event berasal dari agent dan bisa memuat apa saja (nama berkas, perintah, pesan).
// Teks dibersihkan dari karakter kontrol dan pembalik arah tulisan (yang bisa memalsukan nama berkas),
// dijadikan satu baris, dan dipotong. React sendiri melepas HTML, jadi tidak ada risiko injeksi markup.
import { EventSchema, type Envelope } from "@agentmon/shared";
import type { MessageKey } from "../i18n/id";
import type { Params } from "../i18n/i18n";
import { PATH_KEYS, shortenPath } from "./path";
import { markdownToPlain } from "./plain";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info";

export type EventView = {
  /** Kunci judul dan isiannya; diterjemahkan oleh pemanggil dengan t(). */
  titleKey: MessageKey;
  titleParams?: Params;
  /** Keterangan satu baris (sudah dibersihkan dan dipotong). */
  detail?: string;
  /** Jalur berkas LENGKAP bila `detail` memuat versi ringkasnya; ditampilkan saat baris diketuk. */
  fullDetail?: string;
  tone: Tone;
};

// Karakter kontrol (C0, DEL, C1), pemisah baris Unicode, dan pembalik arah tulisan (U+202A-202E, U+2066-2069).
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/gu;

/** Satu baris yang aman ditampilkan: karakter berbahaya dibuang, spasi beruntun dirapatkan, dipotong dengan "…". */
export function cleanLine(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : "";
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(UNSAFE, "").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Sasaran alat yang paling berarti: berkas, perintah, pola, atau alamat.
// Jalur berkas diringkas untuk layar HP; `full` memuat jalur lengkap (sudah dibersihkan) supaya bisa ditampilkan saat baris diketuk.
function toolTarget(toolInput: Record<string, unknown>): { text: string; full?: string } | undefined {
  for (const key of ["file_path", "path", "notebook_path", "command", "pattern", "url", "query"]) {
    const value = toolInput[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    if (!PATH_KEYS.has(key)) return { text: cleanLine(value, 120) };
    const full = cleanLine(value, 500);
    const short = shortenPath(full);
    return short === full ? { text: full } : { text: short, full };
  }
  return undefined;
}

const RESOLVED_TITLE = {
  approved: "event.approval.resolved.approved",
  partially_approved: "event.approval.resolved.partially_approved",
  denied: "event.approval.resolved.denied",
  timed_out: "event.approval.resolved.timed_out",
  cancelled: "event.approval.resolved.cancelled",
} as const satisfies Record<string, MessageKey>;

const RESOLVED_TONE = { approved: "ok", partially_approved: "ok", denied: "bad", timed_out: "warn", cancelled: "neutral" } as const satisfies Record<string, Tone>;

export function describeEvent(envelope: Envelope): EventView {
  const parsed = EventSchema.safeParse(envelope);
  // Jenis yang belum dikenal, atau isinya tidak sesuai kontrak: tampilkan secara umum.
  if (!parsed.success) return { titleKey: "event.unknown", titleParams: { type: cleanLine(envelope.type, 60) }, tone: "neutral" };

  const event = parsed.data;
  switch (event.type) {
    case "session.started":
      return { titleKey: "event.session.started", detail: cleanLine(event.payload.cwd), tone: "info" };
    case "tool.requested": {
      const target = toolTarget(event.payload.toolInput);
      return { titleKey: "event.tool.requested", titleParams: { tool: cleanLine(event.payload.toolName, 60) }, ...(target ? { detail: target.text, ...(target.full ? { fullDetail: target.full } : {}) } : {}), tone: "neutral" };
    }
    case "tool.completed":
      return {
        titleKey: event.payload.ok ? "event.tool.completed.ok" : "event.tool.completed.failed",
        titleParams: { tool: cleanLine(event.payload.toolName, 60) },
        tone: event.payload.ok ? "neutral" : "bad",
      };
    case "approval.requested": {
      const summary = cleanLine(event.payload.summary);
      const target = toolTarget(event.payload.toolInput);
      const level = event.payload.risk?.level;
      return {
        titleKey: "event.approval.requested",
        titleParams: { tool: cleanLine(event.payload.toolName, 60) },
        detail: summary || target?.text || "",
        ...(!summary && target?.full ? { fullDetail: target.full } : {}),
        tone: level === "high" ? "bad" : "warn",
      };
    }
    case "approval.resolved": {
      const comment = cleanLine(event.payload.comment);
      return { titleKey: RESOLVED_TITLE[event.payload.status], ...(comment ? { detail: comment } : {}), tone: RESOLVED_TONE[event.payload.status] };
    }
    case "approval.auto_resolved":
      return {
        titleKey: event.payload.status === "auto_approved" ? "event.approval.auto_approved" : "event.approval.auto_denied",
        titleParams: { tool: cleanLine(event.payload.toolName, 60) },
        ...(event.payload.policy.ruleId ? { detail: cleanLine(event.payload.policy.ruleId, 80) } : {}),
        tone: event.payload.status === "auto_approved" ? "ok" : "bad",
      };
    case "agent.notification":
      return { titleKey: "event.agent.notification", detail: cleanLine(markdownToPlain(event.payload.title ? `${event.payload.title}: ${event.payload.message}` : event.payload.message)), tone: "info" };
    case "agent.stopped": {
      // Pesan akhir agent ditulis dalam markdown: tanda-tandanya dibuang supaya terbaca di layar HP.
      const last = cleanLine(markdownToPlain(event.payload.lastMessage), 200);
      return { titleKey: "event.agent.stopped", ...(last ? { detail: last } : {}), tone: "info" };
    }
    case "turn.review_requested":
      return { titleKey: "event.turn.review_requested", titleParams: { count: event.payload.files.length }, detail: cleanLine(event.payload.files.join(", ")), tone: "info" };
    case "checkpoint.created":
      return { titleKey: "event.checkpoint.created", tone: "neutral" };
    case "checkpoint.restored":
      return { titleKey: "event.checkpoint.restored", tone: "warn" };
    case "session.recap": {
      const minutes = Math.max(1, Math.round(event.payload.durationMs / 60_000));
      return {
        titleKey: "event.session.recap",
        titleParams: { minutes, files: event.payload.filesChanged.length, rejected: event.payload.rejected, auto: event.payload.autoApproved },
        tone: "info",
      };
    }
  }
}
