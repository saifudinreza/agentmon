import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DaemonAlreadyRunningError, startDaemon, type RunningDaemon } from "./daemon";
import { loadOrCreateMachineId, paths } from "./home";

let home: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentmon-test-"));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// Memakai node:http (bukan fetch) supaya header seperti Host dan Origin bisa diatur bebas.
function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/health", headers: options.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const auth = (d: RunningDaemon) => ({ authorization: `Bearer ${d.token}` });
const json = { "content-type": "application/json" };

async function start(options: Parameters<typeof startDaemon>[0] = {}) {
  daemon = await startDaemon({ home, port: 0, ...options });
  return daemon;
}

describe("penjaga pintu", () => {
  test("permintaan dengan token yang benar diterima", async () => {
    const d = await start();
    const res = await send(d.port, { headers: auth(d) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", pid: process.pid });
  });

  test.each([
    ["tanpa token", {}],
    ["token salah", { authorization: `Bearer ${"0".repeat(64)}` }],
    ["skema bukan Bearer", { authorization: "Basic abc" }],
  ])("menolak %s dengan 401", async (_name, headers) => {
    const d = await start();
    const res = await send(d.port, { headers });
    expect(res.status).toBe(401);
  });

  test("token di query string tidak diterima", async () => {
    const d = await start();
    const res = await send(d.port, { path: `/health?token=${d.token}` });
    expect(res.status).toBe(401);
  });

  test.each([
    ["Origin", { origin: "https://situs-jahat.example" }],
    ["Sec-Fetch-Site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Mode", { "sec-fetch-mode": "cors" }],
  ])("menolak request dari browser (%s) walau tokennya benar", async (_name, extra) => {
    const d = await start();
    const res = await send(d.port, { headers: { ...auth(d), ...extra } });
    expect(res.status).toBe(403);
  });

  test("menolak Host yang bukan loopback (DNS rebinding)", async () => {
    const d = await start();
    const res = await send(d.port, { headers: { ...auth(d), host: `situs-jahat.example:${d.port}` } });
    expect(res.status).toBe(403);
  });

  test("menerima Host localhost", async () => {
    const d = await start();
    const res = await send(d.port, { headers: { ...auth(d), host: `localhost:${d.port}` } });
    expect(res.status).toBe(200);
  });

  test("tidak mengirim header CORS, jadi browser tidak bisa membaca jawabannya", async () => {
    const d = await start();
    const res = await send(d.port, { headers: auth(d) });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("preflight OPTIONS dari browser ditolak", async () => {
    const d = await start();
    const res = await send(d.port, { method: "OPTIONS", path: "/hook", headers: { origin: "https://x.example" } });
    expect(res.status).toBe(403);
  });
});

describe("jaringan", () => {
  test("hanya mendengarkan di 127.0.0.1", async () => {
    const d = await start();
    // Mencoba tersambung lewat alamat jaringan laptop ini (bukan loopback) harus gagal.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!external) return; // tidak ada kartu jaringan selain loopback (misalnya di sebagian CI)
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: external, port: d.port, timeout: 1500 });
      socket.on("connect", () => {
        socket.destroy();
        resolve("tersambung");
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve("timeout");
      });
      socket.on("error", () => resolve("ditolak"));
    });
    expect(outcome).not.toBe("tersambung");
  });
});

describe("hook", () => {
  const input = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { content: "RAHASIA-123" } };
  const post = (d: RunningDaemon, body: string, headers: Record<string, string> = json) =>
    send(d.port, { method: "POST", path: "/hook", headers: { ...auth(d), ...headers }, body });

  test("menjawab input hook dengan {} bila tidak ada penangan", async () => {
    const d = await start();
    const res = await post(d, JSON.stringify(input));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });

  test("meneruskan input ke penangan dan mengembalikan keputusannya", async () => {
    const seen: string[] = [];
    const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } };
    const d = await start({
      onHook: (hook) => {
        seen.push(hook.hook_event_name);
        return decision;
      },
    });
    const res = await post(d, JSON.stringify(input));
    expect(seen).toEqual(["PreToolUse"]);
    expect(JSON.parse(res.body)).toEqual(decision);
  });

  test("penangan yang error tetap dijawab {} (tanpa keputusan, bukan persetujuan)", async () => {
    const d = await start({
      onHook: () => {
        throw new Error("rusak");
      },
    });
    const res = await post(d, JSON.stringify(input));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
    expect(readFileSync(paths(home).log, "utf8")).toContain("penangan hook gagal: rusak");
  });

  test.each([
    ["JSON rusak", "{bukan json", 400],
    ["bukan objek hook", JSON.stringify({ halo: 1 }), 400],
    ["array", JSON.stringify([1, 2]), 400],
  ])("menolak %s", async (_name, body, status) => {
    const d = await start();
    expect((await post(d, body)).status).toBe(status);
  });

  test("menolak content-type selain JSON", async () => {
    const d = await start();
    const res = await post(d, JSON.stringify(input), { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });

  test("menolak isi yang terlalu besar dengan 413 dan tetap hidup", async () => {
    const d = await start({ maxBodyBytes: 1024 });
    const res = await post(d, JSON.stringify({ hook_event_name: "PostToolUse", pad: "x".repeat(5000) }));
    expect(res.status).toBe(413);
    expect((await send(d.port, { headers: auth(d) })).status).toBe(200);
  });

  test("rute dan metode yang tidak dikenal", async () => {
    const d = await start();
    expect((await send(d.port, { path: "/nama-lain", headers: auth(d) })).status).toBe(404);
    expect((await send(d.port, { path: "/hook", headers: auth(d) })).status).toBe(405);
    expect((await send(d.port, { method: "POST", path: "/health", headers: auth(d) })).status).toBe(405);
  });
});

describe("log", () => {
  test("mencatat nama event tetapi tidak isi pesan", async () => {
    const d = await start();
    await send(d.port, {
      method: "POST",
      path: "/hook",
      headers: { ...auth(d), ...json },
      body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { content: "RAHASIA-123" } }),
    });
    const log = readFileSync(paths(home).log, "utf8");
    expect(log).toContain("hook PreToolUse alat=Write");
    expect(log).not.toContain("RAHASIA-123");
    expect(log).not.toContain(d.token);
  });

  test("baris baru dari input luar tidak bisa memalsukan baris log", async () => {
    const d = await start();
    await send(d.port, { path: "/baris%0A2099-01-01T00:00:00.000Z%20INFO%20palsu", headers: {} });
    const lines = readFileSync(paths(home).log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes("palsu"))).toHaveLength(1);
    expect(lines.every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z (INFO|ERROR) /.test(l))).toBe(true);
  });

  test("berputar saat melewati batas ukuran", async () => {
    const d = await start({ logMaxBytes: 400 });
    for (let i = 0; i < 12; i++) {
      await send(d.port, { method: "POST", path: "/hook", headers: { ...auth(d), ...json }, body: JSON.stringify({ hook_event_name: "Stop" }) });
    }
    const file = paths(home).log;
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(400);
  });
});

describe("satu daemon saja", () => {
  test("daemon kedua di port yang sama ditolak tanpa mengganggu yang pertama", async () => {
    const first = await start();
    const second = startDaemon({ home, port: first.port });
    await expect(second).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    await expect(second).rejects.toMatchObject({ pid: process.pid, port: first.port });
    expect((await send(first.port, { headers: auth(first) })).status).toBe(200);
  });

  test("port yang dipakai program lain dilaporkan dengan jelas", async () => {
    const other = await startDaemon({ home: mkdtempSync(join(tmpdir(), "agentmon-lain-")), port: 0 });
    try {
      await expect(startDaemon({ home, port: other.port })).rejects.toThrow(/AGENTMON_PORT/);
    } finally {
      await other.stop();
      rmSync(other.home, { recursive: true, force: true });
    }
  });

  test("mencatat status di daemon.json dan menghapusnya saat berhenti", async () => {
    const d = await start();
    const state = JSON.parse(readFileSync(paths(home).state, "utf8")) as { pid: number; port: number };
    expect(state).toMatchObject({ pid: process.pid, port: d.port });
    await d.stop();
    daemon = undefined;
    expect(existsSync(paths(home).state)).toBe(false);
  });

  test("daemon.json basi dari sesi sebelumnya tidak menghalangi start", async () => {
    const first = await start();
    // Meniru daemon yang mati mendadak: status tertinggal, tetapi portnya sudah bebas.
    await first.stop();
    daemon = undefined;
    const again = await start();
    expect(again.port).toBeGreaterThan(0);
  });
});

describe("kegagalan tidak pernah menjadi persetujuan", () => {
  const hookInput = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write" });
  const postHook = (d: RunningDaemon, body = hookInput, headers: Record<string, string> = { ...auth(d), ...json }) =>
    send(d.port, { method: "POST", path: "/hook", headers, body });

  // Kata yang menandakan keputusan dari hook. Tidak boleh muncul di jawaban kegagalan mana pun.
  const decisionWords = ["permissionDecision", "behavior", '"decision"', "allow", "updatedInput"];

  const cases: {
    name: string;
    options?: Parameters<typeof startDaemon>[0];
    call: (d: RunningDaemon) => Promise<Reply>;
    status: number;
  }[] = [
    {
      name: "penangan melempar error",
      options: {
        onHook: () => {
          throw new Error("rusak");
        },
      },
      call: (d) => postHook(d),
      status: 200,
    },
    {
      name: "penangan menolak (promise gagal)",
      options: { onHook: () => Promise.reject(new Error("rusak")) },
      call: (d) => postHook(d),
      status: 200,
    },
    { name: "penangan tidak memberi jawaban", options: { onHook: () => undefined }, call: (d) => postHook(d), status: 200 },
    { name: "JSON rusak", call: (d) => postHook(d, "{rusak"), status: 400 },
    { name: "bukan input hook", call: (d) => postHook(d, JSON.stringify({ a: 1 })), status: 400 },
    { name: "content-type salah", call: (d) => postHook(d, hookInput, { ...auth(d), "content-type": "text/plain" }), status: 415 },
    {
      name: "isi terlalu besar",
      options: { maxBodyBytes: 512 },
      call: (d) => postHook(d, JSON.stringify({ hook_event_name: "PostToolUse", pad: "x".repeat(3000) })),
      status: 413,
    },
    { name: "tanpa token", call: (d) => postHook(d, hookInput, json), status: 401 },
    { name: "token salah", call: (d) => postHook(d, hookInput, { authorization: `Bearer ${"0".repeat(64)}`, ...json }), status: 401 },
    { name: "dari browser", call: (d) => postHook(d, hookInput, { ...auth(d), ...json, origin: "https://situs.example" }), status: 403 },
    { name: "rute tidak dikenal", call: (d) => send(d.port, { method: "POST", path: "/lain", headers: { ...auth(d), ...json }, body: hookInput }), status: 404 },
  ];

  test.each(cases)("$name", async ({ options, call, status }) => {
    const d = await start(options);
    const res = await call(d);
    expect(res.status).toBe(status);
    // Kegagalan yang tetap dijawab 200 harus berupa "tanpa keputusan", yaitu {}.
    if (status === 200) expect(res.body).toBe("{}");
    for (const word of decisionWords) expect(res.body).not.toContain(word);
  });
});

describe("token", () => {
  test("dibuat acak, disimpan, dan dipakai ulang", async () => {
    const first = await start();
    const token = first.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await first.stop();
    daemon = undefined;
    expect((await start()).token).toBe(token);
  });

  test.skipIf(process.platform === "win32")("berkas token hanya bisa dibaca pemilik", async () => {
    await start();
    expect(statSync(paths(home).token).mode & 0o777).toBe(0o600);
  });

  test("berkas token yang rusak dilaporkan, bukan diganti diam-diam", async () => {
    writeFileSync(paths(home).token, "bukan-token\n");
    await expect(startDaemon({ home, port: 0 })).rejects.toThrow(/Berkas token rusak/);
  });
});

describe("machine-id", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("dibuat acak berbentuk UUID, disimpan, dan dipakai ulang", () => {
    const first = loadOrCreateMachineId(home);
    expect(first).toMatch(UUID);
    expect(loadOrCreateMachineId(home)).toBe(first);
  });

  test.each([
    ["kosong", ""],
    ["teks sembarang", "bukan-uuid"],
    ["UUID terpotong", "5ccc8384-b91c-4e59-a5ee"],
  ])("berkas yang rusak (%s) dilaporkan, bukan dipakai diam-diam", (_name, content) => {
    writeFileSync(paths(home).machineId, content + "\n");
    expect(() => loadOrCreateMachineId(home)).toThrow(/Berkas machine-id rusak/);
  });
});

describe("token hook terpisah dari token kendali (issue #82)", () => {
  const hookAuth = (d: RunningDaemon) => ({ authorization: `Bearer ${d.hookToken}` });
  const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" });

  test("dua token berbeda, tersimpan di dua berkas, dan token hook stabil antar-restart", async () => {
    const d = await start();
    expect(d.hookToken).toMatch(/^[0-9a-f]{64}$/);
    expect(d.hookToken).not.toBe(d.token);
    expect(readFileSync(paths(home).hookToken, "utf8").trim()).toBe(d.hookToken);
    const first = d.hookToken;
    await d.stop();
    daemon = undefined;
    expect((await start()).hookToken).toBe(first);
  });

  test("token hook bisa memanggil /hook", async () => {
    const d = await start();
    const res = await send(d.port, { method: "POST", path: "/hook", headers: { ...hookAuth(d), ...json }, body: input });
    expect(res.status).toBe(200);
  });

  test.each([
    ["GET", "/health"],
    ["GET", "/status"],
    ["POST", "/pause"],
    ["POST", "/resume"],
    ["POST", "/stop"],
    ["POST", "/decision/abc"],
    ["POST", "/approve"],
    ["POST", "/deny"],
    ["GET", "/dev/api/approvals"],
  ])("token hook TIDAK bisa memanggil %s %s (403, tidak ada yang berubah)", async (method, path) => {
    let stopped = 0;
    const d = await start({ onStop: () => (stopped += 1) });
    const res = await send(d.port, { method, path, headers: { ...hookAuth(d), ...json }, ...(method === "POST" ? { body: "{}" } : {}) });
    expect([401, 403]).toContain(res.status);
    if (!path.startsWith("/dev")) expect(res.status).toBe(403);
    expect(stopped).toBe(0);
    const status = await send(d.port, { path: "/status", headers: auth(d) });
    expect(JSON.parse(status.body).paused).toBeFalsy();
  });

  test("jalur keputusan yang SUNGGUHAN (/decision) dan variasi jalur/metode: tetap 403 untuk token hook, tidak ada izin yang terjawab", async () => {
    const d = await start();
    for (const [method, path] of [["POST", "/decision"], ["GET", "//hook"], ["GET", "/HOOK"], ["GET", "/hook/.."], ["GET", "/./hook"], ["HEAD", "/status"], ["OPTIONS", "/status"], ["OPTIONS", "/pause"]] as const) {
      const res = await send(d.port, { method, path, headers: { ...hookAuth(d), ...json }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  test("/hook dengan query tetap diterima untuk token hook; metode selain POST dijawab 405 (token diterima)", async () => {
    const d = await start();
    expect((await send(d.port, { method: "POST", path: "/hook?x=1", headers: { ...hookAuth(d), ...json }, body: input })).status).toBe(200);
    expect((await send(d.port, { method: "GET", path: "/hook", headers: hookAuth(d) })).status).toBe(405);
  });

  test("token kendali tetap bisa memanggil semuanya, termasuk /hook (pemasangan lama yang belum menjalankan setup ulang)", async () => {
    const d = await start();
    expect((await send(d.port, { path: "/status", headers: auth(d) })).status).toBe(200);
    expect((await send(d.port, { method: "POST", path: "/hook", headers: { ...auth(d), ...json }, body: input })).status).toBe(200);
  });

  test("token yang salah tetap 401 (bukan 403)", async () => {
    const d = await start();
    expect((await send(d.port, { path: "/status", headers: { authorization: `Bearer ${"0".repeat(64)}` } })).status).toBe(401);
  });
});
