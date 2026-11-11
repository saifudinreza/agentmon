import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { applyTheme, isThemeMode, loadThemeMode, nextThemeMode, resolveTheme, saveThemeMode, THEME_COLORS, THEME_STORAGE_KEY, type ThemeMode } from "./theme";
import { stubMatchMedia } from "../testing";

describe("resolveTheme", () => {
  test.each([
    ["system", true, "dark"],
    ["system", false, "light"],
    ["light", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["dark", false, "dark"],
  ] as const)("pilihan %s, HP gelap=%s -> %s", (mode, prefersDark, expected) => {
    expect(resolveTheme(mode, prefersDark)).toBe(expected);
  });
});

describe("nextThemeMode", () => {
  test("berputar: otomatis, terang, gelap, lalu kembali ke otomatis", () => {
    expect(nextThemeMode("system")).toBe("light");
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("system");
  });
});

describe("menyimpan pilihan", () => {
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };

  test("tanpa pilihan tersimpan, mengikuti HP (system)", () => {
    expect(loadThemeMode({ getItem: () => null })).toBe("system");
    expect(loadThemeMode(undefined)).toBe("system");
  });

  test.each(["light", "dark", "system"] as const)("pilihan sah %s dipulihkan", (mode) => {
    expect(loadThemeMode({ getItem: () => mode })).toBe(mode);
  });

  test.each(["", "Dark", "blue", "constructor", "null"])("nilai tersimpan tidak sah (%j) diabaikan", (value) => {
    expect(loadThemeMode({ getItem: () => value })).toBe("system");
  });

  test("penyimpanan yang melempar galat tidak membuat aplikasi gagal", () => {
    expect(loadThemeMode(throwing)).toBe("system");
    expect(() => saveThemeMode(throwing, "dark")).not.toThrow();
    expect(() => saveThemeMode(undefined, "dark")).not.toThrow();
  });

  test("ditulis ke kunci yang benar", () => {
    const written: Array<[string, string]> = [];
    saveThemeMode({ setItem: (k, v) => void written.push([k, v]) }, "dark");
    expect(written).toEqual([[THEME_STORAGE_KEY, "dark"]]);
  });

  test("isThemeMode", () => {
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("auto")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#000000">';
    document.documentElement.removeAttribute("data-theme");
  });

  test.each(["light", "dark"] as const)("memasang data-theme dan warna bilah status untuk %s", (theme) => {
    applyTheme(document, theme);
    expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(THEME_COLORS[theme]);
  });

  test("tanpa meta theme-color tidak melempar galat", () => {
    document.head.innerHTML = "";
    expect(() => applyTheme(document, "dark")).not.toThrow();
  });
});

// Skrip kecil di index.html memasang tema SEBELUM halaman digambar (agar tidak berkedip), dengan
// logika yang ditulis ulang. Test ini menjalankan skrip itu apa adanya dan memastikan hasilnya SAMA
// dengan resolveTheme untuk semua kombinasi, supaya keduanya tidak menyimpang diam-diam.
describe("skrip tema di index.html sama dengan resolveTheme", () => {
  const html = readFileSync(join(__dirname, "..", "..", "index.html"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

  function runInlineScript(saved: string | null, prefersDark: boolean, storageThrows = false) {
    document.head.innerHTML = '<meta name="theme-color" content="#123456">';
    document.documentElement.removeAttribute("data-theme");
    stubMatchMedia(prefersDark);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => {
          if (storageThrows) throw new Error("SecurityError");
          return key === THEME_STORAGE_KEY ? saved : null;
        },
      },
    });
    new Function(script)();
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      color: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    };
  }

  test("skripnya ditemukan", () => {
    expect(script).toContain("agentmon.theme");
  });

  test.each([null, "system", "light", "dark", "rusak", ""])("tersimpan %j", (saved) => {
    for (const prefersDark of [true, false]) {
      const mode: ThemeMode = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
      const expected = resolveTheme(mode, prefersDark);
      const result = runInlineScript(saved, prefersDark);
      expect(result.theme, `HP gelap=${prefersDark}`).toBe(expected);
      expect(result.color).toBe(THEME_COLORS[expected]);
    }
  });

  test("penyimpanan yang melempar galat: mengikuti HP, tidak menghentikan skrip", () => {
    expect(runInlineScript(null, true, true).theme).toBe("dark");
    expect(runInlineScript(null, false, true).theme).toBe("light");
  });
});
