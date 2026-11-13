import type { DiffHunk, FileDiff } from "@agentmon/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n/react";
import DiffViewer, { INITIAL_LINE_BUDGET } from "./DiffViewer";

// Diff 1.500+ baris di jsdom berat; runner CI yang lambat butuh waktu lebih dari bawaan 5 detik.
vi.setConfig({ testTimeout: 60_000 });

const format = { oldEol: "lf", newEol: "lf", oldFinalNewline: true, newFinalNewline: true } as const;
const hunk = (id: string, lines: Array<[("add" | "remove" | "context"), string]>, start = 1): DiffHunk => {
  let oldN = start;
  let newN = start;
  return {
    id,
    oldStart: start,
    oldLines: lines.filter(([t]) => t !== "add").length,
    newStart: start,
    newLines: lines.filter(([t]) => t !== "remove").length,
    lines: lines.map(([type, text]) => ({ type, text, ...(type !== "add" ? { oldLine: oldN++ } : {}), ...(type !== "remove" ? { newLine: newN++ } : {}) })),
  };
};
const fileDiff = (path: string, hunks: DiffHunk[], extra: Partial<FileDiff> = {}, isNew = false): FileDiff => ({
  path,
  toolName: "Edit",
  sensitive: [],
  change: {
    type: "text",
    isNew,
    added: hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "add").length, 0),
    removed: hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === "remove").length, 0),
    format,
    hunks,
  },
  ...extra,
});

const renderViewer = (diffs: FileDiff[]) =>
  render(
    <I18nProvider>
      <DiffViewer diffs={diffs} />
    </I18nProvider>,
  );
const rows = (container: HTMLElement) => container.querySelectorAll("div.font-mono").length;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("DiffViewer: tampilan hunk", () => {
  test("judul hunk, nomor baris, dan penanda tambah/hapus; pembaca layar mendapat kata 'Ditambah' dan 'Dihapus'", () => {
    const { container } = renderViewer([fileDiff("a.txt", [hunk("h1", [["context", "sama"], ["remove", "lama"], ["add", "baru"]], 3)])]);
    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe("@@ -3,2 +3,2 @@");
    expect(rows(container)).toBe(3);
    expect(screen.getByText("Ditambah:")).toBeTruthy();
    expect(screen.getByText("Dihapus:")).toBeTruthy();
    expect(screen.getByText("lama")).toBeTruthy();
    expect(screen.getByText("baru")).toBeTruthy();
    expect(container.textContent).toContain("+1 -1"); // ringkasan di bagian atas
  });

  test("karakter berbahaya di baris ditampilkan sebagai kodenya, bukan disembunyikan", () => {
    renderViewer([fileDiff("a.txt", [hunk("h1", [["add", "rm -rf /‮ fdp"]])])]);
    expect(screen.getByText("rm -rf /\\u202e fdp")).toBeTruthy();
  });

  test("peringatan path sensitif tampil mencolok", () => {
    renderViewer([fileDiff("kunci.env", [hunk("h1", [["add", "A=1"]])], { sensitive: [{ code: "env_file", message: "berkas rahasia" }] })]);
    expect(screen.getByRole("alert").textContent).toContain("berkas rahasia");
  });

  test("jenis non-teks (biner, terlalu besar, tidak cocok) tampil sebagai keterangan", () => {
    const base = { path: "x.bin", toolName: "Write", sensitive: [] };
    renderViewer([{ ...base, change: { type: "binary", isNew: false } }]);
    expect(screen.getByText(/biner/i)).toBeTruthy();
    cleanup();
    renderViewer([{ ...base, change: { type: "too_large", isNew: false, message: "3 MB" } }]);
    expect(screen.getByText(/3 MB/)).toBeTruthy();
  });

  test("tanpa diff: pesan 'tidak ada'", () => {
    renderViewer([]);
    expect(screen.getByText(/tidak tersedia/i)).toBeTruthy();
  });
});

describe("DiffViewer: baris panjang", () => {
  test("bawaan: baris dibungkus (yang disetujui terlihat utuh, sama seperti teks cadangan); mematikan bungkus membuat hunk bisa digulir ke samping", () => {
    const long = "x".repeat(400);
    const { container } = renderViewer([fileDiff("a.txt", [hunk("h1", [["add", long]])])]);
    expect((screen.getByRole("checkbox", { name: "Bungkus baris panjang" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(long).className).toContain("whitespace-pre-wrap");
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Bungkus baris panjang" }));
    const text = screen.getByText(long);
    expect(text.className).toContain("whitespace-pre");
    expect(text.className).not.toContain("whitespace-pre-wrap");
    expect(container.querySelector(".overflow-x-auto")).toBeTruthy();
  });

  test("judul berkas menampilkan path utuh dengan karakter berbahaya sebagai kodenya (tidak dipotong, tidak dibuang diam-diam)", () => {
    const path = "src/" + "dalam/".repeat(60) + "aman\u202egpj.ts";
    renderViewer([fileDiff(path, [hunk("h1", [["add", "x"]])])]);
    expect(screen.getByText(path.replace("\u202e", "\\u202e"))).toBeTruthy();
  });
});

describe("DiffViewer: navigasi", () => {
  const three = () => fileDiff("a.ts", [hunk("h1", [["add", "satu"]]), hunk("h2", [["add", "dua"]], 10), hunk("h3", [["add", "tiga"]], 20)]);

  test("antar hunk: tombol sebelumnya/berikutnya, penunjuk posisi, dan menggulir ke hunk yang dituju", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderViewer([three()]);
    expect(screen.getByText("Hunk 1 dari 3", { selector: "span" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Hunk sebelumnya" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hunk berikutnya" }));
    expect(screen.getByText("Hunk 2 dari 3", { selector: "span" })).toBeTruthy();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("hunk-h2"));
    fireEvent.click(screen.getByRole("button", { name: "Hunk berikutnya" }));
    expect((screen.getByRole("button", { name: "Hunk berikutnya" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hunk sebelumnya" }));
    expect(scroll.mock.contexts[2]).toBe(document.getElementById("hunk-h2"));
  });

  test("satu hunk saja: tanpa tombol navigasi hunk", () => {
    renderViewer([fileDiff("a.ts", [hunk("h1", [["add", "satu"]])])]);
    expect(screen.queryByRole("button", { name: "Hunk berikutnya" })).toBeNull();
  });

  test("antar berkas: berkas lain, hunk-nya sendiri, dan peringatan sensitif milik berkas itu", () => {
    const a = fileDiff("a.ts", [hunk("h1", [["add", "isi A"]])]);
    const b = fileDiff("b.env", [hunk("h1", [["add", "isi B"]])], { sensitive: [{ code: "env_file", message: "rahasia B" }] });
    renderViewer([a, b]);
    expect(screen.getByText("Berkas 1 dari 2")).toBeTruthy();
    expect(screen.getByText("isi A")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Berkas berikutnya" }));
    expect(screen.getByText("Berkas 2 dari 2")).toBeTruthy();
    expect(screen.getByText("isi B")).toBeTruthy();
    expect(screen.queryByText("isi A")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("rahasia B");
    expect((screen.getByRole("button", { name: "Berkas berikutnya" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("pindah berkas mengembalikan penunjuk hunk ke awal", () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderViewer([three(), fileDiff("b.ts", [hunk("h1", [["add", "x"]]), hunk("h2", [["add", "y"]])])]);
    fireEvent.click(screen.getByRole("button", { name: "Hunk berikutnya" }));
    fireEvent.click(screen.getByRole("button", { name: "Berkas berikutnya" }));
    expect(screen.getByText("Hunk 1 dari 2", { selector: "span" })).toBeTruthy();
  });
});

describe("DiffViewer: diff besar", () => {
  const bigDiff = (n: number) => fileDiff("besar.ts", [hunk("h1", Array.from({ length: n }, (_, i) => ["add" as const, `baris ${i}`]))]);

  test("1.000 baris digambar semuanya (responsif: tidak dipotong), dalam waktu wajar", () => {
    const started = performance.now();
    const { container } = renderViewer([bigDiff(1000)]);
    const took = performance.now() - started;
    expect(rows(container)).toBe(1000);
    expect(screen.queryByRole("button", { name: /baris lagi/ })).toBeNull();
    expect(took).toBeLessThan(5000); // batas longgar untuk jsdom; angka sebenarnya di docs/web.md (diukur di browser)
  });

  test("lebih dari anggaran: sisanya disembunyikan dengan tombol, dan tombol menampilkannya bertahap", () => {
    const { container } = renderViewer([bigDiff(INITIAL_LINE_BUDGET + 600)]);
    expect(rows(container)).toBe(INITIAL_LINE_BUDGET);
    // Pembaca diberi tahu bahwa diff belum terlihat seluruhnya, dan tombol menyebut berapa yang tersembunyi.
    expect(screen.getByRole("status").textContent).toContain("600 baris belum ditampilkan");
    expect(screen.getByText("… 600 baris lagi di hunk ini belum ditampilkan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tampilkan 600 baris lagi (600 tersembunyi)" }));
    expect(rows(container)).toBe(INITIAL_LINE_BUDGET + 600);
    expect(screen.queryByRole("button", { name: /baris lagi/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/belum ditampilkan/)).toBeNull();
  });

  test("anggaran dibagi antar hunk berurutan: hunk setelah anggaran habis tidak digambar", () => {
    const first = hunk("h1", Array.from({ length: INITIAL_LINE_BUDGET }, (_, i) => ["add" as const, `a${i}`]));
    const second = hunk("h2", [["add", "di hunk kedua"]], 5000);
    const { container } = renderViewer([fileDiff("besar.ts", [first, second])]);
    expect(rows(container)).toBe(INITIAL_LINE_BUDGET);
    expect(screen.queryByText("di hunk kedua")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tampilkan 1 baris lagi (1 tersembunyi)" }));
    expect(screen.getByText("di hunk kedua")).toBeTruthy();
  });
});

describe("DiffViewer: navigasi ke hunk yang belum digambar", () => {
  test("hunk berikutnya yang tertahan anggaran langsung digambar, bukan menunjuk sesuatu yang tidak ada", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const first = hunk("h1", Array.from({ length: INITIAL_LINE_BUDGET }, (_, i) => ["add" as const, `a${i}`]));
    const second = hunk("h2", [["add", "isi hunk kedua"]], 5000);
    renderViewer([fileDiff("besar.ts", [first, second])]);
    expect(screen.queryByText("isi hunk kedua")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hunk berikutnya" }));
    expect(screen.getByText("isi hunk kedua")).toBeTruthy();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });
});

describe("DiffViewer: warna sintaks dimuat belakangan", () => {
  test("teks terbaca sebelum warna siap; setelah modul warna dimuat, kata kunci diberi warna tanpa mengubah teks", async () => {
    const { container } = renderViewer([fileDiff("a.ts", [hunk("h1", [["add", "const nilai = 42; // catatan"]])])]);
    // Seketika setelah render: teks lengkap sudah ada (tanpa potongan berwarna).
    expect(container.textContent).toContain("const nilai = 42; // catatan");
    // Setelah modul warna dimuat: potongan berwarna muncul, teks gabungannya tetap sama.
    await waitFor(() => expect(container.querySelector(".text-info")?.textContent).toBe("const"));
    expect(container.textContent).toContain("const nilai = 42; // catatan");
    expect(container.querySelector(".italic")?.textContent).toBe("// catatan");
  });

  test("baris yang dirancang membuat regex kuadratik (berakhir dengan satu backslash) tidak membekukan penampil", async () => {
    const evil = '\\"'.repeat(995) + "\\";
    const started = performance.now();
    const { container } = renderViewer([fileDiff("a.ts", Array.from({ length: 300 }, () => hunk("h", [["add", evil]])).map((h, i) => ({ ...h, id: "h" + i })))]);
    await waitFor(() => expect(container.querySelectorAll("div.font-mono").length).toBe(300));
    await new Promise((resolve) => setTimeout(resolve, 100)); // beri waktu pewarna selesai
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("berkas tanpa bahasa dikenal tetap polos", async () => {
    const { container } = renderViewer([fileDiff("catatan.txt", [hunk("h1", [["add", "const x = 1"]])])]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector(".text-info")).toBeNull();
  });
});
