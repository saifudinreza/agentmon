import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { navigate, normalizePath, usePath } from "./router";

function Path() {
  return <p data-testid="path">{usePath()}</p>;
}

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("normalizePath", () => {
  test.each([
    ["/", "/"],
    ["", "/"],
    ["/pair", "/pair"],
    ["/pair/", "/pair"],
    ["/pair///", "/pair"],
    ["///", "/"],
    ["/a/b/", "/a/b"],
  ])("%j -> %j", (input, expected) => expect(normalizePath(input)).toBe(expected));
});

describe("usePath dan navigate", () => {
  test("membaca jalur saat ini", () => {
    window.history.replaceState(null, "", "/pair/");
    render(<Path />);
    expect(screen.getByTestId("path").textContent).toBe("/pair");
  });

  test("navigate memperbarui komponen dan menambah catatan riwayat", () => {
    render(<Path />);
    const before = window.history.length;
    act(() => navigate("/pair"));
    expect(screen.getByTestId("path").textContent).toBe("/pair");
    expect(window.location.pathname).toBe("/pair");
    expect(window.history.length).toBe(before + 1);
  });

  test("navigate dengan replace tidak menambah catatan riwayat", () => {
    render(<Path />);
    const before = window.history.length;
    act(() => navigate("/pair", { replace: true }));
    expect(screen.getByTestId("path").textContent).toBe("/pair");
    expect(window.history.length).toBe(before);
  });

  test("tombol kembali browser (popstate) ikut memperbarui", () => {
    render(<Path />);
    act(() => navigate("/pair"));
    act(() => {
      window.history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  test("pendengar dilepas saat komponen dilepas (tidak bocor)", () => {
    const { unmount } = render(<Path />);
    unmount();
    expect(() => act(() => navigate("/pair"))).not.toThrow();
  });
});
