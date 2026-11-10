import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMonEvent, FinalApprovalStatus } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApprovalEngine, type ApprovalEngine } from "../approvals";
import { createDaemonControl } from "../control";
import type { HookContext, HookInput } from "../server";
import { DEFAULT_DENY_REASON, holdCandidate, toClaudeDecision } from "./claude-code";
import { createClaudeCodeHandler, RELEASED_TTL_MS, type ClaudeCodeHandlerOptions } from "./claude-code-handler";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/claude-code/", import.meta.url));
const fixtures = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json")).sort();
const load = (name: string): HookInput => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as HookInput;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- Kebijakan: aksi mana yang ditahan -------------------------------------------------

describe("holdCandidate: aksi mana yang ditahan", () => {
  // Hasil yang diharapkan untuk SETIAP fixture asli. Fixture baru tanpa baris di sini
  // membuat test gagal, jadi tidak ada yang terlewat tanpa disadari.
  const EXPECTED: Record<string, "PreToolUse" | "PermissionRequest" | undefined> = {
    "PreToolUse.Write.json": "PreToolUse",
    "PreToolUse.Edit.json": "PreToolUse",
    "PreToolUse.Read.json": undefined, // hanya membaca: tidak ditahan
    "PreToolUse.Bash.json": undefined, // perintah shell menunggu PermissionRequest
    "PreToolUse.PowerShell.json": undefined,
    "PermissionRequest.Write.json": "PermissionRequest",
    "PermissionRequest.Edit.json": "PermissionRequest",
    "PermissionRequest.Bash.json": "PermissionRequest",
    "PermissionRequest.PowerShell.json": "PermissionRequest", // alat PowerShell di Windows
    "PostToolUse.Read.json": undefined,
    "PostToolUse.Write.json": undefined,
    "PostToolUse.Edit.json": undefined,
    "PostToolUse.Bash.json": undefined,
    "PostToolUse.PowerShell.json": undefined,
    "SessionStart.json": undefined,
    "SessionEnd.json": undefined,
    "Stop.json": undefined,
    "Stop.continued.json": undefined,
    "UserPromptSubmit.json": undefined,
  };

  test("setiap fixture punya hasil yang diharapkan (dan sebaliknya)", () => {
    expect(fixtures).toEqual(Object.keys(EXPECTED).sort());
  });

  test.each(fixtures)("%s", (name) => {
    expect(holdCandidate(load(name))?.point).toBe(EXPECTED[name]);
  });

  test("candidate membawa sesi, nama alat, dan input alat", () => {
    expect(holdCandidate(load("PreToolUse.Edit.json"))).toMatchObject({
      point: "PreToolUse",
      sessionId: "00000000-0000-4000-8000-000000000001",
      toolName: "Edit",
      toolInput: { file_path: "C:\\work\\project\\app.ts" },
    });
  });

  test.each(["MultiEdit", "NotebookEdit"])("alat pengubah berkas %s ditahan di PreToolUse", (tool_name) => {
    expect(holdCandidate({ hook_event_name: "PreToolUse", session_id: "s", tool_name, tool_input: {} })?.point).toBe("PreToolUse");
  });

  test.each(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task"])("alat %s tidak ditahan di PreToolUse", (tool_name) => {
    expect(holdCandidate({ hook_event_name: "PreToolUse", session_id: "s", tool_name, tool_input: {} })).toBeUndefined();
  });

  test("PermissionRequest untuk alat apa pun ditahan (Claude memang akan bertanya)", () => {
    expect(holdCandidate({ hook_event_name: "PermissionRequest", session_id: "s", tool_name: "WebFetch", tool_input: {} })?.point).toBe(
      "PermissionRequest",
    );
  });

  test.each(["PreToolUse", "PermissionRequest"])("mode bypassPermissions tidak pernah ditahan (%s), hanya dipantau", (hook_event_name) => {
    const input = { ...load(`${hook_event_name}.Write.json`), permission_mode: "bypassPermissions" };
    expect(holdCandidate(input)).toBeUndefined();
  });

  test.each([
    ["tanpa session_id", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }],
    ["tanpa tool_name", { hook_event_name: "PreToolUse", session_id: "s", tool_input: {} }],
    ["tool_input berupa daftar", { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Write", tool_input: [] }],
    ["tool_input berupa teks", { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Write", tool_input: "x" }],
  ])("data rusak (%s) tidak ditahan, agent berjalan normal", (_name, input) => {
    expect(holdCandidate(input as HookInput)).toBeUndefined();
  });
});

// ---- Terjemahan hasil persetujuan menjadi jawaban --------------------------------------

describe("toClaudeDecision: hasil persetujuan menjadi jawaban untuk Claude Code", () => {
  test("disetujui di PreToolUse -> allow (melewati prompt, jadi tidak ada prompt kedua)", () => {
    expect(toClaudeDecision("PreToolUse", { status: "approved" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });

  test("disetujui di PermissionRequest -> behavior allow", () => {
    expect(toClaudeDecision("PermissionRequest", { status: "approved" })).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  test("ditolak di PreToolUse -> deny dengan komentar APA ADANYA sebagai alasan", () => {
    const comment = "Jangan buat file baru.\nPakai notes.txt yang sudah ada, ya. KODE-MERAH-42";
    expect(toClaudeDecision("PreToolUse", { status: "denied", comment })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: comment },
    });
  });

  test("ditolak di PermissionRequest -> behavior deny dengan komentar sebagai message", () => {
    expect(toClaudeDecision("PermissionRequest", { status: "denied", comment: "terlalu berbahaya" })).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "terlalu berbahaya" } },
    });
  });

  test.each([undefined, "", "   "])("ditolak tanpa komentar (%j) -> alasan bawaan", (comment) => {
    const response = toClaudeDecision("PreToolUse", { status: "denied", ...(comment !== undefined ? { comment } : {}) });
    expect(JSON.stringify(response)).toContain(DEFAULT_DENY_REASON);
  });

  test.each<FinalApprovalStatus>(["timed_out", "cancelled", "partially_approved"])(
    "%s -> tanpa keputusan di kedua titik, tidak pernah allow dan tidak pernah ask",
    (status) => {
      const outcome = { status, comment: "komentar" };
      for (const point of ["PreToolUse", "PermissionRequest"] as const) {
        expect(toClaudeDecision(point, outcome)).toBeUndefined();
      }
    },
  );

  test("hanya 'approved' yang menghasilkan allow, dan tidak ada hasil yang berisi ask", () => {
    const statuses: FinalApprovalStatus[] = ["approved", "partially_approved", "denied", "timed_out", "cancelled"];
    for (const status of statuses) {
      for (const point of ["PreToolUse", "PermissionRequest"] as const) {
        const text = JSON.stringify(toClaudeDecision(point, { status })) ?? "";
        expect(text.includes('"allow"'), `${status}/${point}`).toBe(status === "approved");
        expect(text).not.toContain('"ask"');
      }
    }
  });
});

// ---- Penangan: menahan aksi sampai ada keputusan ---------------------------------------

function setup(
  options: {
    holdEnabled?: boolean;
    timeoutMs?: number;
    clock?: { ms: number };
    approvals?: ApprovalEngine;
    handler?: Partial<ClaudeCodeHandlerOptions>;
  } = {},
) {
  const logs: string[] = [];
  const events: AgentMonEvent[] = [];
  const approvals = options.approvals ?? createApprovalEngine({ defaultTimeoutMs: options.timeoutMs ?? 60_000 });
  const control = createDaemonControl({ holdEnabled: options.holdEnabled ?? true, approvals });
  const context: HookContext = {
    machineId: "laptop-1",
    approvals,
    control,
    logger: { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) },
  };
  const handler = createClaudeCodeHandler({
    emit: (event) => void events.push(event),
    ...(options.clock ? { now: () => new Date(options.clock!.ms) } : {}),
    ...options.handler,
  });
  const waitPending = (count = 1) => vi.waitFor(() => expect(approvals.listPending()).toHaveLength(count));
  const decideFirst = (decision: "approve" | "deny" | "partial", extra: Record<string, unknown> = {}) => {
    const [first] = approvals.listPending();
    if (!first) throw new Error("tidak ada izin yang menunggu");
    return approvals.decide({ approvalId: first.approvalId, decision, ...extra });
  };
  return { approvals, control, context, handler, logs, events, waitPending, decideFirst };
}

describe("penangan menahan aksi", () => {
  test("alat pengubah berkas ditahan sampai disetujui, lalu dijawab allow", async () => {
    const s = setup();
    let answered = false;
    const response = Promise.resolve(s.handler(load("PreToolUse.Write.json"), s.context)).then((r) => {
      answered = true;
      return r;
    });
    await s.waitPending();
    await flush();
    expect(answered).toBe(false); // benar-benar ditahan

    s.decideFirst("approve");
    expect(await response).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
  });

  test("ditolak dengan komentar: komentar sampai utuh ke jawaban hook", async () => {
    const s = setup();
    const response = s.handler(load("PreToolUse.Write.json"), s.context);
    await s.waitPending();
    s.decideFirst("deny", { comment: "Jangan buat file baru. KODE-MERAH-42" });
    expect(await response).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Jangan buat file baru. KODE-MERAH-42",
      },
    });
  });

  test("Edit di PreToolUse juga ditahan", async () => {
    const s = setup();
    const response = s.handler(load("PreToolUse.Edit.json"), s.context);
    await s.waitPending();
    expect(s.approvals.listPending()[0]).toMatchObject({ toolName: "Edit" });
    s.decideFirst("approve");
    await response;
  });

  test("perintah shell ditahan lewat PermissionRequest, termasuk PowerShell di Windows", async () => {
    for (const name of ["PermissionRequest.Bash.json", "PermissionRequest.PowerShell.json"]) {
      const s = setup();
      const response = s.handler(load(name), s.context);
      await s.waitPending();
      s.decideFirst("approve");
      expect(await response).toEqual({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      });
    }
  });

  test("PermissionRequest ditolak -> behavior deny dengan komentar", async () => {
    const s = setup();
    const response = s.handler(load("PermissionRequest.Bash.json"), s.context);
    await s.waitPending();
    s.decideFirst("deny", { comment: "jangan sentuh berkas ini" });
    expect(await response).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "jangan sentuh berkas ini" } },
    });
  });

  test.each(["PreToolUse.Read.json", "PreToolUse.Bash.json", "PreToolUse.PowerShell.json", "PostToolUse.Write.json", "Stop.json"])(
    "%s tidak ditahan: dijawab langsung dan tidak ada izin yang dibuka",
    async (name) => {
      const s = setup();
      expect(await s.handler(load(name), s.context)).toBeUndefined();
      expect(s.approvals.listPending()).toEqual([]);
    },
  );

  test("event: tool.requested lebih dulu, lalu approval.requested dan approval.resolved dengan nomor urut berurutan", async () => {
    const s = setup();
    const response = s.handler(load("PreToolUse.Write.json"), s.context);
    await s.waitPending();
    const [pending] = s.approvals.listPending();
    s.decideFirst("deny", { comment: "tidak" });
    await response;
    await flush();

    expect(s.events.map((e) => [e.type, e.seq])).toEqual([
      ["tool.requested", 0],
      ["approval.requested", 1],
      ["approval.resolved", 2],
    ]);
    expect(s.events[1]?.payload).toMatchObject({ approvalId: pending?.approvalId, toolName: "Write", expiresAt: pending?.expiresAt });
    expect(s.events[2]?.payload).toEqual({ approvalId: pending?.approvalId, status: "denied", comment: "tidak" });
  });

  test("log memuat nama alat dan hasil, tidak memuat isi input maupun komentar", async () => {
    const s = setup();
    const response = s.handler(
      { ...load("PreToolUse.Write.json"), tool_input: { file_path: "a.txt", content: "RAHASIA-123" } },
      s.context,
    );
    await s.waitPending();
    s.decideFirst("deny", { comment: "RAHASIA-456" });
    await response;
    const text = s.logs.join("\n");
    expect(text).toContain("menahan PreToolUse alat=Write");
    expect(text).toContain("keputusan PreToolUse alat=Write: denied");
    expect(text).not.toContain("RAHASIA");
  });
});

describe("kegagalan tidak pernah menjadi persetujuan", () => {
  test("waktu habis -> tanpa keputusan (bukan allow, bukan ask)", async () => {
    const s = setup({ timeoutMs: 30 });
    const response = await s.handler(load("PreToolUse.Write.json"), s.context);
    expect(response).toBeUndefined();
    await flush();
    expect(s.events.at(-1)?.payload).toMatchObject({ status: "timed_out" });
  });

  test("dibatalkan -> tanpa keputusan", async () => {
    const s = setup();
    const response = s.handler(load("PreToolUse.Write.json"), s.context);
    await s.waitPending();
    s.approvals.cancelAll();
    expect(await response).toBeUndefined();
  });

  test("terima sebagian belum didukung -> kembali ke alur normal, tidak diterapkan", async () => {
    const s = setup();
    const response = s.handler(load("PreToolUse.Edit.json"), s.context);
    await s.waitPending();
    s.decideFirst("partial", {
      hunks: [
        { hunkId: "h1", decision: "approve" },
        { hunkId: "h2", decision: "reject" },
      ],
    });
    expect(await response).toBeUndefined();
    expect(s.logs.join("\n")).toContain("terima sebagian belum didukung");
  });

  test("mesin persetujuan yang error -> tanpa keputusan, dan dicatat", async () => {
    const approvals = createApprovalEngine();
    const broken = {
      ...approvals,
      request: () => {
        throw new Error("mesin rusak");
      },
    };
    const s = setup({ approvals: broken });
    expect(await s.handler(load("PreToolUse.Write.json"), s.context)).toBeUndefined();
    expect(s.logs.join("\n")).toContain("mesin rusak");
  });

  test("daemon berhenti saat menunggu -> tanpa keputusan", async () => {
    const s = setup();
    const response = s.handler(load("PreToolUse.Write.json"), s.context);
    await s.waitPending();
    s.approvals.close();
    expect(await response).toBeUndefined();
  });
});

describe("penahanan mati, dijeda, atau mode bypass", () => {
  test("penahanan mati (bawaan daemon): tidak ada aksi yang ditahan", async () => {
    const s = setup({ holdEnabled: false });
    expect(await s.handler(load("PreToolUse.Write.json"), s.context)).toBeUndefined();
    expect(await s.handler(load("PermissionRequest.Bash.json"), s.context)).toBeUndefined();
    expect(s.approvals.listPending()).toEqual([]);
  });

  test("saat dijeda, hook langsung dijawab tanpa menunggu dan tidak ada izin yang dibuka", async () => {
    const s = setup();
    s.control.pause();
    expect(await s.handler(load("PreToolUse.Write.json"), s.context)).toBeUndefined();
    expect(s.approvals.listPending()).toEqual([]);
  });

  test("menjeda melepas aksi yang sedang menunggu (prompt terminal muncul saat itu juga)", async () => {
    const s = setup();
    const response = s.handler(load("PreToolUse.Write.json"), s.context);
    await s.waitPending();
    expect(s.control.pause()).toBe(1);
    expect(await response).toBeUndefined();
    await flush();
    expect(s.events.at(-1)?.payload).toMatchObject({ status: "cancelled" });
  });

  test("saat dijeda, tercatat di log kenapa aksi tidak ditahan (nama alat saja, tanpa isi input)", async () => {
    const s = setup();
    s.control.pause();
    await s.handler({ ...load("PreToolUse.Write.json"), tool_input: { content: "RAHASIA-123" } }, s.context);
    const text = s.logs.join("\n");
    expect(text).toContain("tidak ditahan karena dijeda: PreToolUse alat=Write");
    expect(text).not.toContain("RAHASIA");
  });

  test("penahanan mati (bawaan) tidak mencatat baris itu per aksi, dan aksi baca-saja tidak pernah dicatat", async () => {
    const off = setup({ holdEnabled: false });
    await off.handler(load("PreToolUse.Write.json"), off.context);
    expect(off.logs.join("\n")).not.toContain("karena dijeda");

    const paused = setup();
    paused.control.pause();
    await paused.handler(load("PreToolUse.Read.json"), paused.context); // bukan kandidat tahan
    expect(paused.logs.join("\n")).not.toContain("karena dijeda");
  });

  test("setelah resume, aksi ditahan lagi", async () => {
    const s = setup();
    s.control.pause();
    s.control.resume();
    const response = s.handler(load("PreToolUse.Write.json"), s.context);
    await s.waitPending();
    s.decideFirst("approve");
    expect(await response).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });

  test("mode bypassPermissions: hanya dipantau, tidak ditahan, tetapi event tetap dikirim", async () => {
    const s = setup();
    const input = { ...load("PreToolUse.Write.json"), permission_mode: "bypassPermissions" };
    expect(await s.handler(input, s.context)).toBeUndefined();
    await flush();
    expect(s.approvals.listPending()).toEqual([]);
    expect(s.events.map((e) => e.type)).toEqual(["tool.requested"]);
  });
});

describe("tidak ada penantian ganda sebelum prompt terminal", () => {
  test("aksi yang waktunya habis di PreToolUse tidak ditahan lagi saat PermissionRequest-nya menyusul", async () => {
    const s = setup({ timeoutMs: 30 });
    expect(await s.handler(load("PreToolUse.Edit.json"), s.context)).toBeUndefined(); // habis
    const started = performance.now();
    // Claude Code lanjut bertanya untuk aksi yang SAMA: harus langsung diteruskan.
    expect(await s.handler(load("PermissionRequest.Edit.json"), s.context)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(25); // tidak menunggu 30 ms lagi
    expect(s.approvals.listPending()).toEqual([]);
    expect(s.logs.join("\n")).toContain("diteruskan ke terminal tanpa menahan lagi");
  });

  test("catatannya hanya berlaku satu kali: PermissionRequest berikutnya yang sama ditahan lagi", async () => {
    const s = setup({ timeoutMs: 5000 });
    // Menyiapkan catatan "dilepas" lewat PreToolUse yang dibatalkan.
    const first = s.handler(load("PreToolUse.Edit.json"), s.context);
    await s.waitPending();
    s.approvals.cancelAll();
    await first;

    await s.handler(load("PermissionRequest.Edit.json"), s.context); // dikonsumsi, diteruskan
    const again = s.handler(load("PermissionRequest.Edit.json"), s.context);
    await s.waitPending(); // kali ini ditahan
    s.approvals.cancelAll();
    await again;
  });

  test("aksi lain tetap ditahan walau ada aksi yang baru dilepas", async () => {
    const s = setup();
    const first = s.handler(load("PreToolUse.Edit.json"), s.context);
    await s.waitPending();
    s.approvals.cancelAll(); // dilepas ke terminal
    await first;
    const other = s.handler(load("PermissionRequest.Write.json"), s.context); // alat lain
    await s.waitPending();
    s.approvals.cancelAll();
    await other;
  });

  test("catatan 'dilepas' kedaluwarsa setelah beberapa saat", async () => {
    const clock = { ms: Date.parse("2026-11-09T10:00:00Z") };
    const s = setup({ clock });
    const first = s.handler(load("PreToolUse.Edit.json"), s.context);
    await s.waitPending();
    s.approvals.cancelAll(); // dilepas ke terminal
    await first;
    clock.ms += RELEASED_TTL_MS + 1000;
    const late = s.handler(load("PermissionRequest.Edit.json"), s.context);
    await s.waitPending(); // sudah kedaluwarsa -> ditahan
    s.approvals.cancelAll();
    await late;
  });

  test("aksi yang disetujui di PreToolUse tidak meninggalkan catatan 'dilepas'", async () => {
    const s = setup();
    const approved = s.handler(load("PreToolUse.Edit.json"), s.context);
    await s.waitPending();
    s.decideFirst("approve");
    await approved;
    const next = s.handler(load("PermissionRequest.Edit.json"), s.context);
    await s.waitPending(); // tetap ditahan, karena tidak ada catatan
    s.approvals.cancelAll();
    await next;
  });
});

describe("hook yang menunggu tidak menahan hook lain", () => {
  test("hook lain dijawab selagi satu hook menunggu, dan tiap keputusan sampai ke hook miliknya", async () => {
    const s = setup();
    const writeA = s.handler({ ...load("PreToolUse.Write.json"), session_id: "A" }, s.context);
    await s.waitPending(1);

    // Hook baca dan hook dari sesi lain tidak menunggu hook A.
    expect(await s.handler({ ...load("PreToolUse.Read.json"), session_id: "A" }, s.context)).toBeUndefined();
    const editB = s.handler({ ...load("PreToolUse.Edit.json"), session_id: "B" }, s.context);
    await s.waitPending(2);

    const pending = s.approvals.listPending();
    const forB = pending.find((p) => p.sessionId === "B");
    if (!forB) throw new Error("izin sesi B tidak ada");
    s.approvals.decide({ approvalId: forB.approvalId, decision: "approve" });
    expect(await editB).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect(s.approvals.listPending().map((p) => p.sessionId)).toEqual(["A"]); // A masih menunggu

    s.decideFirst("deny", { comment: "tidak untuk A" });
    expect(await writeA).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "tidak untuk A" } });
  });
});

// ---- Diff yang ikut tersimpan bersama izin yang menunggu -------------------------------

describe("diff untuk aksi yang ditahan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmon-hold-diff-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const editInput = (extra: Record<string, unknown> = {}): HookInput => ({
    ...load("PreToolUse.Edit.json"),
    cwd: dir,
    tool_input: { file_path: "app.ts", old_string: "Halo", new_string: "Hai" },
    ...extra,
  });

  test("Edit yang ditahan membawa diff-nya: satu hunk, satu baris diganti", async () => {
    writeFileSync(join(dir, "app.ts"), "function salam() {\n  return Halo;\n}\n");
    const s = setup();
    const response = s.handler(editInput(), s.context);
    await s.waitPending();

    const [pending] = s.approvals.listPending();
    expect(pending?.diff?.change).toMatchObject({ type: "text", isNew: false, added: 1, removed: 1 });
    expect(pending?.diff?.path).toBe("app.ts");
    expect(s.logs.join("\n")).toContain("diff dihitung alat=Edit: text");
    s.decideFirst("approve");
    await response;
  });

  test("Write berkas baru membawa diff berkas baru", async () => {
    const s = setup();
    const response = s.handler(
      { ...load("PreToolUse.Write.json"), cwd: dir, tool_input: { file_path: "baru.txt", content: "satu\ndua\n" } },
      s.context,
    );
    await s.waitPending();
    expect(s.approvals.listPending()[0]?.diff?.change).toMatchObject({ type: "text", isNew: true, added: 2 });
    s.decideFirst("deny");
    await response;
  });

  test("path sensitif ikut ditandai pada diff", async () => {
    writeFileSync(join(dir, ".env"), "RAHASIA=1\n");
    const s = setup();
    const response = s.handler(
      { ...load("PreToolUse.Write.json"), cwd: dir, tool_input: { file_path: ".env", content: "RAHASIA=2\n" } },
      s.context,
    );
    await s.waitPending();
    expect(s.approvals.listPending()[0]?.diff?.sensitive.map((r) => r.code)).toContain("env_file");
    s.decideFirst("deny");
    await response;
  });

  test("aksi yang bukan perubahan berkas (perintah shell) ditahan tanpa diff", async () => {
    const s = setup();
    const response = s.handler(load("PermissionRequest.Bash.json"), s.context);
    await s.waitPending();
    expect(s.approvals.listPending()[0]?.diff).toBeUndefined();
    s.decideFirst("approve");
    await response;
  });

  test("penghitung diff yang error tidak menghalangi: aksi tetap ditahan tanpa diff, dan dicatat", async () => {
    const s = setup({
      handler: {
        computeDiff: () => {
          throw new Error("diff rusak");
        },
      },
    });
    const response = s.handler(editInput(), s.context);
    await s.waitPending();
    expect(s.approvals.listPending()[0]?.diff).toBeUndefined();
    expect(s.logs.join("\n")).toContain("diff gagal dihitung: diff rusak");
    s.decideFirst("approve");
    expect(await response).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });

  test("penghitung diff yang macet dilewati setelah batas waktunya, aksi tetap ditahan", async () => {
    const s = setup({ handler: { computeDiff: () => new Promise(() => undefined), diffTimeoutMs: 40 } });
    const started = performance.now();
    const response = s.handler(editInput(), s.context);
    await s.waitPending();
    expect(performance.now() - started).toBeGreaterThanOrEqual(35); // memang menunggu batas waktunya
    expect(s.approvals.listPending()[0]?.diff).toBeUndefined();
    s.decideFirst("approve");
    await response;
  });

  test("log tidak memuat isi berkas maupun isi usulan", async () => {
    writeFileSync(join(dir, "app.ts"), "kode RAHASIA-LAMA\n");
    const s = setup();
    const response = s.handler(
      editInput({ tool_input: { file_path: "app.ts", old_string: "RAHASIA-LAMA", new_string: "RAHASIA-BARU" } }),
      s.context,
    );
    await s.waitPending();
    s.decideFirst("approve");
    await response;
    expect(s.logs.join("\n")).not.toContain("RAHASIA");
  });

  test("diff tidak ikut dikirim di event approval.requested (kontrak pesan tidak berubah)", async () => {
    writeFileSync(join(dir, "app.ts"), "Halo\n");
    const s = setup();
    const response = s.handler(editInput(), s.context);
    await s.waitPending();
    s.decideFirst("approve");
    await response;
    await flush();
    const requested = s.events.find((e) => e.type === "approval.requested");
    expect(requested?.payload).not.toHaveProperty("diff");
  });
});

describe("penghitung diff yang menolak terlambat", () => {
  test("penolakan SETELAH batas waktu tidak menjadi unhandled rejection, dan aksi tetap ditahan tanpa diff", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const s = setup({
        handler: {
          // Menolak 80 ms kemudian, padahal batas waktunya 20 ms: batas waktu menang lebih dulu.
          computeDiff: () => new Promise((_, reject) => setTimeout(() => reject(new Error("terlambat")), 80)),
          diffTimeoutMs: 20,
        },
      });
      const response = s.handler({ ...load("PreToolUse.Edit.json"), cwd: tmpdir() }, s.context);
      await s.waitPending();
      expect(s.approvals.listPending()[0]?.diff).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 200)); // lewati saat penolakan itu terjadi
      expect(unhandled).toEqual([]);

      s.decideFirst("approve");
      await response;
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
