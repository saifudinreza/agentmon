import { describe, expect, test } from "vitest";
import { en } from "./en";
import { DEFAULT_LOCALE, isLocale, LOCALE_STORAGE_KEY, loadLocale, saveLocale, translate } from "./i18n";
import { id } from "./id";

describe("kamus", () => {
  test("Inggris punya SEMUA kunci Indonesia, tidak kurang dan tidak lebih", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(id).sort());
  });

  test("tidak ada teks kosong di bahasa mana pun", () => {
    for (const dictionary of [id, en]) for (const [key, text] of Object.entries(dictionary)) expect(text.trim(), key).not.toBe("");
  });

  test("isian {nama} di Inggris sama dengan di Indonesia untuk tiap kunci (tidak ada isian yang terlewat)", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(id) as Array<keyof typeof id>) expect(placeholders(en[key]), key).toEqual(placeholders(id[key]));
  });
});

describe("translate", () => {
  test("bahasa bawaan Indonesia", () => {
    expect(DEFAULT_LOCALE).toBe("id");
    expect(translate("id", "empty.title")).toBe("Belum ada laptop terpasang");
    expect(translate("en", "empty.title")).toBe("No laptop paired yet");
  });

  test("mengisi {isian} dengan teks maupun angka", () => {
    expect(translate("id", "theme.label", { mode: "Gelap" })).toBe("Tema: Gelap");
    expect(translate("en", "theme.label", { mode: 5 })).toBe("Theme: 5");
  });

  test("isian yang tidak diberi nilai dibiarkan apa adanya, bukan diam-diam kosong", () => {
    expect(translate("id", "theme.label", {})).toBe("Tema: {mode}");
    expect(translate("id", "theme.label")).toBe("Tema: {mode}");
  });

  test("nilai isian yang berisi kurung kurawal tidak diproses lagi (tidak ada injeksi)", () => {
    expect(translate("id", "theme.label", { mode: "{mode}" })).toBe("Tema: {mode}");
  });

  test("kunci yang tidak ada ditampilkan apa adanya, bukan melempar galat", () => {
    expect(translate("id", "kunci.tidak.ada" as never)).toBe("kunci.tidak.ada");
  });

  test("kunci yang hilang di satu bahasa memakai bahasa bawaan", () => {
    const original = en["empty.title"];
    delete (en as Partial<typeof en>)["empty.title"];
    try {
      expect(translate("en", "empty.title")).toBe("Belum ada laptop terpasang");
    } finally {
      en["empty.title"] = original;
    }
  });
});

describe("memilih dan menyimpan bahasa", () => {
  const storageWith = (value: string | null) => ({ getItem: () => value });
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };

  test("tanpa pilihan tersimpan, bahasa Indonesia", () => {
    expect(loadLocale(storageWith(null))).toBe("id");
    expect(loadLocale(undefined)).toBe("id");
  });

  test("pilihan tersimpan yang sah dipakai", () => {
    expect(loadLocale(storageWith("en"))).toBe("en");
  });

  test.each(["fr", "", "EN", "id ", "__proto__", "constructor"])("nilai tersimpan yang tidak sah (%j) diabaikan", (value) => {
    expect(loadLocale(storageWith(value))).toBe("id");
  });

  test("penyimpanan yang melempar galat (mode privat) tidak membuat aplikasi gagal", () => {
    expect(loadLocale(throwing)).toBe("id");
    expect(() => saveLocale(throwing, "en")).not.toThrow();
    expect(() => saveLocale(undefined, "en")).not.toThrow();
  });

  test("saveLocale menulis ke kunci yang benar", () => {
    const written: Array<[string, string]> = [];
    saveLocale({ setItem: (k, v) => void written.push([k, v]) }, "en");
    expect(written).toEqual([[LOCALE_STORAGE_KEY, "en"]]);
  });

  test("isLocale", () => {
    expect(isLocale("id")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
});
