import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/react";
import { savePairing } from "../pairing/storage";
import { RelayApiError } from "../relay/api";
import { fakeRelay } from "../relay/fake-relay";
import { createRelayStore } from "../relay/relay-store";
import { RelayProvider, type RelayStoreFactory } from "../relay/RelayProvider";
import { USER_AGENTS } from "../testing";
import { setupPush } from "../push/testing";
import { detectEnvironment, type DeviceEnvironment, type Support } from "./environment";
import { buildGuide } from "./guide";
import { errorKey, Onboarding } from "./Onboarding";

const FULL: Support = { serviceWorker: true, pushManager: true, notification: true };
const NONE: Support = { serviceWorker: false, pushManager: false, notification: false };
const UA = {
  ...USER_AGENTS,
  ios15: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.7 Mobile/15E148 Safari/604.1",
  ios164: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
  iosInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0",
  androidWebView: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36",
  androidSamsung: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0",
};
const detect = (userAgent: string, extra: { standalone?: boolean; support?: Support; platform?: string; maxTouchPoints?: number } = {}) =>
  detectEnvironment({ userAgent, ...(extra.platform ? { platform: extra.platform } : {}), ...(extra.maxTouchPoints ? { maxTouchPoints: extra.maxTouchPoints } : {}), ...(extra.standalone !== undefined ? { standalone: extra.standalone } : {}), support: extra.support ?? FULL });

describe("detectEnvironment", () => {
  test.each([
    [UA.iphoneSafari, "ios", "safari"],
    [UA.iosChrome, "ios", "chrome"],
    [UA.iosInstagram, "ios", "inapp"],
    [UA.androidChrome, "android", "chrome"],
    [UA.androidWebView, "android", "inapp"],
    [UA.androidSamsung, "android", "samsung"],
    [UA.androidFirefox, "android", "firefox"],
    [UA.windowsChrome, "desktop", "chrome"],
    [UA.macSafari, "desktop", "safari"],
  ] as const)("%s", (ua, os, browser) => {
    const env = detect(ua);
    expect([env.os, env.browser]).toEqual([os, browser]);
  });

  test("UA app layar utama iOS (tanpa Safari/ dan Version/) tetap dikenali sebagai Safari, jadi tidak diberi catatan 'pasang lewat Safari'", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    const env = detect(ua, { standalone: true });
    expect(env.browser).toBe("safari");
    expect(buildGuide(env, paired).notes).toEqual([]);
  });

  test("versi iOS dibaca, dan iPad bertampilan desktop tetap dikenali sebagai iOS", () => {
    expect(detect(UA.iphoneSafari).iosVersion).toEqual({ major: 17, minor: 4 });
    expect(detect(UA.ios15).iosVersion).toEqual({ major: 15, minor: 7 });
    const ipad = detect(UA.ipadDesktopMode, { platform: "MacIntel", maxTouchPoints: 5 });
    expect(ipad.os).toBe("ios");
    expect(ipad.iosVersion).toEqual({ major: 17, minor: 4 });
  });

  test("terpasang: dari navigator.standalone (iOS)", () => {
    expect(detect(UA.iphoneSafari, { standalone: true }).installed).toBe(true);
    expect(detect(UA.iphoneSafari).installed).toBe(false);
  });
});

const paired = { paired: true, notifying: false, tested: false };
const unpaired = { paired: false, notifying: false, tested: false };
const state = (env: DeviceEnvironment, progress = paired) => Object.fromEntries(buildGuide(env, progress).steps.map((s) => [s.id, s.state]));

describe("buildGuide", () => {
  test("iOS di tab Safari: notifikasi TERKUNCI walau sudah berpasangan (FR-55), pasang adalah langkah sekarang", () => {
    const env = detect(UA.iphoneSafari, { support: NONE });
    const guide = buildGuide(env, paired);
    expect(state(env)).toMatchObject({ install: "current", notify: "locked", test: "locked" });
    expect(guide.blocker).toBeUndefined(); // tidak adanya PushManager di tab Safari bukan penghalang
    expect(guide.current).toBe("install");
  });

  test("iOS terpasang: notifikasi terbuka; setelah aktif, uji menjadi langkah sekarang; setelah uji, tidak ada langkah tersisa", () => {
    const env = detect(UA.iphoneSafari, { standalone: true });
    expect(state(env)).toMatchObject({ install: "done", pair: "done", notify: "current", test: "locked" });
    expect(state(env, { paired: true, notifying: true, tested: false })).toMatchObject({ notify: "done", test: "current" });
    const finished = buildGuide(env, { paired: true, notifying: true, tested: true });
    expect(finished.current).toBeUndefined();
    expect(finished.steps.every((s) => s.state === "done")).toBe(true);
  });

  test("iOS terpasang tetapi belum berpasangan: pairing dulu, notifikasi terkunci", () => {
    const env = detect(UA.iphoneSafari, { standalone: true });
    expect(state(env, unpaired)).toMatchObject({ pair: "current", notify: "locked" });
  });

  test("Android: memasang hanya saran (opsional), langkah sekarang langsung pairing", () => {
    const env = detect(UA.androidChrome);
    const guide = buildGuide(env, unpaired);
    expect(guide.steps.find((s) => s.id === "install")).toMatchObject({ optional: true, state: "todo" });
    expect(guide.current).toBe("pair");
    expect(buildGuide(env, paired).current).toBe("notify");
  });

  test("penghalang: browser di dalam aplikasi, iOS di bawah 16.4, browser tanpa push; 16.4 pas tidak terhalang", () => {
    expect(buildGuide(detect(UA.iosInstagram), paired).blocker).toBe("inapp");
    expect(buildGuide(detect(UA.androidWebView), paired).blocker).toBe("inapp");
    expect(buildGuide(detect(UA.ios15, { standalone: true }), paired).blocker).toBe("ios-too-old");
    expect(buildGuide(detect(UA.ios164, { standalone: true }), paired).blocker).toBeUndefined();
    expect(buildGuide(detect(UA.androidChrome, { support: NONE }), paired).blocker).toBe("no-push");
    expect(buildGuide(detect(UA.androidChrome, { support: { ...FULL, pushManager: false } }), paired).blocker).toBe("no-push");
  });

  test("versi iOS tidak diketahui: tidak dianggap terlalu lama (jangan menghalangi tanpa bukti)", () => {
    const env = detect("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148", { standalone: true });
    expect(env.os).toBe("ios");
    expect(env.iosVersion).toBeUndefined();
    expect(buildGuide(env, paired).blocker).toBeUndefined();
  });

  test("terhalang: notifikasi dan uji tetap terkunci, dan memasang tidak ditunjuk", () => {
    const env = detect(UA.ios15, { standalone: true });
    const guide = buildGuide(env, paired);
    expect(guide.steps.find((s) => s.id === "notify")?.state).toBe("locked");
    expect(guide.steps.find((s) => s.id === "test")?.state).toBe("locked");
    expect(guide.current).toBeUndefined();
    expect(buildGuide(detect(UA.iosInstagram), unpaired).current).toBe("pair");
  });

  test("catatan: iOS bukan Safari, dan komputer", () => {
    expect(buildGuide(detect(UA.iosChrome), paired).notes).toEqual(["ios-browser"]);
    expect(buildGuide(detect(UA.windowsChrome), paired).notes).toEqual(["desktop"]);
    expect(buildGuide(detect(UA.iphoneSafari), paired).notes).toEqual([]);
  });
});

describe("errorKey", () => {
  test.each([
    ["not-found", "guide.step.test.error.notFound"],
    ["rate-limited", "guide.step.test.error.rateLimited"],
    ["unreachable", "guide.step.test.error.unreachable"],
    ["server", "guide.step.test.error.server"],
    ["unauthorized", "guide.step.test.error.other"],
  ] as const)("%s", (kind, key) => expect(errorKey(new RelayApiError(kind))).toBe(key));
  test("galat tak dikenal", () => expect(errorKey(new Error("x"))).toBe("guide.step.test.error.other"));
});

// ---- Tampilan ----
let relay: ReturnType<typeof fakeRelay>;
const factory: RelayStoreFactory = (pairing) =>
  createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: relay.api,
    connect: () => ({ reconnectNow: vi.fn(), send: vi.fn(() => true), status: () => "online", close: vi.fn() }),
  });

function pairLaptop() {
  savePairing(window.localStorage, { relayUrl: "https://relay.contoh.com", deviceId: "d1", deviceToken: "d".repeat(64), machine: { id: "m1", name: "Laptop", pairedAt: "2026-11-01T00:00:00.000Z" } });
}

function renderGuide(env: DeviceEnvironment, push: Parameters<typeof setupPush>[0] = {}) {
  const setup = setupPush(push);
  render(
    <I18nProvider>
      <RelayProvider factory={factory}>
        <Onboarding env={env} pushEnv={setup.env} />
      </RelayProvider>
    </I18nProvider>,
  );
  return setup;
}

beforeEach(() => {
  window.localStorage.clear();
  relay = fakeRelay();
});
afterEach(cleanup);

describe("layar panduan", () => {
  test("iOS di tab Safari: tombol notifikasi TIDAK ada dan izin tidak pernah diminta; langkah memasang ditampilkan", async () => {
    pairLaptop();
    const setup = renderGuide(detect(UA.iphoneSafari, { support: NONE }), { platform: { isIos: true, isAndroid: false, isStandalone: false }, permission: "default" });
    expect(screen.getByText(/Tambahkan ke Layar Utama/)).toBeTruthy();
    expect(screen.getByText(/tombolnya sengaja belum ditampilkan/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kirim notifikasi uji" })).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(setup.requestPermission).not.toHaveBeenCalled();
  });

  test("iOS dari layar utama: aktifkan notifikasi, lalu kirim notifikasi uji lewat relay", async () => {
    pairLaptop();
    const setup = renderGuide(detect(UA.iphoneSafari, { standalone: true }), { platform: { isIos: true, isAndroid: false, isStandalone: true }, permission: "default", asks: "granted" });
    expect(screen.getByText("Aktifkan notifikasi dulu.")).toBeTruthy(); // langkah uji masih terkunci
    fireEvent.click(await screen.findByRole("button", { name: "Aktifkan notifikasi" }));
    expect(setup.requestPermission).toHaveBeenCalledTimes(1);
    const send = await screen.findByRole("button", { name: "Kirim notifikasi uji" });
    expect(relay.api.sendTestPush).not.toHaveBeenCalled(); // tidak otomatis
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByText(/Terkirim\. Notifikasi akan muncul/)).toBeTruthy());
    expect(relay.api.sendTestPush).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Semua siap/)).toBeTruthy();
    expect(screen.getByText(/Tidak muncul\?/)).toBeTruthy();
  });

  test("uji gagal: pesan sesuai penyebab, dan bisa dicoba lagi", async () => {
    pairLaptop();
    relay.fail.pushTest = new RelayApiError("not-found");
    renderGuide(detect(UA.androidChrome), { platform: { isIos: false, isAndroid: true, isStandalone: false }, permission: "default", asks: "granted" });
    fireEvent.click(await screen.findByRole("button", { name: "Aktifkan notifikasi" }));
    fireEvent.click(await screen.findByRole("button", { name: "Kirim notifikasi uji" }));
    await waitFor(() => expect(screen.getByText(/belum berlangganan/)).toBeTruthy());
    expect(screen.queryByText(/Semua siap/)).toBeNull();
    delete relay.fail.pushTest;
    fireEvent.click(screen.getByRole("button", { name: "Kirim notifikasi uji" }));
    await waitFor(() => expect(screen.getByText(/Semua siap/)).toBeTruthy());
  });

  test("dua ketukan cepat pada tombol uji hanya mengirim satu", async () => {
    pairLaptop();
    renderGuide(detect(UA.androidChrome), { platform: { isIos: false, isAndroid: true, isStandalone: false }, permission: "default", asks: "granted" });
    fireEvent.click(await screen.findByRole("button", { name: "Aktifkan notifikasi" }));
    const send = await screen.findByRole("button", { name: "Kirim notifikasi uji" });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    await waitFor(() => expect(screen.getByText(/^Terkirim. Notifikasi/)).toBeTruthy());
    expect(relay.api.sendTestPush).toHaveBeenCalledTimes(1);
  });

  test("browser di dalam aplikasi: penjelasan keterbatasan, tanpa tombol notifikasi", () => {
    pairLaptop();
    renderGuide(detect(UA.iosInstagram, { support: NONE }));
    expect(screen.getByRole("alert").textContent).toMatch(/Buka di browser dulu/);
    expect(screen.getByRole("alert").textContent).toMatch(/Safari/);
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
  });

  test("iOS lama: penjelasan versi, aplikasi tetap bisa dipakai", () => {
    pairLaptop();
    renderGuide(detect(UA.ios15, { standalone: true }));
    expect(screen.getByRole("alert").textContent).toMatch(/iOS 16\.4.*15\.7/);
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
  });

  test("belum berpasangan: petunjuk pairing, notifikasi terkunci", () => {
    renderGuide(detect(UA.androidChrome));
    expect(screen.getByText("Pasangkan laptop dulu.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aktifkan notifikasi" })).toBeNull();
  });

  test("langkah yang sedang dikerjakan ditandai aria-current", () => {
    pairLaptop();
    renderGuide(detect(UA.iphoneSafari, { support: NONE }));
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toMatch(/Pasang ke layar utama/);
  });
});
