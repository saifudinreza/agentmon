import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { App } from "./App";
import { I18nProvider } from "./i18n/react";
import { stubMatchMedia, setOnline } from "./testing";
import { THEME_COLORS, THEME_STORAGE_KEY } from "./theme/theme";

function renderApp(locale?: "id" | "en") {
  return render(
    <I18nProvider {...(locale ? { initialLocale: locale } : {})}>
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.lang = "";
  window.localStorage.clear();
  setOnline(true);
});
afterEach(cleanup);

describe("tampilan dasar", () => {
  test("Bahasa Indonesia adalah bawaan, dan bahasa halaman ikut diatur", () => {
    stubMatchMedia(true);
    renderApp();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("AgentMon");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Belum ada laptop terpasang");
    expect(document.documentElement.lang).toBe("id");
  });

  test("bahasa Inggris tersedia lewat i18n dan mengubah lang halaman", () => {
    stubMatchMedia(true);
    renderApp("en");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("No laptop paired yet");
    expect(document.documentElement.lang).toBe("en");
  });

  test("pilihan bahasa yang tersimpan dipakai saat aplikasi dibuka lagi", () => {
    stubMatchMedia(true);
    window.localStorage.setItem("agentmon.locale", "en");
    renderApp();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("No laptop paired yet");
  });

  test("tidak ada teks Indonesia yang tertinggal saat bahasa Inggris dipilih", () => {
    stubMatchMedia(true);
    const { container } = renderApp("en");
    expect(container.textContent).not.toMatch(/Belum|laptop terpasang|Tema|Gelap|Terang|Otomatis/);
  });

  test("tombol dapat disentuh dengan nyaman (tinggi minimal 44 piksel) dan punya nama yang terbaca pembaca layar", () => {
    stubMatchMedia(true);
    renderApp();
    const button = screen.getByRole("button", { name: "Ganti tema" });
    expect(button.className).toContain("min-h-11"); // 2,75 rem = 44 piksel
  });
});

describe("offline", () => {
  test("pita offline muncul saat jaringan putus dan hilang saat kembali; kerangka tetap tampil", () => {
    stubMatchMedia(true);
    renderApp();
    expect(screen.queryByRole("status")).toBeNull();

    act(() => setOnline(false));
    expect(screen.getByRole("status").textContent).toContain("offline");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("AgentMon"); // kerangka tidak hilang

    act(() => setOnline(true));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("dibuka saat sudah offline: pita langsung tampil", () => {
    stubMatchMedia(true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    renderApp();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  test("pendengar event dilepas saat komponen dilepas (tidak bocor)", () => {
    stubMatchMedia(true);
    const { unmount } = renderApp();
    unmount();
    expect(() => act(() => setOnline(false))).not.toThrow();
  });
});

describe("tema", () => {
  test("mengikuti HP bila belum memilih: HP gelap -> gelap", () => {
    stubMatchMedia(true);
    renderApp();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("mengikuti HP bila belum memilih: HP terang -> terang, dan warna bilah status ikut", () => {
    stubMatchMedia(false);
    renderApp();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(THEME_COLORS.light);
  });

  test("tombol memutar pilihan: otomatis -> terang -> gelap -> otomatis, dan menyimpannya", () => {
    stubMatchMedia(true);
    renderApp();
    const button = () => screen.getByRole("button", { name: "Ganti tema" });
    expect(button().textContent).toBe("Tema: Otomatis");

    fireEvent.click(button());
    expect(button().textContent).toBe("Tema: Terang");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    fireEvent.click(button());
    expect(button().textContent).toBe("Tema: Gelap");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    fireEvent.click(button());
    expect(button().textContent).toBe("Tema: Otomatis");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  test("pilihan yang tersimpan dipulihkan saat aplikasi dibuka lagi, meski HP berkata lain", () => {
    stubMatchMedia(true); // HP gelap
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderApp();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("pada mode otomatis, tema ikut berubah saat pengaturan HP berubah", () => {
    const media = stubMatchMedia(false);
    renderApp();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    act(() => media.setDark(true));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("pada pilihan manual, perubahan pengaturan HP tidak mengganggu", () => {
    const media = stubMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderApp();
    act(() => media.setDark(true));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("pendengar pengaturan HP dilepas saat dilepas dan saat pilihan berganti (tidak menumpuk)", () => {
    const media = stubMatchMedia(true);
    const { unmount } = renderApp();
    expect(media.listenerCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Ganti tema" }));
    fireEvent.click(screen.getByRole("button", { name: "Ganti tema" }));
    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  test("penyimpanan yang tidak bisa dipakai (mode privat): aplikasi tetap terbuka dan tema tetap berganti", () => {
    stubMatchMedia(true);
    const original = Object.getOwnPropertyDescriptor(window, "localStorage") as PropertyDescriptor;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      renderApp();
      fireEvent.click(screen.getByRole("button", { name: "Ganti tema" }));
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });
});
