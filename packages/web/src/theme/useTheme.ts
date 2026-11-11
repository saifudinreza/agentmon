import { useCallback, useEffect, useState } from "react";
import { applyTheme, loadThemeMode, nextThemeMode, resolveTheme, saveThemeMode, type ThemeMode } from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Pilihan tema pengguna, dengan tema yang dipasang ke dokumen dan mengikuti perubahan pengaturan HP. */
export function useTheme(): { mode: ThemeMode; cycle(): void } {
  const [mode, setMode] = useState<ThemeMode>(() => loadThemeMode(storage()));

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const apply = () => applyTheme(document, resolveTheme(mode, query.matches));
    apply();
    // Pada mode otomatis, tema ikut berubah saat pengguna mengganti pengaturan HP (misalnya jadwal malam).
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [mode]);

  const cycle = useCallback(() => {
    setMode((current) => {
      const next = nextThemeMode(current);
      saveThemeMode(storage(), next);
      return next;
    });
  }, []);

  return { mode, cycle };
}
