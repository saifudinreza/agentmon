import type { Envelope } from "@agentmon/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { I18nProvider } from "../i18n/react";
import { describeEvent } from "./describe";
import { EventRow } from "./EventRow";
import { MAX_SHORT_PATH, shortenPath } from "./path";

afterEach(cleanup);

describe("shortenPath", () => {
  test("jalur yang sudah pendek tidak berubah", () => {
    for (const p of ["a.ts", "src/a.ts", "C:\\Proj\\a.ts", "/work/proj/src/a.ts"]) expect(shortenPath(p)).toBe(p);
    expect(shortenPath("x".repeat(MAX_SHORT_PATH))).toBe("x".repeat(MAX_SHORT_PATH));
  });

  test("jalur panjang menjadi dua bagian terakhir dengan awalan …/", () => {
    expect(shortenPath("/home/pengguna/proyek-besar/packages/web/src/timeline/EventRow.tsx")).toBe("…/timeline/EventRow.tsx");
    expect(shortenPath("C:\\Users\\Pengguna\\Dokumen\\proyek-besar\\packages\\web\\src\\timeline\\EventRow.tsx")).toBe("…\\timeline\\EventRow.tsx");
  });

  test("bila dua bagian terakhir pun terlalu panjang: hanya nama berkas; bila nama pun terlalu panjang: dipotong di tengah", () => {
    const longDir = "d".repeat(40);
    expect(shortenPath(`/a/b/c/${longDir}/berkas.ts`)).toBe("…/berkas.ts");
    const longName = `${"n".repeat(60)}.ts`;
    const out = shortenPath(`/a/b/c/${longName}`);
    expect(out.length).toBeLessThanOrEqual(MAX_SHORT_PATH);
    expect(out.startsWith("…/")).toBe(true);
    expect(out).toContain("…");
    expect(out.endsWith(".ts")).toBe(true);
  });

  test("satu bagian yang sangat panjang dipotong di tengah, tidak melebihi batas", () => {
    const out = shortenPath("z".repeat(500));
    expect(out.length).toBeLessThanOrEqual(MAX_SHORT_PATH);
    expect(out).toContain("…");
  });

  test.each(["", "/", "\\", "//", "...", "a/b", ".env", "/".repeat(300), "\\".repeat(300), `${"a/".repeat(200)}b`, "é".repeat(300)])("masukan aneh %# tidak melempar dan tidak melebihi batas", (input) => {
    const out = shortenPath(input);
    expect(out.length).toBeLessThanOrEqual(Math.max(MAX_SHORT_PATH, input.length <= MAX_SHORT_PATH ? input.length : 0));
  });

  test("nama berkas terakhir selalu terlihat (yang penting untuk dikenali)", () => {
    for (const name of [".env", "id_rsa", "settings.json", "pre-commit"]) {
      expect(shortenPath(`/very/long/path/that/goes/on/and/on/and/on/for/a/while/${name}`).endsWith(name)).toBe(true);
    }
  });
});

const LONG = "/home/pengguna/proyek-besar/packages/web/src/timeline/EventRow.tsx";
const envelope = (type: string, payload: Record<string, unknown>): Envelope =>
  ({ v: 1, id: "11111111-1111-4111-8111-111111111111", machineId: "m1", sessionId: "s1", seq: 0, ts: "2026-11-15T10:00:00.000Z", agent: "claude-code", type, payload }) as unknown as Envelope;

describe("timeline: jalur berkas", () => {
  test("tool.requested menampilkan jalur ringkas dan menyimpan jalur lengkap", () => {
    const view = describeEvent(envelope("tool.requested", { toolName: "Write", toolInput: { file_path: LONG, content: "x" } }));
    expect(view.detail).toBe("…/timeline/EventRow.tsx");
    expect(view.fullDetail).toBe(LONG);
  });

  test("jalur pendek tidak punya fullDetail; perintah panjang tidak diperlakukan sebagai jalur", () => {
    expect(describeEvent(envelope("tool.requested", { toolName: "Write", toolInput: { file_path: "src/a.ts" } })).fullDetail).toBeUndefined();
    const command = `echo ${"x".repeat(200)}`;
    const view = describeEvent(envelope("tool.requested", { toolName: "Bash", toolInput: { command } }));
    expect(view.fullDetail).toBeUndefined();
    expect(view.detail?.endsWith("…")).toBe(true);
  });

  test("approval.requested memakai jalur ringkas hanya bila tidak ada ringkasan", () => {
    const base = { approvalId: "a1", toolName: "Write", toolInput: { file_path: LONG }, expiresAt: "2026-11-15T10:10:00.000Z" };
    expect(describeEvent(envelope("approval.requested", base)).fullDetail).toBe(LONG);
    const withSummary = describeEvent(envelope("approval.requested", { ...base, summary: "Menambah 3 baris" }));
    expect(withSummary.detail).toBe("Menambah 3 baris");
    expect(withSummary.fullDetail).toBeUndefined();
  });

  test("jalur lengkap tetap dibersihkan dari karakter kontrol dan pembalik arah tulisan", () => {
    const view = describeEvent(envelope("tool.requested", { toolName: "Write", toolInput: { file_path: `/home/x/${"d/".repeat(30)}a\u202eb.ts` } }));
    expect(view.fullDetail).not.toMatch(/\u202e/);
    expect(view.detail).not.toMatch(/\u202e/);
  });
});

describe("EventRow: ketuk untuk jalur lengkap", () => {
  const renderRow = (event: Envelope) =>
    render(
      <I18nProvider>
        <ul>
          <EventRow event={event} />
        </ul>
      </I18nProvider>,
    );

  test("jalur ringkas tampil dulu; mengetuk baris menampilkan jalur lengkap; mengetuk lagi meringkas", () => {
    renderRow(envelope("tool.requested", { toolName: "Write", toolInput: { file_path: LONG } }));
    const button = screen.getByRole("button", { name: /…\/timeline\/EventRow\.tsx/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: new RegExp(LONG.replace(/[/.]/g, "\\$&")) }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toContain("…/timeline/EventRow.tsx");
  });

  test("baris dengan jalur pendek tidak memakai tombol", () => {
    renderRow(envelope("tool.requested", { toolName: "Write", toolInput: { file_path: "src/a.ts" } }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });
});
