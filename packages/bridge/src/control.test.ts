import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDiff } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApprovalEngine } from "./approvals";
import { createClaudeCodeHandler } from "./adapters/claude-code-handler";
import { createDaemonControl, summarizeDiff } from "./control";
import { startDaemon, type RunningDaemon } from "./daemon";

const NEW = { sessionId: "s1", toolName: "Write", toolInput: { file_path: "a.txt" } };

describe("panel kontrol (saklar menahan aksi)", () => {
  test("canHold: hanya bila penahanan menyala DAN tidak dijeda", () => {
    const approvals = createApprovalEngine();
    const off = createDaemonControl({ holdEnabled: false, approvals });
    expect(off.canHold()).toBe(false);

    const on = createDaemonControl({ holdEnabled: true, approvals });
    expect(on.canHold()).toBe(true);
    on.pause();
    expect(on.isPaused()).toBe(true);
    expect(on.canHold()).toBe(false);
    on.resume();
    expect(on.canHold()).toBe(true);
  });

  test("canAnswer salah (tidak ada HP yang bisa menjawab): tidak ditahan, dan status menjelaskan alasannya", () => {
    let answer = false;
    const control = createDaemonControl({ holdEnabled: true, approvals: createApprovalEngine(), canAnswer: () => answer });
    expect(control.canHold()).toBe(false);
    expect(control.status().message).toContain("Tidak ada HP yang bisa dihubungi");
    answer = true;
    expect(control.canHold()).toBe(true);
    expect(control.status().message).not.toContain("Tidak ada HP");
  });

  test("menjeda tidak menyalakan penahanan yang mati, dan melanjutkan juga tidak", () => {
    const control = createDaemonControl({ holdEnabled: false, approvals: createApprovalEngine() });
    control.pause();
    control.resume();
    expect(control.canHold()).toBe(false);
  });

  test("pause melepas izin yang sedang menunggu (dibatalkan) dan mengembalikan jumlahnya", async () => {
    const approvals = createApprovalEngine();
    const control = createDaemonControl({ holdEnabled: true, approvals });
    const a = approvals.request(NEW);
    const b = approvals.request(NEW);
    expect(control.pause()).toBe(2);
    expect(await a.outcome).toEqual({ status: "cancelled" });
    expect(await b.outcome).toEqual({ status: "cancelled" });
    expect(approvals.listPending()).toEqual([]);
  });

  test("status menjelaskan keadaan dengan kalimat yang bisa dibaca", () => {
    const approvals = createApprovalEngine();
    const control = createDaemonControl({ holdEnabled: true, approvals });
    expect(control.status().message).toContain("Aktif. Tidak ada permintaan");

    approvals.request({ ...NEW, toolName: "Write" });
    approvals.request({ ...NEW, toolName: "Bash" });
    approvals.request({ ...NEW, toolName: "Bash" });
    const waiting = control.status();
    expect(waiting.pending).toHaveLength(3);
    expect(waiting.message).toContain("menunggu keputusan dari HP untuk 3 permintaan");
    expect(waiting.message).toContain("Write, Bash"); // nama alat unik, tanpa pengulangan

    control.pause();
    expect(control.status().message).toContain("Dijeda");
    expect(control.status().paused).toBe(true);

    const off = createDaemonControl({ holdEnabled: false, approvals: createApprovalEngine() });
    expect(off.status().message).toContain("AGENTMON_HOLD=1");
  });

  test("status tidak memuat isi input alat (bisa berisi kode atau rahasia)", () => {
    const approvals = createApprovalEngine();
    const control = createDaemonControl({ holdEnabled: true, approvals });
    approvals.request({ ...NEW, toolInput: { content: "RAHASIA-123" } });
    expect(JSON.stringify(control.status())).not.toContain("RAHASIA-123");
  });
});

// ---- Lewat HTTP, dengan daemon sungguhan -----------------------------------------------

describe("endpoint kontrol", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentmon-control-"));
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  async function start(holdEnabled = true) {
    daemon = await startDaemon({
      home,
      port: 0,
      holdEnabled,
      onHook: createClaudeCodeHandler({ emit: () => undefined }),
    });
    return daemon;
  }

  function send(
    d: RunningDaemon,
    method: string,
    path: string,
    options: { body?: string; json?: boolean; auth?: boolean } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (options.auth !== false) headers.authorization = `Bearer ${d.token}`;
      if (options.json !== false && options.body !== undefined) headers["content-type"] = "application/json";
      const req = request({ host: "127.0.0.1", port: d.port, path, method, headers }, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
      });
      req.on("error", reject);
      req.end(options.body);
    });
  }

  const hookBody = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    tool_name: "Write",
    tool_input: { file_path: "a.txt", content: "x" },
  });

  test.each([
    ["GET", "/status"],
    ["POST", "/pause"],
    ["POST", "/resume"],
    ["POST", "/decision"],
  ])("%s %s menolak request tanpa token (401)", async (method, path) => {
    const d = await start();
    expect((await send(d, method, path, { auth: false, body: method === "POST" ? "{}" : undefined })).status).toBe(401);
  });

  test.each([
    ["POST", "/status"],
    ["GET", "/pause"],
    ["GET", "/resume"],
    ["GET", "/decision"],
  ])("%s %s ditolak karena metode salah (405)", async (method, path) => {
    const d = await start();
    expect((await send(d, method, path)).status).toBe(405);
  });

  test("status, pause, dan resume mengubah dan melaporkan keadaan", async () => {
    const d = await start();
    expect((await send(d, "GET", "/status")).body).toMatchObject({ paused: false, holdEnabled: true, pending: [] });
    expect((await send(d, "POST", "/pause")).body).toMatchObject({ paused: true, released: 0 });
    expect(d.control.isPaused()).toBe(true);
    expect((await send(d, "POST", "/resume")).body).toMatchObject({ paused: false });
    expect(d.control.isPaused()).toBe(false);
  });

  test("hook yang menunggu dilepas oleh /pause dan dijawab {} (tanpa keputusan)", async () => {
    const d = await start();
    const hook = send(d, "POST", "/hook", { body: hookBody });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    expect((await send(d, "GET", "/status")).body.message).toContain("menunggu keputusan dari HP");

    const paused = await send(d, "POST", "/pause");
    expect(paused.body).toMatchObject({ released: 1 });

    const answered = await hook;
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({});
  });

  test("keputusan lewat /decision membebaskan hook yang menunggu dengan jawaban allow", async () => {
    const d = await start();
    const hook = send(d, "POST", "/hook", { body: hookBody });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    const [pending] = d.approvals.listPending();

    const decided = await send(d, "POST", "/decision", { body: JSON.stringify({ approvalId: pending?.approvalId, decision: "approve" }) });
    expect(decided).toMatchObject({ status: 200, body: { ok: true, status: "approved" } });

    expect((await hook).body).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
  });

  test("penolakan dengan komentar lewat /decision sampai ke jawaban hook", async () => {
    const d = await start();
    const hook = send(d, "POST", "/hook", { body: hookBody });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    const [pending] = d.approvals.listPending();
    await send(d, "POST", "/decision", { body: JSON.stringify({ approvalId: pending?.approvalId, decision: "deny", comment: "KODE-MERAH-42" }) });
    expect((await hook).body).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "KODE-MERAH-42" },
    });
  });

  test("penahanan mati: hook dijawab {} langsung dan tidak ada izin yang dibuka", async () => {
    const d = await start(false);
    const answered = await send(d, "POST", "/hook", { body: hookBody });
    expect(answered.body).toEqual({});
    expect(d.approvals.listPending()).toEqual([]);
  });

  test("keputusan kedua ditolak (409) dan menyebut hasil yang sebenarnya", async () => {
    const d = await start();
    const hook = send(d, "POST", "/hook", { body: hookBody });
    await vi.waitFor(() => expect(d.approvals.listPending()).toHaveLength(1));
    const [pending] = d.approvals.listPending();
    const approvalId = pending?.approvalId;
    await send(d, "POST", "/decision", { body: JSON.stringify({ approvalId, decision: "deny" }) });
    await hook;

    const second = await send(d, "POST", "/decision", { body: JSON.stringify({ approvalId, decision: "approve" }) });
    expect(second).toMatchObject({ status: 409, body: { status: "denied" } });
  });

  test("keputusan untuk izin yang tidak dikenal (404), bentuk salah (400), JSON rusak (400), bukan JSON (415)", async () => {
    const d = await start();
    expect((await send(d, "POST", "/decision", { body: JSON.stringify({ approvalId: "tidak-ada", decision: "approve" }) })).status).toBe(404);

    const invalid = await send(d, "POST", "/decision", { body: JSON.stringify({ approvalId: "x", decision: "partial" }) });
    expect(invalid.status).toBe(400);
    expect(String(invalid.body.error)).toContain("hunks");

    expect((await send(d, "POST", "/decision", { body: "{bukan json" })).status).toBe(400);
    expect((await send(d, "POST", "/decision", { body: "{}", json: false })).status).toBe(415);
  });
});

describe("ringkasan diff di status", () => {
  const format = { oldEol: "lf", newEol: "lf", oldFinalNewline: true, newFinalNewline: true } as const;
  const diffOf = (change: FileDiff["change"], sensitive: FileDiff["sensitive"] = []): FileDiff => ({
    path: "a.txt",
    toolName: "Write",
    sensitive,
    change,
  });

  test.each<[string, FileDiff["change"], string]>([
    ["teks", { type: "text", isNew: false, hunks: [], added: 3, removed: 1, format }, "+3 -1 (0 hunk)"],
    ["berkas baru", { type: "text", isNew: true, hunks: [], added: 5, removed: 0, format }, "berkas baru +5 -0"],
    ["tanpa perubahan", { type: "unchanged", formatChanged: false, format }, "tidak ada perubahan"],
    ["hanya format", { type: "unchanged", formatChanged: true, format }, "hanya format yang berubah"],
    ["biner", { type: "binary", isNew: false }, "berkas biner"],
    ["terlalu besar", { type: "too_large", isNew: false, message: "besar", added: 900, removed: 800 }, "terlalu besar (~+900 -800)"],
    ["terlalu besar tanpa hitungan", { type: "too_large", isNew: false, message: "besar" }, "terlalu besar"],
    ["tidak cocok", { type: "mismatch", reason: "old_string_not_found", message: "x" }, "tidak cocok: old_string_not_found"],
  ])("%s", (_name, change, expected) => {
    expect(summarizeDiff(diffOf(change))).toContain(expected);
  });

  test("status menampilkan ringkasan dan tanda sensitif, tanpa isi berkas", () => {
    const approvals = createApprovalEngine();
    const control = createDaemonControl({ holdEnabled: true, approvals });
    const secret = diffOf(
      {
        type: "text",
        isNew: false,
        hunks: [{ id: "h1", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: "add", text: "RAHASIA-123", newLine: 1 }] }],
        added: 1,
        removed: 0,
        format,
      },
      [{ code: "env_file", message: "Berkas .env" }],
    );
    approvals.request({ ...NEW, diff: secret });
    approvals.request(NEW); // tanpa diff

    const [withDiff, without] = control.status().pending;
    expect(withDiff).toMatchObject({ change: "+1 -0 (1 hunk)", sensitive: ["env_file"] });
    expect(without).not.toHaveProperty("change");
    expect(without).not.toHaveProperty("sensitive");
    expect(JSON.stringify(control.status())).not.toContain("RAHASIA-123");
    approvals.cancelAll();
  });
});
