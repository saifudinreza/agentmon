import type { PushPayload } from "@agentmon/shared";
import { describe, expect, test } from "vitest";
import { en } from "../i18n/en";
import { id } from "../i18n/id";
import { describePush, isSafePath, localeFor, MAX_PATH_LENGTH, NAVIGATE_MESSAGE, parseNavigateMessage, parsePush, pathFor } from "./notification";

const raw = (payload: Partial<PushPayload> & { kind: PushPayload["kind"] }) => JSON.stringify({ v: 1, machineId: "m1", ...payload });

describe("describePush: setiap push menghasilkan notifikasi yang terlihat", () => {
  test("izin: judul dan isi dalam bahasa perangkat, tujuan ke layar keputusan, satu tag per permintaan", () => {
    const content = describePush(raw({ kind: "approval", approvalId: "a1", sessionId: "s1" }), "id");
    expect(content.title).toBe("Izin dibutuhkan");
    expect(content.options.body).toBe("Agent menunggu keputusan Anda. Ketuk untuk melihat.");
    expect(content.options.data).toEqual({ path: "/a/m1/a1" });
    expect(content.options.tag).toBe("approval:m1:a1");
    expect(content.options.icon).toBe("/icons/icon-192.png");
    expect(describePush(raw({ kind: "approval", approvalId: "a1" }), "en").title).toBe("Approval needed");
  });

  test("agent selesai: tujuan ke timeline sesi", () => {
    const content = describePush(raw({ kind: "done", sessionId: "s9" }), "id");
    expect(content.title).toBe("Agent selesai");
    expect(content.options.data).toEqual({ path: "/s/m1/s9" });
    expect(content.options.tag).toBe("done:m1:s9");
  });

  test("uji kirim: tujuan beranda", () => {
    const content = describePush(raw({ kind: "test" }), "id");
    expect(content.title).toBe("Notifikasi uji");
    expect(content.options.data).toEqual({ path: "/" });
  });

  test("izin tanpa nomor izin, atau selesai tanpa nomor sesi: tetap tampil, tujuannya beranda", () => {
    expect(describePush(raw({ kind: "approval" }), "id").options.data.path).toBe("/");
    expect(describePush(raw({ kind: "done" }), "id").options.data.path).toBe("/");
  });

  test.each([
    ["kosong", undefined],
    ["string kosong", ""],
    ["bukan JSON", "halo dunia"],
    ["JSON bukan objek", "42"],
    ["null", "null"],
    ["jenis tidak dikenal", JSON.stringify({ v: 1, kind: "rahasia", machineId: "m1" })],
    ["versi lain", JSON.stringify({ v: 2, kind: "approval", machineId: "m1" })],
    ["kolom liar (skema ketat)", JSON.stringify({ v: 1, kind: "approval", machineId: "m1", perintah: "rm -rf /" })],
    ["nomor terlalu panjang", JSON.stringify({ v: 1, kind: "approval", machineId: "m".repeat(300) })],
    ["JSON rusak", '{"v":1,"kind":'],
  ])("isi %s: tetap menampilkan notifikasi umum, bukan galat dan bukan kosong", (_name, input) => {
    const content = describePush(input, "id");
    expect(content.title).toBe("AgentMon");
    expect(content.options.body).toBe("Ada pembaruan. Ketuk untuk membuka.");
    expect(content.options.data).toEqual({ path: "/" });
    expect(content.options.tag).toBe("agentmon");
  });

  test("tidak ada teks yang jatuh menjadi nama kunci (kunci terjemahan hilang)", () => {
    for (const kind of ["approval", "done", "test"] as const) {
      for (const locale of ["id", "en"] as const) {
        const content = describePush(raw({ kind }), locale);
        expect(content.title, `${kind}/${locale}`).not.toContain("push.notif");
        expect(content.options.body, `${kind}/${locale}`).not.toContain("push.notif");
      }
    }
    const generic = describePush(undefined, "en");
    expect(generic.title).not.toContain("push.notif");
    expect(generic.options.body).toBe("There is an update. Tap to open.");
  });

  test("teks notifikasi ada di kedua kamus untuk semua jenis (jaminan paritas)", () => {
    for (const kind of ["approval", "done", "test", "generic"]) {
      for (const part of ["title", "body"]) {
        const key = `push.notif.${kind}.${part}` as keyof typeof id;
        expect(id[key], key).toBeTruthy();
        expect(en[key], key).toBeTruthy();
      }
    }
  });

  test("isi notifikasi tidak pernah memuat nomor mentah dari relay (hanya jalur dan tag)", () => {
    const content = describePush(raw({ kind: "approval", approvalId: "SANGAT-RAHASIA" }), "id");
    expect(content.title).not.toContain("SANGAT-RAHASIA");
    expect(content.options.body).not.toContain("SANGAT-RAHASIA");
  });
});

describe("pathFor: tujuan dibangun dari nomor yang di-encode", () => {
  test("karakter khusus di nomor di-encode, dan hasilnya selalu jalur yang aman", () => {
    const path = pathFor({ v: 1, kind: "approval", machineId: "laptop/../kantor", approvalId: "a b?c#d" });
    expect(path).toBe("/a/laptop%2F..%2Fkantor/a%20b%3Fc%23d");
    expect(isSafePath(path)).toBe(true);
  });

  test("nomor yang berniat membuka situs lain tetap menjadi satu jalur di dalam aplikasi", () => {
    for (const evil of ["//evil.example", "https://evil.example", "\\\\evil", "..%2f..", "javascript:alert(1)"]) {
      const path = pathFor({ v: 1, kind: "approval", machineId: evil, approvalId: evil });
      expect(isSafePath(path), path).toBe(true);
      expect(path.startsWith("/a/")).toBe(true);
    }
  });
});

describe("isSafePath", () => {
  test.each(["/", "/a/m1/a1", "/s/m1/s1", "/a/laptop%2Fx/b", "/devices", "/a-b_c.d~e"])("aman: %s", (path) => expect(isSafePath(path)).toBe(true));

  test.each([
    "",
    "a/b",
    "//evil.example",
    "//evil.example/x",
    "/\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "/a b",
    "/a\nb",
    "/a\tb",
    "/a?x=1",
    "/a#frag",
    "/a:b",
    "/‮",
    `/${"a".repeat(5000)}`,
    undefined,
    null,
    42,
    {},
  ])("tidak aman: %j", (path) => expect(isSafePath(path)).toBe(false));
});

describe("localeFor", () => {
  test.each([
    ["en", "en"],
    ["en-US", "en"],
    ["EN-gb", "en"],
    ["id", "id"],
    ["id-ID", "id"],
    ["fr-FR", "id"],
    ["", "id"],
    [undefined, "id"],
  ] as const)("%j -> %s", (language, expected) => expect(localeFor(language)).toBe(expected));
});

describe("parsePush", () => {
  test("isi sah dikembalikan apa adanya, yang tidak sah undefined", () => {
    expect(parsePush(raw({ kind: "test" }))).toEqual({ v: 1, kind: "test", machineId: "m1" });
    expect(parsePush("bukan json")).toBeUndefined();
    expect(parsePush(undefined)).toBeUndefined();
  });
});

describe("parseNavigateMessage", () => {
  test("pesan yang sah dari service worker memberi jalurnya", () => {
    expect(parseNavigateMessage({ type: NAVIGATE_MESSAGE, path: "/a/m1/a1" })).toBe("/a/m1/a1");
  });

  test.each([
    ["jenis lain", { type: "lain", path: "/a" }],
    ["tanpa jenis", { path: "/a" }],
    ["jalur ke situs lain", { type: NAVIGATE_MESSAGE, path: "//evil.example" }],
    ["jalur berupa alamat penuh", { type: NAVIGATE_MESSAGE, path: "https://evil.example" }],
    ["jalur bukan teks", { type: NAVIGATE_MESSAGE, path: 5 }],
    ["tanpa jalur", { type: NAVIGATE_MESSAGE }],
    ["null", null],
    ["teks", "halo"],
    ["angka", 7],
    ["undefined", undefined],
  ])("ditolak: %s", (_name, data) => expect(parseNavigateMessage(data)).toBeUndefined());
});

describe("pathFor: nomor dengan tanda yang tidak di-encode oleh encodeURIComponent", () => {
  test.each(["a(1)", "x'y", "z!*", "it's (ok)"])("%s tetap membuka layar yang tepat dan bisa didekode kembali", (value) => {
    const path = pathFor({ v: 1, kind: "approval", machineId: value, approvalId: value });
    expect(isSafePath(path), path).toBe(true);
    const [, , machine, approval] = path.split("/");
    expect(decodeURIComponent(machine!)).toBe(value);
    expect(decodeURIComponent(approval!)).toBe(value);
  });
});

describe("pathFor: nomor terpanjang yang sah tetap lolos (hasil review PR #58)", () => {
  test.each([
    ["ASCII dengan karakter yang di-encode", "m".repeat(200), "a:".repeat(100)],
    ["huruf dua byte", "\u00e9".repeat(200), "\u00e9".repeat(200)],
    ["huruf tiga byte", "\u65e5".repeat(200), "\u65e5".repeat(200)],
    ["emoji", "\u{1F600}".repeat(100), "\u{1F600}".repeat(100)],
  ])("%s", (_name, machineId, approvalId) => {
    const path = pathFor({ v: 1, kind: "approval", machineId, approvalId });
    expect(path.length).toBeLessThanOrEqual(MAX_PATH_LENGTH);
    expect(isSafePath(path)).toBe(true);
    expect(path.startsWith("/a/")).toBe(true); // tidak jatuh ke beranda
  });
});
