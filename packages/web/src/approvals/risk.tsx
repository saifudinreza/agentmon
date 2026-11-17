// Penanda level risiko yang terbaca TANPA warna: kata ("Risiko tinggi") ditambah bentuk (▲ ◆ ●). Warna hanya penegas.
import type { RiskLevel } from "@agentmon/shared";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/id";

export const RISK_LABEL: Record<RiskLevel, MessageKey> = {
  high: "approval.risk.high",
  medium: "approval.risk.medium",
  low: "approval.risk.low",
};
const SHAPE: Record<RiskLevel, string> = { high: "▲", medium: "◆", low: "●" };

export function RiskBadge({ level }: { level: RiskLevel }) {
  const { t } = useI18n();
  return (
    <span className={level === "high" ? "font-semibold text-danger" : ""}>
      <span aria-hidden="true">{SHAPE[level]} </span>
      {t(RISK_LABEL[level])}
    </span>
  );
}

// Bagian perintah yang patut dilihat dua kali. Ini bantuan membaca, BUKAN penilai: penilai sebenarnya ada di laptop.
const DANGER = [
  /\brm\s+-\w*[rf]\w*/g,
  /\bsudo\b/g,
  /\b(?:curl|wget)\b[^|\n]{0,300}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/g,
  /\bgit\s+push\b[^\n]{0,300}(?:--force\b|\s-f\b)/g,
  /\bgit\s+reset\s+--hard\b/g,
  /\bchmod\s+(?:-R\s+)?7[0-7]{2}\b/g,
  /\b(?:mkfs|dd\s+if=)\S*/g,
  /\bdrop\s+(?:table|database)\b/gi,
  /(?:~|\$HOME)?\/?\.ssh\b|\bid_rsa\b|(?<![\w-])\.env\b/g,
];

export type Piece = { text: string; danger: boolean };

export function markDanger(text: string): Piece[] {
  const spans: [number, number][] = [];
  for (const pattern of DANGER) for (const m of text.matchAll(pattern)) spans.push([m.index, m.index + m[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  const pieces: Piece[] = [];
  let at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    if (from > at) pieces.push({ text: text.slice(at, from), danger: false });
    pieces.push({ text: text.slice(from, end), danger: true });
    at = end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), danger: false });
  return pieces;
}
