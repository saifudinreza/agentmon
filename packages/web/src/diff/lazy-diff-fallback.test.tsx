import type { FileDiff } from "@agentmon/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/react";
import { LazyDiffViewer } from "./LazyDiffViewer";

// Memuat penampil gagal (mis. offline dan kodenya belum tersimpan).
vi.mock("./DiffViewer", () => {
  throw new Error("gagal memuat penampil");
});

afterEach(() => cleanup());

const diff: FileDiff = { path: "a.ts", toolName: "Edit", sensitive: [], change: { type: "binary", isNew: false } };

describe("LazyDiffViewer: pemuatan gagal", () => {
  test("cadangan (teks biasa) tetap tampil dan layar tidak rusak", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(
        <I18nProvider>
          <LazyDiffViewer diffs={[diff]} fallback={<p>TEKS DIFF BIASA</p>} />
        </I18nProvider>,
      );
      await screen.findByText("TEKS DIFF BIASA");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByText("TEKS DIFF BIASA")).toBeTruthy();
    } finally {
      errors.mockRestore();
    }
  });
});
