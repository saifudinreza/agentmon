import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { paths } from "./home";
import { loadRelayConfig, resolveRelayConfig, saveRelayConfig } from "./relay-config";

const TOKEN = "a".repeat(64);
const OTHER = "b".repeat(64);
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentmon-relay-config-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("saveRelayConfig dan loadRelayConfig", () => {
  test("belum ada berkas: undefined", () => {
    expect(loadRelayConfig(home)).toBeUndefined();
  });

  test("menyimpan lalu membaca kembali persis sama", () => {
    const file = saveRelayConfig(home, { relayUrl: "https://relay.contoh.com", token: TOKEN });
    expect(file).toBe(paths(home).relay);
    expect(loadRelayConfig(home)).toEqual({ relayUrl: "https://relay.contoh.com", token: TOKEN });
  });

  test("hanya alamat dan token yang ditulis (tidak ada kolom lain yang terbawa)", () => {
    saveRelayConfig(home, { relayUrl: "https://relay.contoh.com", token: TOKEN, extra: "rahasia-lain" } as never);
    expect(Object.keys(JSON.parse(readFileSync(paths(home).relay, "utf8")) as object).sort()).toEqual(["relayUrl", "token"]);
  });

  test.skipIf(process.platform === "win32")("berkas hanya bisa dibaca pemilik (mode 0600), dan tidak ada berkas sementara yang tertinggal", () => {
    saveRelayConfig(home, { relayUrl: "https://relay.contoh.com", token: TOKEN });
    expect(statSync(paths(home).relay).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("menyimpan lagi menggantikan yang lama dan tidak meninggalkan berkas sementara", () => {
    saveRelayConfig(home, { relayUrl: "https://relay.contoh.com", token: TOKEN });
    saveRelayConfig(home, { relayUrl: "https://relay.contoh.com", token: OTHER });
    expect(loadRelayConfig(home)?.token).toBe(OTHER);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("rename gagal: galat dilempar dan berkas sementara berisi token TIDAK tertinggal (hasil review PR #59)", () => {
    // Folder di tempat berkas tujuan membuat rename gagal di semua sistem operasi.
    mkdirSync(paths(home).relay);
    expect(() => saveRelayConfig(home, { relayUrl: "https://relay.contoh.com", token: TOKEN })).toThrow();
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("folder data dibuat bila belum ada", () => {
    const nested = join(home, "belum", "ada");
    saveRelayConfig(nested, { relayUrl: "https://relay.contoh.com", token: TOKEN });
    expect(existsSync(paths(nested).relay)).toBe(true);
  });

  test("berkas rusak melempar galat yang menyebut lokasinya dan TIDAK memuat isinya (token)", () => {
    writeFileSync(paths(home).relay, `{"relayUrl": "https://r.example", "token": "${TOKEN}"`);
    let message = "";
    try {
      loadRelayConfig(home);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(paths(home).relay);
    expect(message).toContain("rusak");
    expect(message).not.toContain(TOKEN);
  });

  test.each([
    ["bukan objek", "[]"],
    ["null", "null"],
    ["tanpa token", '{"relayUrl":"https://r.example"}'],
    ["tanpa alamat", `{"token":"${TOKEN}"}`],
    ["alamat bukan http(s)", `{"relayUrl":"ftp://r.example","token":"${TOKEN}"}`],
    ["alamat bukan alamat", `{"relayUrl":"bukan alamat","token":"${TOKEN}"}`],
    ["token terlalu pendek", '{"relayUrl":"https://r.example","token":"pendek"}'],
    ["token memuat spasi", `{"relayUrl":"https://r.example","token":"${"a".repeat(20)} ${"b".repeat(20)}"}`],
    ["token bukan teks", '{"relayUrl":"https://r.example","token":12345678901234567890}'],
  ])("isi tidak sah (%s): galat yang jelas dan tidak membocorkan token", (_name, content) => {
    writeFileSync(paths(home).relay, content);
    expect(() => loadRelayConfig(home)).toThrow(/tidak sah/);
    try {
      loadRelayConfig(home);
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });
});

describe("resolveRelayConfig: memilih sumber", () => {
  const saved = { relayUrl: "https://relay.contoh.com", token: TOKEN };

  test("lingkungan lengkap menang atas berkas", () => {
    saveRelayConfig(home, saved);
    expect(resolveRelayConfig({ AGENTMON_RELAY_URL: "https://lain.example", AGENTMON_RELAY_TOKEN: OTHER }, home)).toEqual({ relayUrl: "https://lain.example", token: OTHER, source: "env" });
  });

  test("lingkungan lengkap: berkas yang rusak tidak dibaca sama sekali", () => {
    writeFileSync(paths(home).relay, "{rusak");
    expect(resolveRelayConfig({ AGENTMON_RELAY_URL: "https://r.example", AGENTMON_RELAY_TOKEN: OTHER }, home)?.source).toBe("env");
  });

  test("tanpa lingkungan: berkas dipakai", () => {
    saveRelayConfig(home, saved);
    expect(resolveRelayConfig({}, home)).toEqual({ ...saved, source: "file" });
  });

  test("tanpa lingkungan dan tanpa berkas: undefined", () => {
    expect(resolveRelayConfig({}, home)).toBeUndefined();
  });

  test("nilai lingkungan kosong atau hanya spasi dianggap tidak diisi", () => {
    saveRelayConfig(home, saved);
    expect(resolveRelayConfig({ AGENTMON_RELAY_URL: "  ", AGENTMON_RELAY_TOKEN: "" }, home)?.source).toBe("file");
  });

  test("hanya alamat dari lingkungan yang sama dengan berkas (beda garis miring atau huruf besar): token berkas dipakai", () => {
    saveRelayConfig(home, saved);
    expect(resolveRelayConfig({ AGENTMON_RELAY_URL: "https://RELAY.contoh.com/" }, home)).toEqual({ ...saved, source: "file" });
  });

  test("hanya alamat dari lingkungan yang BERBEDA dari berkas: tidak ada yang dipakai, token berkas tidak pernah dikirim ke relay lain", () => {
    saveRelayConfig(home, saved);
    expect(resolveRelayConfig({ AGENTMON_RELAY_URL: "https://relay-lain.example" }, home)).toBeUndefined();
  });

  test("hanya token dari lingkungan: DIABAIKAN, berkas dipakai utuh (token lama di profil shell tidak mengalahkan hasil register)", () => {
    saveRelayConfig(home, saved);
    expect(resolveRelayConfig({ AGENTMON_RELAY_TOKEN: OTHER }, home)).toEqual({ ...saved, source: "file" });
  });

  test("hanya token dari lingkungan dan tidak ada berkas: tidak ada pengaturan", () => {
    expect(resolveRelayConfig({ AGENTMON_RELAY_TOKEN: OTHER }, home)).toBeUndefined();
  });

  test("berkas rusak tanpa lingkungan lengkap: melempar galat (berhenti dengan penjelasan, bukan diam-diam tanpa relay)", () => {
    writeFileSync(paths(home).relay, "{rusak");
    expect(() => resolveRelayConfig({}, home)).toThrow(/rusak/);
  });
});
