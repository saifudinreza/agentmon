// =====================================================================================
// FILE INI: logika tema terang/gelap = "SAKLAR LAMPU" aplikasi.
// =====================================================================================
//
// Tiga pilihan pengguna: ikuti pengaturan HP ("system", bawaan), selalu terang, atau selalu gelap.
// Hasil akhirnya hanya dua: "light" atau "dark", yang dipasang sebagai atribut data-theme di <html>;
// CSS (styles.css) memilih warna berdasarkan atribut itu.
//
// Skrip kecil di index.html menjalankan logika yang SAMA sebelum halaman digambar (agar tidak
// berkedip). Kalau logika di sini diubah, ubah juga skrip itu; test theme.test.ts menjaga keduanya.
export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "agentmon.theme";
// Warna bilah status browser. Harus sama dengan latar di styles.css.
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#0b0f14", light: "#f6f7f9" };

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** Pilihan yang tersimpan, atau "system" bila belum ada atau penyimpanan tidak bisa dipakai. */
export function loadThemeMode(storage: Pick<Storage, "getItem"> | undefined): ThemeMode {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeMode(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function saveThemeMode(storage: Pick<Storage, "setItem"> | undefined, mode: ThemeMode): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // diabaikan: hanya kenyamanan
  }
}

/** Tema yang benar-benar dipakai, dari pilihan pengguna dan pengaturan HP. */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

/** Urutan saat tombol tema ditekan: otomatis, terang, gelap, lalu kembali ke otomatis. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length] as ThemeMode;
}

/** Memasang tema ke dokumen: atribut data-theme dan warna bilah status browser. */
export function applyTheme(doc: Document, theme: ResolvedTheme): void {
  doc.documentElement.setAttribute("data-theme", theme);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}
