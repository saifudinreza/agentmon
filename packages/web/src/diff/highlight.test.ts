import { describe, expect, test } from "vitest";
import { tokenizeLine } from "./highlight";
import { languageOf } from "./language";

const kinds = (text: string, lang: Parameters<typeof tokenizeLine>[1]) => tokenizeLine(text, lang).map((t) => [t.text, t.kind]);

describe("languageOf", () => {
  test.each([
    ["src/app.ts", "js"],
    ["Komponen.TSX", "js"],
    ["main.go", "js"],
    ["skrip.py", "python"],
    ["gaya.scss", "css"],
    ["data.json", "json"],
    ["pasang.sh", "shell"],
    ["Dockerfile", "shell"],
    ["catatan.txt", "plain"],
    ["README", "plain"],
    [String.raw`C:\proyek\src\a.py`, "python"],
  ] as const)("%s -> %s", (path, expected) => expect(languageOf(path)).toBe(expected));
});

describe("tokenizeLine", () => {
  test("hasil digabung SELALU sama persis dengan masukan (warna tidak mengubah isi)", () => {
    const samples = ['const a = "x\\"y" + 1.5; // komentar', "if (x) { return `t${1}`; }", "  # python 'str' 12", 'a /* b */ c', '"belum ditutup', "", "   ", "𝒳 emoji 📱 日本語"];
    for (const lang of ["js", "python", "css", "json", "shell", "plain"] as const) {
      for (const sample of samples) expect(tokenizeLine(sample, lang).map((t) => t.text).join("")).toBe(sample);
    }
  });

  test("js: kata kunci, string, angka, dan komentar", () => {
    expect(kinds('const n = 42; // selesai', "js")).toEqual([
      ["const", "keyword"],
      [" n = ", "plain"],
      ["42", "number"],
      ["; ", "plain"],
      ["// selesai", "comment"],
    ]);
    expect(kinds('return "a\\"b";', "js")).toEqual([
      ["return", "keyword"],
      [" ", "plain"],
      ['"a\\"b"', "string"],
      [";", "plain"],
    ]);
  });

  test("kata kunci di dalam nama lain tidak diwarnai (constant, v1)", () => {
    expect(kinds("constant v1 forEach", "js")).toEqual([["constant v1 forEach", "plain"]]);
  });

  test("kata kunci di dalam string atau komentar tidak diwarnai sebagai kata kunci", () => {
    expect(kinds('"if else" // return', "js")).toEqual([
      ['"if else"', "string"],
      [" ", "plain"],
      ["// return", "comment"],
    ]);
  });

  test("string yang tidak ditutup memakan sampai akhir baris (tidak menggantung)", () => {
    expect(kinds('x = "terbuka', "js")).toEqual([
      ["x = ", "plain"],
      ['"terbuka', "string"],
    ]);
  });

  test("python dan shell memakai # sebagai komentar; json mengenali true/false/null", () => {
    expect(kinds("x = 1  # catatan", "python")).toEqual([
      ["x = ", "plain"],
      ["1", "number"],
      ["  ", "plain"],
      ["# catatan", "comment"],
    ]);
    expect(kinds("echo hai # nanti", "shell")).toContainEqual(["# nanti", "comment"]);
    expect(kinds('{"a": true, "b": null, "c": -3.5}', "json")).toEqual([
      ["{", "plain"],
      ['"a"', "string"],
      [": ", "plain"],
      ["true", "keyword"],
      [", ", "plain"],
      ['"b"', "string"],
      [": ", "plain"],
      ["null", "keyword"],
      [", ", "plain"],
      ['"c"', "string"],
      [": ", "plain"],
      ["-3.5", "number"],
      ["}", "plain"],
    ]);
  });

  test("bahasa polos dan baris kosong tidak diwarnai", () => {
    expect(kinds("const x = 1", "plain")).toEqual([["const x = 1", "plain"]]);
    expect(kinds("", "js")).toEqual([["", "plain"]]);
  });

  test("baris yang sangat panjang (mis. minified) dilewati supaya cepat", () => {
    const long = "const a = 1;".repeat(400);
    expect(long.length).toBeGreaterThan(2000);
    const started = performance.now();
    expect(tokenizeLine(long, "js")).toEqual([{ text: long, kind: "plain" }]);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("baris berakhir dengan satu backslash setelah banyak tanda kutip tidak kuadratik, dan hasilnya tetap utuh", () => {
    const evil = '\\"'.repeat(995) + "\\"; // 1.991 karakter
    const started = performance.now();
    for (let i = 0; i < 600; i++) tokenizeLine(evil, "js");
    expect(performance.now() - started).toBeLessThan(300); // sebelum diperbaiki: ±3 ms per baris x 600 = ±1,8 detik
    expect(tokenizeLine(evil, "js").map((t) => t.text).join("")).toBe(evil);
    for (const lang of ["python", "css", "json", "shell"] as const) expect(tokenizeLine(evil, lang).map((t) => t.text).join("")).toBe(evil);
  });

  test("teks yang dirancang menyulitkan regex tidak membuat pewarna menggantung", () => {
    const evil = `"${"\\".repeat(1500)}`;
    const started = performance.now();
    tokenizeLine(evil, "js");
    tokenizeLine("/*".repeat(900), "js");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
