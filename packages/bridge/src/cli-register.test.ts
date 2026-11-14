import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli";
import { paths } from "./home";
import { loadRelayConfig, saveRelayConfig } from "./relay-config";

const SECRET = "rahasia-admin-yang-panjang-0123456789abcdef";
const RELAY = "https://relay.contoh.com";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentmon-cli-register-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Seen = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> };

// Relay palsu yang meniru perilaku sebenarnya: pendaftaran butuh rahasia admin dan memberi token; sisanya butuh token itu.
function fakeRelay() {
  const seen: Seen[] = [];
  const state: { token?: string } = {};
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    seen.push({ url: String(input), method: init?.method ?? "GET", headers, ...(body ? { body } : {}) });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
    if (url.pathname === "/admin/machines") {
      if (headers.authorization !== `Bearer ${SECRET}`) return json(401, { error: "unauthorized" });
      state.token = "d".repeat(64);
      return json(201, { machineId: body?.id, token: state.token });
    }
    if (headers.authorization !== `Bearer ${state.token}`) return json(401, { error: "unauthorized" });
    if (url.pathname === "/pair/devices") return json(200, { devices: [] });
    return json(404, {});
  }) as typeof fetch;
  return { fetchFake, seen, state };
}

function run(argv: string[], env: Record<string, string | undefined>, fetchFake?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, {
    env: { AGENTMON_HOME: home, ...env },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    hostname: () => "Laptop-Budi",
    ...(fetchFake ? { pair: { fetch: fetchFake } } : {}),
  });
  return { code, out, err, all: () => [...out, ...err].join("\n") };
}

describe("perintah register", () => {
  test("mendaftar lalu menyimpan: relay dari AGENTMON_RELAY_URL dan rahasia dari AGENTMON_ADMIN_SECRET", async () => {
    const relay = fakeRelay();
    const r = run(["register"], { AGENTMON_RELAY_URL: RELAY, AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake);
    expect(await r.code).toBe(0);
    expect(relay.seen[0]!.url).toBe(`${RELAY}/admin/machines`);
    expect(relay.seen[0]!.body).toMatchObject({ name: "Laptop-Budi" });
    expect(loadRelayConfig(home)).toEqual({ relayUrl: RELAY, token: relay.state.token });
    expect(r.all()).not.toContain(relay.state.token as string);
    expect(r.all()).not.toContain(SECRET);
  });

  test("--relay menggantikan alamat dari lingkungan, dan --name serta --print-token bekerja", async () => {
    const relay = fakeRelay();
    const r = run(["register", "--relay", "https://lain.contoh.com", "--name", "Laptop Kantor", "--print-token"], { AGENTMON_RELAY_URL: RELAY, AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake);
    expect(await r.code).toBe(0);
    expect(relay.seen[0]!.url).toBe("https://lain.contoh.com/admin/machines");
    expect(relay.seen[0]!.body).toMatchObject({ name: "Laptop Kantor" });
    expect(r.out.join("\n")).toContain(`AGENTMON_RELAY_TOKEN=${relay.state.token}`);
  });

  test("--rotate meneruskan rotate ke relay", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "z".repeat(64) });
    const relay = fakeRelay();
    expect(await run(["register", "--rotate"], { AGENTMON_RELAY_URL: RELAY, AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake).code).toBe(0);
    expect(relay.seen[0]!.body).toMatchObject({ rotate: true });
  });

  test("tanpa alamat atau tanpa rahasia: disebut satu per satu, relay tidak dihubungi", async () => {
    const relay = fakeRelay();
    const noSecret = run(["register"], { AGENTMON_RELAY_URL: RELAY }, relay.fetchFake);
    expect(await noSecret.code).toBe(1);
    expect(noSecret.err.join("\n")).toContain("AGENTMON_ADMIN_SECRET");
    expect(noSecret.err.join("\n")).not.toContain("Belum diisi: alamat relay");
    const noUrl = run(["register"], { AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake);
    expect(await noUrl.code).toBe(1);
    expect(noUrl.err.join("\n")).toContain("alamat relay");
    expect(relay.seen).toEqual([]);
  });

  test("rahasia admin TIDAK diterima lewat argumen perintah (tercatat di riwayat shell)", async () => {
    const relay = fakeRelay();
    const r = run(["register", "--secret", SECRET], { AGENTMON_RELAY_URL: RELAY, AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake);
    expect(await r.code).toBe(2);
    expect(relay.seen).toEqual([]);
    expect(r.all()).not.toContain(SECRET); // tidak menggemakan rahasia kembali
  });

  test.each([
    [["register", "--name"], "--name butuh nilai"],
    [["register", "--relay"], "--relay butuh nilai"],
    [["register", "--name", "--rotate"], "--name butuh nilai"],
    [["register", "--tidak-ada"], "Pilihan tidak dikenal"],
    [["register", "kata-liar"], "Argumen tidak dikenal"],
  ])("pemakaian salah %j: kode 2 dan relay tidak dihubungi", async (argv, message) => {
    const relay = fakeRelay();
    const r = run(argv, { AGENTMON_RELAY_URL: RELAY, AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake);
    expect(await r.code).toBe(2);
    expect(r.err.join("\n")).toContain(message);
    expect(relay.seen).toEqual([]);
  });

  test("AGENTMON_RELAY_INSECURE=1 mengizinkan http ke host lain; tanpa itu ditolak", async () => {
    const relay = fakeRelay();
    const env = { AGENTMON_RELAY_URL: "http://192.168.1.5:8787", AGENTMON_ADMIN_SECRET: SECRET };
    expect(await run(["register"], env, relay.fetchFake).code).toBe(2);
    expect(relay.seen).toEqual([]);
    expect(await run(["register"], { ...env, AGENTMON_RELAY_INSECURE: "1" }, relay.fetchFake).code).toBe(0);
  });

  test("rahasia admin yang keliru diketik sebagai argumen biasa tidak digemakan ke layar", async () => {
    const relay = fakeRelay();
    const r = run(["register", SECRET], { AGENTMON_RELAY_URL: RELAY, AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake);
    expect(await r.code).toBe(2);
    expect(r.all()).not.toContain(SECRET);
    expect(r.err.join("\n")).toContain("AGENTMON_ADMIN_SECRET");
    expect(relay.seen).toEqual([]);
  });

  test("tampil di bantuan pemakaian", async () => {
    const r = run(["bukan-perintah"], {});
    expect(await r.code).toBe(2);
    expect(r.err.join("\n")).toContain("register");
  });
});

describe("perintah lain memakai pengaturan tersimpan", () => {
  test("devices tanpa variabel lingkungan: memakai alamat dan token dari berkas", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "e".repeat(64) });
    const relay = fakeRelay();
    relay.state.token = "e".repeat(64);
    expect(await run(["devices"], {}, relay.fetchFake).code).toBe(0);
    expect(relay.seen[0]!.url).toBe(`${RELAY}/pair/devices`);
    expect(relay.seen[0]!.headers.authorization).toBe(`Bearer ${"e".repeat(64)}`);
  });

  test("revoke juga memakai pengaturan tersimpan", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "e".repeat(64) });
    const relay = fakeRelay();
    relay.state.token = "e".repeat(64);
    await run(["revoke", "d1"], {}, relay.fetchFake).code;
    expect(relay.seen[0]!.url).toBe(`${RELAY}/pair/devices/d1`);
    expect(relay.seen[0]!.method).toBe("DELETE");
    expect(relay.seen[0]!.headers.authorization).toBe(`Bearer ${"e".repeat(64)}`);
  });

  test("pair memakai pengaturan tersimpan, dan hanya butuh AGENTMON_APP_URL dari lingkungan", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "e".repeat(64) });
    const relay = fakeRelay();
    relay.state.token = "e".repeat(64);
    const r = run(["pair"], {}, relay.fetchFake);
    expect(await r.code).toBe(1);
    expect(r.err.join("\n")).toContain("AGENTMON_APP_URL");
    expect(r.err.join("\n")).not.toContain("belum terhubung ke relay");
    expect(relay.seen).toEqual([]);
  });

  test("lingkungan lengkap menang atas berkas", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "e".repeat(64) });
    const relay = fakeRelay();
    relay.state.token = "f".repeat(64);
    expect(await run(["devices"], { AGENTMON_RELAY_URL: "https://lain.contoh.com", AGENTMON_RELAY_TOKEN: "f".repeat(64) }, relay.fetchFake).code).toBe(0);
    expect(relay.seen[0]!.url).toBe("https://lain.contoh.com/pair/devices");
  });

  test("alamat dari lingkungan berbeda dari berkas dan tanpa token: token berkas TIDAK dikirim ke relay lain", async () => {
    saveRelayConfig(home, { relayUrl: RELAY, token: "e".repeat(64) });
    const relay = fakeRelay();
    const r = run(["devices"], { AGENTMON_RELAY_URL: "https://relay-lain.example" }, relay.fetchFake);
    expect(await r.code).toBe(1);
    expect(relay.seen).toEqual([]);
    expect(r.all()).not.toContain("e".repeat(64));
  });

  test("belum terdaftar dan tanpa lingkungan: dijelaskan, tanpa menyentuh jaringan", async () => {
    const relay = fakeRelay();
    for (const argv of [["devices"], ["revoke", "d1"]]) {
      const r = run(argv, {}, relay.fetchFake);
      expect(await r.code).toBe(1);
      expect(r.err.join("\n")).toContain("register");
    }
    expect(relay.seen).toEqual([]);
  });

  test("berkas pengaturan rusak: berhenti dengan penjelasan yang menyebut lokasinya", async () => {
    writeFileSync(paths(home).relay, "{rusak");
    const relay = fakeRelay();
    const r = run(["devices"], {}, relay.fetchFake);
    expect(await r.code).toBe(1);
    expect(r.err.join("\n")).toContain(paths(home).relay);
    expect(relay.seen).toEqual([]);
  });
});

describe("satu putaran: daftar, lalu perintah lain langsung bisa dipakai tanpa menyalin token", () => {
  test("register -> devices memakai token yang baru dibuat relay", async () => {
    const relay = fakeRelay();
    expect(await run(["register"], { AGENTMON_RELAY_URL: RELAY, AGENTMON_ADMIN_SECRET: SECRET }, relay.fetchFake).code).toBe(0);
    const saved = JSON.parse(readFileSync(paths(home).relay, "utf8")) as { token: string };
    const devices = run(["devices"], {}, relay.fetchFake);
    expect(await devices.code).toBe(0);
    const last = relay.seen.at(-1)!;
    expect(last.url).toBe(`${RELAY}/pair/devices`);
    expect(last.headers.authorization).toBe(`Bearer ${saved.token}`);
  });
});
