// Penghubung i18n ke React: komponen cukup memanggil `const { t } = useI18n()`.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadLocale, saveLocale, translate, type Locale, type Params } from "./i18n";
import type { MessageKey } from "./id";

type I18n = {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: MessageKey, params?: Params): string;
};

const I18nContext = createContext<I18n | undefined>(undefined);

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? loadLocale(safeLocalStorage()));

  // Bahasa halaman (dibaca pembaca layar dan browser) mengikuti bahasa yang dipilih.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    saveLocale(safeLocalStorage(), next);
  }, []);

  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (key, params) => translate(locale, key, params) }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n harus dipakai di dalam I18nProvider");
  return value;
}

// Mengakses localStorage bisa melempar galat di beberapa keadaan; bungkus supaya aplikasi tetap terbuka.
function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
