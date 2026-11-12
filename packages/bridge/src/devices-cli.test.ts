import { describe, expect, test } from "vitest";
import { runCli } from "./cli";

const ENV = { AGENTMON_RELAY_URL: "https://relay.contoh.com/", AGENTMON_RELAY_TOKEN: "machine-token-0000000000000000" };

function harness(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>, env: Record<string, string | undefined> = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ url: string; method: string; auth: string | undefined }> = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    return respond(url, init);
  }) as typeof fetch;
  const run = (argv: string[]) => runCli(argv, { env, out: (t) => out.push(t), err: (t) => err.push(t), pair: { fetch: fetchFake } });
  return { run, out, err, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("devices", () => {
  test("mencetak nomor, nama, dan waktu pasang tiap HP, dengan token laptop", async () => {
    const h = harness(() => json({ devices: [{ id: "d1", name: "HP Ani", pairedAt: "2026-11-01T00:00:00.000Z" }] }));
    expect(await h.run(["devices"])).toBe(0);
    expect(h.calls).toEqual([{ url: "https://relay.contoh.com/pair/devices", method: "GET", auth: `Bearer ${ENV.AGENTMON_RELAY_TOKEN}` }]);
    expect(h.out.join("\n")).toContain("d1  HP Ani");
  });

  test("nama perangkat yang berisi karakter kontrol tidak mengendalikan terminal", async () => {
    const h = harness(() => json({ devices: [{ id: "d1", name: "HP\u001b[2J‮jahat", pairedAt: "2026-11-01T00:00:00.000Z" }] }));
    await h.run(["devices"]);
    const printed = h.out.join("\n");
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("‮");
    expect(printed).toContain("HP?[2J?jahat");
  });

  test("tanpa HP: pesan yang jelas, kode keluar 0", async () => {
    const h = harness(() => json({ devices: [] }));
    expect(await h.run(["devices"])).toBe(0);
    expect(h.out.join("\n")).toContain("Tidak ada HP");
  });

  test("relay menolak token, tidak terjangkau, atau menjawab aneh: kode keluar 1 dengan penjelasan", async () => {
    expect(await harness(() => json({}, 401)).run(["devices"])).toBe(1);
    const down = harness(() => Promise.reject(new Error("putus")));
    expect(await down.run(["devices"])).toBe(1);
    expect(down.err.join("\n")).toContain("tidak terjangkau");
    expect(await harness(() => json({ aneh: true })).run(["devices"])).toBe(1);
  });

  test("variabel lingkungan kurang: 1, tanpa memanggil jaringan", async () => {
    const h = harness(() => json({}), {});
    expect(await h.run(["devices"])).toBe(1);
    expect(h.calls).toHaveLength(0);
  });
});

describe("revoke", () => {
  test("mengirim DELETE untuk nomor itu (di-encode), dan melapor berhasil", async () => {
    const h = harness(() => json({ ok: true }));
    expect(await h.run(["revoke", "d 3/x"])).toBe(0);
    expect(h.calls).toEqual([{ url: "https://relay.contoh.com/pair/devices/d%203%2Fx", method: "DELETE", auth: `Bearer ${ENV.AGENTMON_RELAY_TOKEN}` }]);
    expect(h.out.join("\n")).toContain("HP dicabut");
  });

  test("tanpa nomor: 2 dan tidak ada panggilan jaringan", async () => {
    const h = harness(() => json({ ok: true }));
    expect(await h.run(["revoke"])).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  test("nomor tidak dikenal (404): 1 dengan petunjuk; token ditolak (401): 1 dan menegaskan BELUM dicabut", async () => {
    const notFound = harness(() => json({ error: "not-found" }, 404));
    expect(await notFound.run(["revoke", "hantu"])).toBe(1);
    expect(notFound.err.join("\n")).toContain("devices");
    const denied = harness(() => json({}, 401));
    expect(await denied.run(["revoke", "d1"])).toBe(1);
    expect(denied.err.join("\n")).toContain("BELUM dicabut");
  });

  test("relay tidak terjangkau atau error server: 1 dan jujur bahwa HP mungkin belum dicabut (tidak melapor berhasil)", async () => {
    const down = harness(() => Promise.reject(new Error("putus")));
    expect(await down.run(["revoke", "d1"])).toBe(1);
    expect(down.err.join("\n")).toContain("BELUM dicabut");
    expect(down.out).toEqual([]);
    const broken = harness(() => json({}, 500));
    expect(await broken.run(["revoke", "d1"])).toBe(1);
    expect(broken.out).toEqual([]);
  });
});
