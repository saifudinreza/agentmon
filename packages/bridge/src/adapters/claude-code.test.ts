import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvent } from "@agentmon/shared";
import { describe, expect, test, vi } from "vitest";
import type { HookInput } from "../server";
import { mapClaudeCodeHook, type ClaudeMapResult, type Stamp } from "./claude-code";

// Fixture asli hasil riset (issue 003), bukan contoh buatan sendiri.
const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/claude-code/", import.meta.url));
const fixtures = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();
const load = (name: string): HookInput => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as HookInput;

const STAMP: Stamp = { machineId: "laptop-1", id: "11111111-1111-4111-8111-111111111111", seq: 7, ts: "2026-11-03T10:00:00.000Z" };
const stamp = () => STAMP;

// Hasil yang diharapkan untuk SETIAP fixture. Daftar ini ditulis eksplisit: fixture baru
// tanpa baris di sini membuat test gagal, jadi tidak ada yang terlewat tanpa disadari.
const EXPECTED: Record<string, { status: ClaudeMapResult["status"]; type?: string }> = {
  "SessionStart.json": { status: "event", type: "session.started" },
  "PreToolUse.Read.json": { status: "event", type: "tool.requested" },
  "PreToolUse.Write.json": { status: "event", type: "tool.requested" },
  "PreToolUse.Edit.json": { status: "event", type: "tool.requested" },
  "PreToolUse.Bash.json": { status: "event", type: "tool.requested" },
  "PreToolUse.PowerShell.json": { status: "event", type: "tool.requested" },
  "PostToolUse.Read.json": { status: "event", type: "tool.completed" },
  "PostToolUse.Write.json": { status: "event", type: "tool.completed" },
  "PostToolUse.Edit.json": { status: "event", type: "tool.completed" },
  "PostToolUse.Bash.json": { status: "event", type: "tool.completed" },
  "PostToolUse.PowerShell.json": { status: "event", type: "tool.completed" },
  "Stop.json": { status: "event", type: "agent.stopped" },
  "Stop.continued.json": { status: "event", type: "agent.stopped" },
  "PermissionRequest.Write.json": { status: "permission_request" },
  "PermissionRequest.Edit.json": { status: "permission_request" },
  "PermissionRequest.Bash.json": { status: "permission_request" },
  "PermissionRequest.PowerShell.json": { status: "permission_request" },
  "SessionEnd.json": { status: "session_ended" },
  "UserPromptSubmit.json": { status: "ignored" },
};

describe("pemetaan fixture Claude Code", () => {
  test("setiap fixture punya hasil yang diharapkan (dan sebaliknya)", () => {
    expect(fixtures).toEqual(Object.keys(EXPECTED).sort());
  });

  test.each(fixtures)("%s dipetakan sesuai harapan", (name) => {
    const result = mapClaudeCodeHook(load(name), stamp);
    const expected = EXPECTED[name];
    expect(result.status).toBe(expected?.status);
    if (result.status === "event") expect(result.event.type).toBe(expected?.type);
  });

  test.each(fixtures.filter((name) => EXPECTED[name]?.status === "event"))(
    "%s menghasilkan event yang lolos validasi kontrak",
    (name) => {
      const result = mapClaudeCodeHook(load(name), stamp);
      if (result.status !== "event") throw new Error("seharusnya event");
      // Dilewatkan ulang lewat pintu validasi yang dipakai bagian lain AgentMon.
      expect(parseEvent(JSON.parse(JSON.stringify(result.event))).status).toBe("ok");
    },
  );
});

describe("isi hasil pemetaan", () => {
  test("amplop: identitas dari luar, sesi dari Claude Code, agent claude-code", () => {
    const result = mapClaudeCodeHook(load("PreToolUse.Edit.json"), stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event).toMatchObject({
      v: 1,
      id: STAMP.id,
      machineId: "laptop-1",
      sessionId: "00000000-0000-4000-8000-000000000001",
      seq: 7,
      ts: STAMP.ts,
      agent: "claude-code",
    });
  });

  test("PreToolUse -> tool.requested membawa nama alat, input, dan id pemakaian", () => {
    const result = mapClaudeCodeHook(load("PreToolUse.Edit.json"), stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.type).toBe("tool.requested");
    expect(result.event.payload).toMatchObject({
      toolName: "Edit",
      toolUseId: "toolu_fixture0003",
      toolInput: { new_string: '  return "Hai, " + name;' },
    });
  });

  test("alat PowerShell (khusus Windows) ikut dipetakan", () => {
    const result = mapClaudeCodeHook(load("PreToolUse.PowerShell.json"), stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.payload).toMatchObject({ toolName: "PowerShell", toolInput: { command: "echo selesai" } });
  });

  test("SessionStart -> session.started; permission_mode tidak ada di event ini", () => {
    const result = mapClaudeCodeHook(load("SessionStart.json"), stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.payload).toEqual({ cwd: "C:\\work\\project" });
  });

  test("PostToolUse -> tool.completed dengan ok=true", () => {
    const result = mapClaudeCodeHook(load("PostToolUse.Read.json"), stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.payload).toEqual({ toolName: "Read", toolUseId: "toolu_fixture0001", ok: true });
  });

  test("PostToolUse dari perintah yang dihentikan di tengah jalan -> ok=false", () => {
    const input = load("PostToolUse.Bash.json");
    const interrupted = { ...input, tool_response: { ...(input.tool_response as object), interrupted: true } };
    const result = mapClaudeCodeHook(interrupted, stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.payload).toMatchObject({ ok: false });
  });

  test("Stop -> agent.stopped membawa pesan terakhir agent", () => {
    const result = mapClaudeCodeHook(load("Stop.json"), stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.payload).toMatchObject({ lastMessage: expect.stringContaining("Semua tugas selesai") });
  });

  test("Notification -> agent.notification (belum ada fixture asli, bentuk dari dokumentasi)", () => {
    const input: HookInput = { hook_event_name: "Notification", session_id: "s1", message: "Claude butuh perhatianmu", title: "Perhatian" };
    const result = mapClaudeCodeHook(input, stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.payload).toEqual({ message: "Claude butuh perhatianmu", title: "Perhatian" });
  });

  test("PermissionRequest menjadi permintaan izin netral, bukan event kontrak", () => {
    const result = mapClaudeCodeHook(load("PermissionRequest.Write.json"), stamp);
    expect(result).toEqual({
      status: "permission_request",
      request: {
        sessionId: "00000000-0000-4000-8000-000000000001",
        toolName: "Write",
        toolInput: { file_path: "C:\\work\\project\\notes.txt", content: "catatan" },
        cwd: "C:\\work\\project",
        permissionMode: "default",
      },
    });
  });

  test("SessionEnd -> penanda sesi berakhir beserta alasannya", () => {
    expect(mapClaudeCodeHook(load("SessionEnd.json"), stamp)).toEqual({
      status: "session_ended",
      sessionId: "00000000-0000-4000-8000-000000000001",
      reason: "other",
    });
  });

  test("alat tanpa tool_input dianggap memakai input kosong", () => {
    const tanpaInput = load("PreToolUse.Read.json");
    delete tanpaInput.tool_input;
    expect("tool_input" in tanpaInput).toBe(false);
    const result = mapClaudeCodeHook(tanpaInput, stamp);
    if (result.status !== "event") throw new Error("seharusnya event");
    expect(result.event.payload).toMatchObject({ toolInput: {} });
  });

  test("input asli tidak diubah", () => {
    const input = load("PreToolUse.Edit.json");
    const before = JSON.stringify(input);
    mapClaudeCodeHook(input, stamp);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("data yang tidak dikenal atau rusak (dicatat, tidak melempar error)", () => {
  test("nama event tidak dikenal -> unknown", () => {
    expect(mapClaudeCodeHook({ hook_event_name: "EventDariVersiBaru", session_id: "s1" }, stamp)).toEqual({
      status: "unknown",
      hookEvent: "EventDariVersiBaru",
    });
  });

  test.each([
    ["tanpa session_id", { hook_event_name: "PreToolUse", tool_name: "Read" }],
    ["session_id kosong", { hook_event_name: "PreToolUse", session_id: "", tool_name: "Read" }],
    ["session_id bukan teks", { hook_event_name: "Stop", session_id: 42 }],
    ["PreToolUse tanpa tool_name", { hook_event_name: "PreToolUse", session_id: "s1" }],
    ["tool_input berupa daftar", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Read", tool_input: ["a"] }],
    ["tool_input null", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Read", tool_input: null }],
    ["tool_input berupa teks", { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Read", tool_input: "x" }],
    ["PostToolUse tanpa tool_name", { hook_event_name: "PostToolUse", session_id: "s1" }],
    ["SessionStart tanpa cwd", { hook_event_name: "SessionStart", session_id: "s1" }],
    ["Notification tanpa message", { hook_event_name: "Notification", session_id: "s1" }],
    ["PermissionRequest tanpa tool_name", { hook_event_name: "PermissionRequest", session_id: "s1" }],
    ["PermissionRequest dengan tool_input daftar", { hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Write", tool_input: [] }],
    ["SessionEnd tanpa session_id", { hook_event_name: "SessionEnd" }],
  ])("%s -> invalid, tanpa melempar error", (_name, input) => {
    const result = mapClaudeCodeHook(input as HookInput, stamp);
    expect(result.status).toBe("invalid");
  });

  test("pesan invalid tidak memuat isi input", () => {
    const result = mapClaudeCodeHook(
      { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: "RAHASIA-123" },
      stamp,
    );
    expect(JSON.stringify(result)).not.toContain("RAHASIA-123");
  });

  test("identitas hanya diminta bila hasilnya event (nomor urut tidak terbuang)", () => {
    const stampFor = vi.fn(stamp);
    const results = [
      mapClaudeCodeHook({ hook_event_name: "EventBaru", session_id: "s1" }, stampFor),
      mapClaudeCodeHook({ hook_event_name: "PreToolUse", session_id: "s1" }, stampFor), // invalid
      mapClaudeCodeHook(load("UserPromptSubmit.json"), stampFor),
      mapClaudeCodeHook(load("PermissionRequest.Edit.json"), stampFor),
      mapClaudeCodeHook(load("SessionEnd.json"), stampFor),
    ];
    expect(results.map((r) => r.status)).toEqual(["unknown", "invalid", "ignored", "permission_request", "session_ended"]);
    expect(stampFor).not.toHaveBeenCalled();

    mapClaudeCodeHook(load("PreToolUse.Read.json"), stampFor);
    expect(stampFor).toHaveBeenCalledTimes(1);
    expect(stampFor).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
  });
});
