import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClaudeCodeHandler } from "./adapters/claude-code-handler";
import { startDaemon, type RunningDaemon } from "./daemon";
import { truncateInput } from "./dev-ui";
import { createTimeline } from "./timeline";

let home: string;
let work: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentmon-devui-home-"));
  work = mkdtempSync(join(tmpdir(), "agentmon-devui-work-"));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function send(
  d: RunningDaemon,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string; token?: boolean | string; json?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token !== false) headers.authorization = `Bearer ${typeof options.token === "string" ? options.token : d.token}`;
    if (options.body !== undefined && options.json !== false) headers["content-type"] = "application/json";
    const req = request({ host: "127.0.0.1", port: d.port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
const json = (reply: Reply) => JSON.parse(reply.body) as Record<string, unknown>;

async function start(options: { devUi?: boolean; holdEnabled?: boolean } = {}) {
  const timeline = createTimeline();
  daemon = await startDaemon({
    home,
    port: 0,
    devUi: options.devUi ?? true,
    holdEnabled: options.holdEnabled ?? true,
    timeline,
    onHook: createClaudeCodeHandler({ emit: (event) => timeline.record(event) }),
  });
  return daemon;
}

// Header yang dipasang browser untuk request dari halaman milik daemon sendiri.
const fromOwnPage = (d: RunningDaemon) => ({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", origin: `http://127.0.0.1:${d.port}` });

describe("mati secara bawaan", () => {
  test("tanpa devUi, alamat /dev tidak ada sama sekali (404 dengan token, 401 tanpa token)", async () => {
    const d = await start({ devUi: false });
    for (const path of ["/dev", "/dev/api/state", "/dev/api/decision"]) {
      expect((await send(d, "GET", path)).status, path).toBe(404);
      expect((await send(d, "GET", path, { token: false })).status, path).toBe(401);
    }
  });

  test("tanpa devUi, request dari browser ke /dev ditolak oleh penjaga biasa (403)", async () => {
    const d = await start({ devUi: false });
    expect((await send(d, "GET", "/dev", { headers: fromOwnPage(d) })).status).toBe(403);
  });

  test("daemon yang dibuat tanpa mengatur apa pun tidak menyalakan halaman", async () => {
    daemon = await startDaemon({ home, port: 0 });
    expect((await send(daemon, "GET", "/dev")).status).toBe(404);
  });
});

describe("halaman HTML", () => {
  test("dilayani tanpa token karena hanya berisi kode, tanpa data atau rahasia", async () => {
    const d = await start();
    const page = await send(d, "GET", "/dev", { token: false });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).not.toContain(d.token);
    expect(page.body).toContain("AgentMon");
  });

  test("dipagari CSP yang ketat, dan kode acak (nonce) di header sama dengan yang ada di halaman", async () => {
    const d = await start();
    const page = await send(d, "GET", "/dev", { token: false });
    const csp = String(page.headers["content-security-policy"]);
    for (const directive of [
      "default-src 'none'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    expect(page.body).toContain(`<style nonce="${nonce}">`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
  });

  test("setiap pemuatan mendapat kode acak yang berbeda", async () => {
    const d = await start();
    const nonceOf = async () => /script-src 'nonce-([^']+)'/.exec(String((await send(d, "GET", "/dev", { token: false })).headers["content-security-policy"]))?.[1];
    expect(await nonceOf()).not.toBe(await nonceOf());
  });

  test("kode halaman tidak memakai API berbahaya (data agent hanya boleh dirender sebagai teks)", async () => {
    const d = await start();
    const page = (await send(d, "GET", "/dev", { token: false })).body;
    const forbidden = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /setTimeout\s*\(\s*["']/, /setInterval\s*\(\s*["']/, /javascript:/i];
    for (const pattern of forbidden) expect(pattern.test(page), String(pattern)).toBe(false);
    // Yang dipakai: elemen teks.
    expect(page).toContain("createTextNode");
  });

  test("tidak memuat sumber dari luar (skrip, gaya, atau gambar dari alamat lain)", async () => {
    const d = await start();
    const page = (await send(d, "GET", "/dev", { token: false })).body;
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).not.toMatch(/<link[^>]+href=/i);
    expect(page).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  test("hanya GET yang diterima (405)", async () => {
    const d = await start();
    expect((await send(d, "POST", "/dev", { token: false, body: "{}" })).status).toBe(405);
  });

  test("Host yang salah ditolak (DNS rebinding)", async () => {
    const d = await start();
    expect((await send(d, "GET", "/dev", { token: false, headers: { host: "penyerang.example" } })).status).toBe(403);
    expect((await send(d, "GET", "/dev/api/state", { headers: { host: "penyerang.example" } })).status).toBe(403);
  });

  test("Origin dari situs lain ditolak walau hanya membuka halaman", async () => {
    const d = await start();
    expect((await send(d, "GET", "/dev", { token: false, headers: { origin: "https://situs-jahat.example" } })).status).toBe(403);
  });
});

describe("API: kredensial dan asal request", () => {
  test.each([
    ["GET", "/dev/api/state"],
    ["POST", "/dev/api/decision"],
    ["POST", "/dev/api/pause"],
    ["POST", "/dev/api/resume"],
  ])("%s %s tanpa token atau dengan token salah -> 401", async (method, path) => {
    const d = await start();
    const body = method === "POST" ? "{}" : undefined;
    expect((await send(d, method, path, { token: false, ...(body ? { body } : {}) })).status).toBe(401);
    expect((await send(d, method, path, { token: "0".repeat(64), ...(body ? { body } : {}) })).status).toBe(401);
  });

  test("request lintas situs ditolak walau tokennya benar", async () => {
    const d = await start();
    for (const site of ["cross-site", "same-site"]) {
      expect((await send(d, "GET", "/dev/api/state", { headers: { "sec-fetch-site": site } })).status, site).toBe(403);
    }
    expect((await send(d, "GET", "/dev/api/state", { headers: { origin: "https://situs-jahat.example" } })).status).toBe(403);
    // Pembatalan lintas situs (CSRF) tidak berhasil mengubah apa pun.
    expect((await send(d, "POST", "/dev/api/pause", { body: "{}", headers: { "sec-fetch-site": "cross-site", origin: "https://situs-jahat.example" } })).status).toBe(403);
    expect(d.control.isPaused()).toBe(false);
  });

  test("request dari halaman milik daemon sendiri (same-origin) dengan token diterima", async () => {
    const d = await start();
    expect((await send(d, "GET", "/dev/api/state", { headers: fromOwnPage(d) })).status).toBe(200);
  });

  test("request dari program non-browser (tanpa penanda apa pun) dengan token diterima", async () => {
    const d = await start();
    expect((await send(d, "GET", "/dev/api/state")).status).toBe(200);
  });

  test("pelonggaran HANYA untuk /dev: endpoint lain tetap menolak semua request dari browser", async () => {
    const d = await start();
    for (const [method, path] of [["GET", "/status"], ["POST", "/pause"], ["POST", "/decision"], ["GET", "/health"]] as const) {
      expect((await send(d, method, path, { headers: fromOwnPage(d), ...(method === "POST" ? { body: "{}" } : {}) })).status, path).toBe(403);
    }
  });

  test("metode yang salah ditolak (405)", async () => {
    const d = await start();
    expect((await send(d, "POST", "/dev/api/state", { body: "{}" })).status).toBe(405);
    expect((await send(d, "GET", "/dev/api/decision")).status).toBe(405);
    expect((await send(d, "GET", "/dev/api/pause")).status).toBe(405);
  });

  test("alamat /dev/... yang tidak dikenal -> 404 (setelah kredensial diperiksa)", async () => {
    const d = await start();
    expect((await send(d, "GET", "/dev/api/lain")).status).toBe(404);
    expect((await send(d, "GET", "/dev/api/lain", { token: false })).status).toBe(401);
  });

  test("jawaban API berupa JSON dengan nosniff, bukan HTML (isi hostile tidak bisa dieksekusi)", async () => {
    const d = await start();
    const reply = await send(d, "GET", "/dev/api/state");
    expect(String(reply.headers["content-type"])).toContain("application/json");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("API: isi keadaan dan keputusan", () => {
  const hook = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "sesi-1234567890",
      cwd: work,
      tool_name: "Write",
      tool_input: { file_path: "baru.txt", content: "satu\ndua\n" },
      ...extra,
    });

  test("izin yang menunggu tampil lengkap dengan diff, sedangkan timeline hanya ringkasan", async () => {
    const d = await start();
    const answered = send(d, "POST", "/hook", { body: hook({ tool_input: { file_path: ".env", content: "RAHASIA=123\n" } }) });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));

    const state = json(await send(d, "GET", "/dev/api/state"));
    type PendingItem = {
      toolName: string;
      sessionId: string;
      diff: { change: Record<string, unknown>; sensitive: Array<{ code: string }> };
    };
    const pending = state.pending as PendingItem[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolName: "Write", sessionId: "sesi-1234567890" });
    expect(pending[0]?.diff.change).toMatchObject({ type: "text", isNew: true, added: 1 });
    expect(pending[0]?.diff.sensitive.map((r) => r.code)).toContain("env_file");
    expect((state.status as { message: string }).message).toContain("menunggu keputusan");

    // Timeline: ada kejadiannya, tetapi tanpa isi.
    const timelineText = JSON.stringify(state.timeline);
    expect(timelineText).toContain("menunggu keputusan: Write");
    expect(timelineText).not.toContain("RAHASIA");

    d.approvals.cancelAll();
    await answered;
  });

  test("input alat yang sangat panjang dipotong di tampilan", async () => {
    const d = await start();
    const answered = send(d, "POST", "/hook", { body: hook({ tool_name: "Bash", hook_event_name: "PermissionRequest", tool_input: { command: "x".repeat(10_000) } }) });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    const pending = json(await send(d, "GET", "/dev/api/state")).pending as Array<{ toolInput: { command: string } }>;
    expect(pending[0]?.toolInput.command.length).toBeLessThan(2200);
    expect(pending[0]?.toolInput.command).toContain("dipotong");
    d.approvals.cancelAll();
    await answered;
  });

  test("setuju lewat halaman: hook dijawab allow", async () => {
    const d = await start();
    const answered = send(d, "POST", "/hook", { body: hook() });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    const [pending] = d.approvals.listPending();

    const decided = await send(d, "POST", "/dev/api/decision", { headers: fromOwnPage(d), body: JSON.stringify({ approvalId: pending?.approvalId, decision: "approve" }) });
    expect(decided).toMatchObject({ status: 200 });
    expect(json(decided)).toMatchObject({ ok: true, status: "approved" });
    expect(json(await answered)).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });

  test("tolak dengan komentar lewat halaman: komentar sampai ke jawaban hook", async () => {
    const d = await start();
    const answered = send(d, "POST", "/hook", { body: hook() });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    const [pending] = d.approvals.listPending();
    await send(d, "POST", "/dev/api/decision", { body: JSON.stringify({ approvalId: pending?.approvalId, decision: "deny", comment: "KODE-MERAH-42" }) });
    expect(json(await answered)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "KODE-MERAH-42" } });
  });

  test("keputusan kedua 409, tidak dikenal 404, bentuk salah 400, JSON rusak 400, bukan JSON 415", async () => {
    const d = await start();
    const answered = send(d, "POST", "/hook", { body: hook() });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    const approvalId = d.approvals.listPending()[0]?.approvalId;
    await send(d, "POST", "/dev/api/decision", { body: JSON.stringify({ approvalId, decision: "deny" }) });
    await answered;

    expect(await send(d, "POST", "/dev/api/decision", { body: JSON.stringify({ approvalId, decision: "approve" }) })).toMatchObject({ status: 409 });
    expect((await send(d, "POST", "/dev/api/decision", { body: JSON.stringify({ approvalId: "tidak-ada", decision: "approve" }) })).status).toBe(404);
    expect((await send(d, "POST", "/dev/api/decision", { body: JSON.stringify({ approvalId: "x", decision: "partial" }) })).status).toBe(400);
    expect((await send(d, "POST", "/dev/api/decision", { body: "{rusak" })).status).toBe(400);
    expect((await send(d, "POST", "/dev/api/decision", { body: "{}", json: false })).status).toBe(415);
  });

  test("jeda lewat halaman melepas hook yang menunggu, dan lanjutkan menyalakan lagi", async () => {
    const d = await start();
    const answered = send(d, "POST", "/hook", { body: hook() });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));

    const paused = await send(d, "POST", "/dev/api/pause", { headers: fromOwnPage(d), body: "{}" });
    expect(json(paused)).toMatchObject({ paused: true, released: 1 });
    expect(json(await answered)).toEqual({}); // dilepas ke terminal

    const state = json(await send(d, "GET", "/dev/api/state"));
    expect((state.status as { paused: boolean }).paused).toBe(true);
    expect(state.pending).toEqual([]);

    expect(json(await send(d, "POST", "/dev/api/resume", { body: "{}" }))).toMatchObject({ paused: false });
  });

  test("penahanan mati: halaman aktif tetapi tidak ada izin, dan statusnya menjelaskan kenapa", async () => {
    const d = await start({ holdEnabled: false });
    const state = json(await send(d, "GET", "/dev/api/state"));
    expect(state.pending).toEqual([]);
    expect((state.status as { message: string }).message).toContain("AGENTMON_HOLD=1");
  });
});

describe("truncateInput", () => {
  test("memotong teks panjang dan menyebut panjang aslinya", () => {
    const out = truncateInput("a".repeat(5000)) as string;
    expect(out.length).toBeLessThan(2100);
    expect(out).toContain("dipotong, 5000 karakter");
  });

  test("teks pendek, angka, dan nilai kosong dibiarkan", () => {
    expect(truncateInput({ a: "pendek", b: 1, c: true, d: null })).toEqual({ a: "pendek", b: 1, c: true, d: null });
  });

  test("daftar panjang dipotong, dan struktur yang terlalu dalam diringkas", () => {
    const list = truncateInput(Array.from({ length: 80 }, (_, i) => i)) as unknown[];
    expect(list).toHaveLength(51);
    expect(String(list.at(-1))).toContain("30 item lagi");
    const deep = truncateInput({ a: { b: { c: { d: { e: "terlalu dalam" } } } } });
    expect(JSON.stringify(deep)).toContain("terlalu dalam)");
  });

  test("tidak mengubah masukan aslinya", () => {
    const input = { text: "a".repeat(5000), list: [1, 2, 3] };
    const before = JSON.stringify(input);
    truncateInput(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("kode halaman", () => {
  test("berkas dev-page.ts tidak memakai backtick atau urutan dolar-kurung di dalam skrip yang disematkan", () => {
    const source = readFileSync(fileURLToPath(new URL("./dev-page.ts", import.meta.url)), "utf8");
    const script = /const SCRIPT = String\.raw`([\s\S]*?)^`;/m.exec(source)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(1000);
    expect(script).not.toContain("`");
    expect(script).not.toContain("${");
  });
});
