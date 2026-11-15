import { describe, expect, test } from "vitest";
import { describeEvent } from "./describe";
import { markdownToPlain } from "./plain";

const plain = (s: string) => markdownToPlain(s).replace(/\s+/g, " ").trim();

describe("markdownToPlain", () => {
  test.each([
    ["**tebal** dan __tebal__", "tebal dan tebal"],
    ["*miring* dan _miring_", "miring dan miring"],
    ["~~coret~~", "coret"],
    ["pakai `npm test` dulu", "pakai npm test dulu"],
    ["# Judul\n## Sub", "Judul Sub"],
    ["- satu\n- dua\n* tiga\n1. empat\n2) lima", "satu dua tiga empat lima"],
    ["- [x] selesai\n- [ ] belum", "selesai belum"],
    ["> kutipan", "kutipan"],
    ["lihat [dokumen](https://x.example/a?b=1) ini", "lihat dokumen ini"],
    ["![gambar](https://x.example/a.png)", "gambar"],
    ["<https://x.example/a>", "https://x.example/a"],
    ["a\n\n---\n\nb", "a b"],
    ["```ts\nconst x = 1;\n```", "const x = 1;"],
    ["| a | b |\n|---|---|\n| 1 | 2 |", "· a · b · · 1 · 2 ·"],
    ["tanda \\* ditulis \\_ literal", "tanda * ditulis _ literal"],
    ["pakai Array<string> dan <div> di sini", "pakai Array<string> dan <div> di sini"],
  ])("%j -> %j", (input, expected) => {
    expect(plain(input)).toBe(expected);
  });

  test("nama bergaris bawah dan perkalian bukan penanda miring", () => {
    expect(plain("ubah snake_case_name dan 2*3*4")).toBe("ubah snake_case_name dan 2*3*4");
    expect(plain("file_a_b.ts")).toBe("file_a_b.ts");
  });

  test("teks biasa tidak berubah", () => {
    for (const text of ["Selesai. 3 berkas diubah.", "Tes lulus (12/12).", "Error: gagal membuka berkas"]) expect(plain(text)).toBe(text);
  });

  test("bukan teks: kosong, tidak melempar", () => {
    for (const value of [undefined, null, 5, {}, [], true]) expect(markdownToPlain(value)).toBe("");
    expect(markdownToPlain("")).toBe("");
  });

  test("alamat tautan markdown dibuang (tidak ada tautan berbahaya tersisa); tag HTML tetap teks apa adanya", () => {
    const out = plain("[klik](javascript:alert(1)) <img src=x onerror=alert(1)>");
    expect(out).not.toContain("javascript:");
    expect(out).toBe("klik <img src=x onerror=alert(1)>");
  });

  test.each([
    ["*".repeat(200_000)],
    ["_".repeat(200_000)],
    ["[".repeat(200_000)],
    ["`".repeat(200_000)],
    ["![a](".repeat(40_000)],
    ["**a ".repeat(50_000)],
    ["<a ".repeat(60_000)],
    ["- ".repeat(100_000)],
    ["| ".repeat(100_000)],
    ["\\".repeat(200_000)],
  ])("masukan jahat yang panjang selesai cepat (%#)", (input) => {
    const start = performance.now();
    markdownToPlain(input);
    expect(performance.now() - start).toBeLessThan(200);
  });

  test("masukan dipotong 4000 karakter sebelum diproses", () => {
    expect(markdownToPlain("a".repeat(10_000)).length).toBe(4000);
  });
});

describe("timeline: pesan akhir agent tampil sebagai teks bersih", () => {
  const stopped = (lastMessage: string) => describeEvent({ v: 1, id: "11111111-1111-4111-8111-111111111111", machineId: "m1", sessionId: "s1", seq: 0, ts: "2026-11-15T10:00:00.000Z", agent: "claude-code", type: "agent.stopped", payload: { lastMessage } } as never);

  test("Agent berhenti: markdown dibuang dari keterangan", () => {
    expect(stopped("**Selesai.** Saya mengubah `src/a.ts` dan menjalankan:\n- tes\n- lint").detail).toBe("Selesai. Saya mengubah src/a.ts dan menjalankan: tes lint");
  });

  test("pemberitahuan agent: markdown dibuang dari judul dan isi", () => {
    const view = describeEvent({ v: 1, id: "11111111-1111-4111-8111-111111111111", machineId: "m1", sessionId: "s1", seq: 1, ts: "2026-11-15T10:00:00.000Z", agent: "claude-code", type: "agent.notification", payload: { title: "**Izin**", message: "butuh `izin`" } } as never);
    expect(view.detail).toBe("Izin: butuh izin");
  });

  test("tetap dibersihkan dari karakter kontrol dan pembalik arah tulisan serta dipotong 200 karakter", () => {
    expect(stopped("a‮b\u0007c").detail).toBe("abc");
    expect((stopped("x".repeat(500)).detail ?? "").length).toBe(200);
  });
});
