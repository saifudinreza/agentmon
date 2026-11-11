// Format waktu untuk tampilan, mengikuti bahasa yang dipilih. Nilai yang bukan tanggal sah menjadi teks kosong,
// bukan "Invalid Date" di layar.
import type { Locale } from "../i18n/i18n";

function toDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Jam saja, misalnya "10.45.12", untuk baris timeline. */
export function formatClock(iso: string, locale: Locale): string {
  const date = toDate(iso);
  return date ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

/** Jam dan menit; ditambah tanggal bila bukan hari ini, misalnya "10.45" atau "10 Nov, 10.45". */
export function formatWhen(iso: string, locale: Locale, now: Date = new Date()): string {
  const date = toDate(iso);
  if (!date) return "";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? time : `${date.toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${time}`;
}
