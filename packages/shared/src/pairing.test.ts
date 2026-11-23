import { describe, expect, test } from "vitest";
import { buildPairingUrl, PairRedeemRequestSchema, PairRedeemResponseSchema, parsePairingUrl, sanitizeForTerminal } from "./pairing";

const CODE = "abcDEF0123456789_-abcDEF0123456789";
const SECRET = "A".repeat(43);
const LAPTOP_KEY = "B".repeat(43);
const APP = "https://app.contoh.com";
const RELAY = "https://relay.contoh.com";

describe("buildPairingUrl dan parsePairingUrl", () => {
  test("bolak-balik: yang dibuat bisa dibaca kembali persis", () => {
    const url = buildPairingUrl(APP, { code: CODE, relayUrl: RELAY });
    expect(parsePairingUrl(url)).toEqual({ code: CODE, relayUrl: RELAY });
  });

  test("SEMUA data ada di fragmen: tidak ada di jalur atau query yang dikirim ke server", () => {
    const url = new URL(buildPairingUrl(APP, { code: CODE, relayUrl: RELAY, secret: SECRET, laptopKey: LAPTOP_KEY }));
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    expect(url.hash).toContain(`c=${CODE}`);
    // Bagian yang benar-benar dikirim browser ke server hosting:
    const sentToServer = `${url.origin}${url.pathname}${url.search}`;
    expect(sentToServer).not.toContain(CODE);
    expect(sentToServer).not.toContain(SECRET);
    expect(sentToServer).not.toContain(LAPTOP_KEY);
  });

  test("rahasia E2E (s) dan kunci publik laptop (k) bisa ditambahkan tanpa mengubah bentuk lain", () => {
    const url = buildPairingUrl(APP, { code: CODE, relayUrl: RELAY, secret: SECRET, laptopKey: LAPTOP_KEY });
    expect(parsePairingUrl(url)).toEqual({ code: CODE, relayUrl: RELAY, secret: SECRET, laptopKey: LAPTOP_KEY });
  });

  test("rahasia atau kunci yang bentuknya salah dibuang (pairing lama), QR tetap terbaca", () => {
    const url = new URL(buildPairingUrl(APP, { code: CODE, relayUrl: RELAY }));
    url.hash += "&s=pendek&k=" + "x".repeat(60);
    expect(parsePairingUrl(url.toString())).toEqual({ code: CODE, relayUrl: RELAY });
  });

  test("alamat PWA yang berada di sub-jalur dan berakhiran garis miring tetap benar", () => {
    expect(new URL(buildPairingUrl("https://contoh.com/agentmon/", { code: CODE, relayUrl: RELAY })).pathname).toBe("/agentmon/pair");
  });

  test("alamat PWA yang membawa query/fragmen lama dibersihkan", () => {
    const url = new URL(buildPairingUrl("https://contoh.com/?x=1#lama", { code: CODE, relayUrl: RELAY }));
    expect(url.search).toBe("");
    expect(url.hash).not.toContain("lama");
  });

  test("alamat relay dengan port, jalur, dan karakter khusus selamat", () => {
    const relay = "http://192.168.1.5:8787/prefix?a=b&c=d";
    expect(parsePairingUrl(buildPairingUrl(APP, { code: CODE, relayUrl: relay }))?.relayUrl).toBe(relay);
  });

  test("parameter yang belum dikenal diabaikan (versi baru tetap terbaca versi lama)", () => {
    const url = `${APP}/pair#c=${CODE}&r=${encodeURIComponent(RELAY)}&v=9&x=apa-saja`;
    expect(parsePairingUrl(url)).toEqual({ code: CODE, relayUrl: RELAY });
  });

  test.each([
    ["bukan alamat", "halo dunia"],
    ["kosong", ""],
    ["skema berbahaya", `javascript:alert(1)//pair#c=${CODE}&r=${RELAY}`],
    ["skema ftp", `ftp://x.com/pair#c=${CODE}&r=${RELAY}`],
    ["jalur salah", `${APP}/lain#c=${CODE}&r=${encodeURIComponent(RELAY)}`],
    ["tanpa kode", `${APP}/pair#r=${encodeURIComponent(RELAY)}`],
    ["tanpa relay", `${APP}/pair#c=${CODE}`],
    ["kode terlalu pendek", `${APP}/pair#c=pendek&r=${encodeURIComponent(RELAY)}`],
    ["kode berkarakter aneh", `${APP}/pair#c=${"a".repeat(15)}!&r=${encodeURIComponent(RELAY)}`],
    ["relay bukan http", `${APP}/pair#c=${CODE}&r=${encodeURIComponent("javascript:alert(1)")}`],
    ["relay bukan alamat", `${APP}/pair#c=${CODE}&r=bukan-alamat`],
    ["kode hanya di query (bukan fragmen)", `${APP}/pair?c=${CODE}&r=${encodeURIComponent(RELAY)}`],
  ])("menolak: %s", (_name, text) => {
    expect(parsePairingUrl(text)).toBeUndefined();
  });

  test("pembuat menolak masukan yang tidak sah", () => {
    expect(() => buildPairingUrl("bukan-url", { code: CODE, relayUrl: RELAY })).toThrow(TypeError);
    expect(() => buildPairingUrl(APP, { code: CODE, relayUrl: "ftp://x" })).toThrow(TypeError);
    expect(() => buildPairingUrl(APP, { code: "pendek", relayUrl: RELAY })).toThrow(TypeError);
  });
});

describe("skema permintaan dan jawaban", () => {
  test("permintaan penukaran: nama dipangkas, kosong dan terlalu panjang ditolak", () => {
    expect(PairRedeemRequestSchema.parse({ code: CODE, name: "  iPhone Budi  " }).name).toBe("iPhone Budi");
    expect(PairRedeemRequestSchema.safeParse({ code: CODE, name: "   " }).success).toBe(false);
    expect(PairRedeemRequestSchema.safeParse({ code: CODE, name: "x".repeat(65) }).success).toBe(false);
    expect(PairRedeemRequestSchema.safeParse({ code: "pendek", name: "HP" }).success).toBe(false);
  });

  test.each([
    ["ESC (urutan ANSI penghapus layar)", "HP\u001b[2J"],
    ["ESC di awal", "\u001b]0;judul palsu\u0007HP"],
    ["baris baru", "HP\nPerangkat resmi"],
    ["carriage return", "HP\rpalsu"],
    ["NUL", "HP\u0000"],
    ["DEL", "HP\u007f"],
    ["kontrol C1 (CSI 8-bit)", "HP\u009b2J"],
    ["pemisah baris Unicode", "HP lain"],
    ["pemisah paragraf Unicode", "HP lain"],
    ["tab", "HP\tlain"],
  ])("nama perangkat dengan karakter kontrol ditolak: %s", (_label, name) => {
    expect(PairRedeemRequestSchema.safeParse({ code: CODE, name }).success).toBe(false);
  });

  test("nama biasa tetap diterima, termasuk huruf non-Latin dan emoji", () => {
    for (const name of ["iPhone Budi", "Pixel 8 (kantor)", "Ponsel Ani 📱", "手机", "Müller's iPad"]) {
      expect(PairRedeemRequestSchema.safeParse({ code: CODE, name }).success).toBe(true);
    }
  });

  test("sanitizeForTerminal mengganti karakter kontrol dan membiarkan sisanya", () => {
    expect(sanitizeForTerminal("HP\u001b[2Jbaru\n\u009b")).toBe("HP?[2Jbaru??");
    expect(sanitizeForTerminal("Ponsel Ani 📱")).toBe("Ponsel Ani 📱");
    expect(sanitizeForTerminal("a b")).toBe("a?b");
  });

  test("jawaban: deviceToken boleh tidak ada, tetapi bila ada minimal 16 karakter", () => {
    const base = { deviceId: "d1", machineId: "m1", machineName: "Laptop" };
    expect(PairRedeemResponseSchema.safeParse(base).success).toBe(true);
    expect(PairRedeemResponseSchema.safeParse({ ...base, deviceToken: "x".repeat(16) }).success).toBe(true);
    expect(PairRedeemResponseSchema.safeParse({ ...base, deviceToken: "pendek" }).success).toBe(false);
  });
});
