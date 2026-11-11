import { describe, expect, test } from "vitest";
import { USER_AGENTS } from "../testing";
import { defaultDeviceName, detectPlatform } from "./platform";

describe("detectPlatform", () => {
  test.each([
    ["iPhone Safari", { userAgent: USER_AGENTS.iphoneSafari }, { isIos: true, isAndroid: false }],
    ["iPad", { userAgent: USER_AGENTS.ipad }, { isIos: true, isAndroid: false }],
    // iPadOS 13+ menyamar sebagai Mac; yang membedakan hanyalah layar sentuhnya.
    ["iPad mode desktop", { userAgent: USER_AGENTS.ipadDesktopMode, platform: "MacIntel", maxTouchPoints: 5 }, { isIos: true, isAndroid: false }],
    ["Mac sungguhan (tanpa layar sentuh)", { userAgent: USER_AGENTS.macSafari, platform: "MacIntel", maxTouchPoints: 0 }, { isIos: false, isAndroid: false }],
    ["Android Chrome", { userAgent: USER_AGENTS.androidChrome }, { isIos: false, isAndroid: true }],
    ["Windows Chrome", { userAgent: USER_AGENTS.windowsChrome }, { isIos: false, isAndroid: false }],
  ])("%s", (_name, nav, expected) => {
    expect(detectPlatform(nav)).toMatchObject(expected);
  });

  test("aplikasi layar utama iOS dikenali lewat navigator.standalone", () => {
    expect(detectPlatform({ userAgent: USER_AGENTS.iphoneSafari, standalone: true }).isStandalone).toBe(true);
    expect(detectPlatform({ userAgent: USER_AGENTS.iphoneSafari, standalone: false }).isStandalone).toBe(false);
    expect(detectPlatform({ userAgent: USER_AGENTS.iphoneSafari }).isStandalone).toBe(false);
  });

  test("aplikasi terpasang di Android dikenali lewat display-mode: standalone", () => {
    expect(detectPlatform({ userAgent: USER_AGENTS.androidChrome }, true).isStandalone).toBe(true);
    expect(detectPlatform({ userAgent: USER_AGENTS.androidChrome }, false).isStandalone).toBe(false);
  });
});

describe("defaultDeviceName", () => {
  test.each([
    [{ userAgent: USER_AGENTS.iphoneSafari }, "iPhone"],
    [{ userAgent: USER_AGENTS.ipad }, "iPad"],
    [{ userAgent: USER_AGENTS.ipadDesktopMode, platform: "MacIntel", maxTouchPoints: 5 }, "iPad"],
    [{ userAgent: USER_AGENTS.androidChrome }, "Android"],
    [{ userAgent: USER_AGENTS.windowsChrome }, "Perangkat ini"],
    [{ userAgent: "" }, "Perangkat ini"],
  ])("%j -> %s", (nav, expected) => {
    expect(defaultDeviceName(nav)).toBe(expected);
  });
});
