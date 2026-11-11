// =====================================================================================
// FILE INI: lapisan i18n = "PENERJEMAH" teks aplikasi.
// =====================================================================================
//
// Semua teks yang dilihat pengguna diambil lewat `translate(locale, kunci, isian)`. Bahasa bawaan
// Indonesia (PRD §14). Pilihan bahasa disimpan di perangkat. Sengaja tanpa pustaka i18n: kebutuhannya
// hanya mengganti teks dan mengisi nilai, dan setiap kilobita ikut dihitung dalam batas 200 KB.
import { en } from "./en";
import { id, type MessageKey } from "./id";

export const LOCALES = ["id", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "id";
export const LOCALE_STORAGE_KEY = "agentmon.locale";

const dictionaries: Record<Locale, Record<MessageKey, string>> = { id, en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Bahasa yang dipilih pengguna, atau bahasa bawaan bila belum ada atau penyimpanan tidak bisa dipakai. */
export function loadLocale(storage: Pick<Storage, "getItem"> | undefined): Locale {
  try {
    const saved = storage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(saved) ? saved : DEFAULT_LOCALE;
  } catch {
    // Penyimpanan bisa melempar galat (mode privat, data situs diblokir). Aplikasi tetap jalan.
    return DEFAULT_LOCALE;
  }
}

export function saveLocale(storage: Pick<Storage, "setItem"> | undefined, locale: Locale): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // diabaikan: hanya kenyamanan
  }
}

export type Params = Record<string, string | number>;

/**
 * Mengambil teks untuk sebuah kunci dan mengisi {isian}-nya. Isian yang tidak diberi nilai dibiarkan
 * apa adanya (kelihatan salah, tidak diam-diam kosong). Kunci yang tidak ada di bahasa itu memakai
 * bahasa bawaan, dan bila di sana pun tidak ada, kuncinya sendiri yang ditampilkan.
 */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const template = dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
