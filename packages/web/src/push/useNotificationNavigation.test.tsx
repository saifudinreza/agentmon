import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NAVIGATE_MESSAGE } from "./notification";
import { useNotificationNavigation } from "./useNotificationNavigation";

function Probe() {
  useNotificationNavigation();
  return null;
}

let container: EventTarget;
const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "serviceWorker");

beforeEach(() => {
  container = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  if (original) Object.defineProperty(Navigator.prototype, "serviceWorker", original);
});

const send = (data: unknown) => act(() => void container.dispatchEvent(new MessageEvent("message", { data })));

describe("useNotificationNavigation", () => {
  test("pesan dari service worker memindahkan layar tanpa memuat ulang", () => {
    render(<Probe />);
    send({ type: NAVIGATE_MESSAGE, path: "/a/m1/a1" });
    expect(window.location.pathname).toBe("/a/m1/a1");
    send({ type: NAVIGATE_MESSAGE, path: "/s/m1/s1" });
    expect(window.location.pathname).toBe("/s/m1/s1");
  });

  test.each([
    ["jalur ke situs lain", { type: NAVIGATE_MESSAGE, path: "//evil.example/x" }],
    ["alamat penuh", { type: NAVIGATE_MESSAGE, path: "https://evil.example/" }],
    ["jenis lain", { type: "lain", path: "/a/m1/a1" }],
    ["tanpa jalur", { type: NAVIGATE_MESSAGE }],
    ["bukan objek", "halo"],
    ["null", null],
  ])("pesan tidak sah diabaikan: %s", (_name, data) => {
    render(<Probe />);
    send(data);
    expect(window.location.pathname).toBe("/");
  });

  test("setelah komponen dilepas, pesan tidak lagi didengar", () => {
    const view = render(<Probe />);
    view.unmount();
    send({ type: NAVIGATE_MESSAGE, path: "/a/m1/a1" });
    expect(window.location.pathname).toBe("/");
  });

  test("browser tanpa service worker: tidak melempar galat", () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    expect(() => render(<Probe />)).not.toThrow();
  });
});
