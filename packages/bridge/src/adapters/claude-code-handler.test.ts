import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMonEvent } from "@agentmon/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startDaemon, type RunningDaemon } from "../daemon";
import { paths } from "../home";
import type { HookContext, HookInput } from "../server";
import { createClaudeCodeHandler, type EventSink } from "./claude-code-handler";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/claude-code/", import.meta.url));
const load = (name: string): HookInput =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as HookInput;
const inSession = (input: HookInput, sessionId: string): HookInput => ({ ...input, session_id: sessionId });

function fakeContext() {
  const logs: string[] = [];
  const context: HookContext = {
    machineId: "laptop-1",
    logger: { info: (m) => logs.push(`info: ${m}`), error: (m) => logs.push(`error: ${m}`) },
  };
  return { context, logs };
}

// Menunggu tugas yang dijadwalkan (pengiriman event berjalan di belakang layar).
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe("penangan hook Claude Code", () => {
  test("selalu menjawab tanpa keputusan, untuk semua jenis input", async () => {
    const { context } = fakeContext();
    const handler = createClaudeCodeHandler({ emit: () => undefined });
    const inputs: HookInput[] = [
      load("SessionStart.json"),
      load("PreToolUse.Write.json"),
      load("PermissionRequest.Write.json"),
      load("PostToolUse.Write.json"),
      load("Stop.json"),
      load("SessionEnd.json"),
      load("UserPromptSubmit.json"),
      { hook_event_name: "EventBaru", session_id: "s1" },
      { hook_event_name: "PreToolUse" },
    ];
    for (const input of inputs) expect(await handler(input, context)).toBeUndefined();
  });

  test("mengirim event berurutan dengan nomor urut 0,1,2 per sesi", async () => {
    const { context } = fakeContext();
    const seen: AgentMonEvent[] = [];
    const handler = createClaudeCodeHandler({ emit: (event) => void seen.push(event) });

    await handler(load("SessionStart.json"), context);
    await handler(load("PreToolUse.Read.json"), context);
    await handler(load("PostToolUse.Read.json"), context);
    await settle();

    expect(seen.map((e) => [e.type, e.seq])).toEqual([
      ["session.started", 0],
      ["tool.requested", 1],
      ["tool.completed", 2],
    ]);
    expect(new Set(seen.map((e) => e.id)).size).toBe(3); // setiap event punya id sendiri
    expect(seen.every((e) => e.machineId === "laptop-1")).toBe(true);
  });

  test("nomor urut dihitung terpisah untuk tiap sesi", async () => {
    const { context } = fakeContext();
    const seen: AgentMonEvent[] = [];
    const handler = createClaudeCodeHandler({ emit: (event) => void seen.push(event) });

    await handler(inSession(load("PreToolUse.Read.json"), "A"), context);
    await handler(inSession(load("PreToolUse.Read.json"), "B"), context);
    await handler(inSession(load("PreToolUse.Read.json"), "A"), context);
    await settle();

    expect(seen.map((e) => [e.sessionId, e.seq])).toEqual([
      ["A", 0],
      ["B", 0],
      ["A", 1],
    ]);
  });

  test("data yang ditolak atau tidak dikirim tidak memakai nomor urut", async () => {
    const { context } = fakeContext();
    const seen: AgentMonEvent[] = [];
    const handler = createClaudeCodeHandler({ emit: (event) => void seen.push(event) });

    await handler(inSession(load("PreToolUse.Read.json"), "A"), context); // seq 0
    await handler({ hook_event_name: "PreToolUse", session_id: "A" }, context); // invalid
    await handler({ hook_event_name: "EventBaru", session_id: "A" }, context); // tidak dikenal
    await handler(inSession(load("PermissionRequest.Edit.json"), "A"), context); // bukan event
    await handler(inSession(load("PostToolUse.Read.json"), "A"), context); // seq 1, tanpa celah
    await settle();

    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
  });

  test("setelah sesi berakhir, nomor urut sesi itu dimulai lagi dari 0", async () => {
    const { context } = fakeContext();
    const seen: AgentMonEvent[] = [];
    const handler = createClaudeCodeHandler({ emit: (event) => void seen.push(event) });

    await handler(load("PreToolUse.Read.json"), context);
    await handler(load("SessionEnd.json"), context);
    await handler(load("PreToolUse.Read.json"), context);
    await settle();

    expect(seen.map((e) => e.seq)).toEqual([0, 0]);
  });

  test("id dan waktu bisa diganti (supaya test pasti)", async () => {
    const { context } = fakeContext();
    const seen: AgentMonEvent[] = [];
    const handler = createClaudeCodeHandler({
      emit: (event) => void seen.push(event),
      now: () => new Date("2026-11-03T10:00:00Z"),
      newId: () => "22222222-2222-4222-8222-222222222222",
    });
    await handler(load("SessionStart.json"), context);
    await settle();
    expect(seen[0]).toMatchObject({ id: "22222222-2222-4222-8222-222222222222", ts: "2026-11-03T10:00:00.000Z" });
  });
});

describe("tidak memperlambat dan tidak mengganggu agent", () => {
  test("penerima yang tidak pernah selesai tidak menahan jawaban", async () => {
    const { context } = fakeContext();
    const neverResolves: EventSink = () => new Promise<void>(() => undefined);
    const handler = createClaudeCodeHandler({ emit: neverResolves });
    // Bila jawaban menunggu penerima, baris ini tidak akan pernah selesai (test timeout).
    expect(await handler(load("PostToolUse.Read.json"), context)).toBeUndefined();
  });

  test.each([
    ["melempar error sinkron", () => { throw new Error("sink rusak"); }],
    ["menolak (promise reject)", () => Promise.reject(new Error("sink rusak"))],
  ])("penerima yang %s hanya dicatat, jawaban tetap tanpa keputusan", async (_name, emit) => {
    const { context, logs } = fakeContext();
    const handler = createClaudeCodeHandler({ emit: emit as EventSink });
    expect(await handler(load("PostToolUse.Read.json"), context)).toBeUndefined();
    await settle();
    expect(logs.join("\n")).toContain("gagal mengirim event tool.completed: sink rusak");
  });

  test("event yang tidak dikenal dan yang rusak dicatat tanpa isinya", async () => {
    const { context, logs } = fakeContext();
    const emit = vi.fn();
    const handler = createClaudeCodeHandler({ emit });
    await handler({ hook_event_name: "EventDariVersiBaru", session_id: "s1", rahasia: "RAHASIA-123" }, context);
    await handler(
      { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: "RAHASIA-123" },
      context,
    );
    await settle();

    const text = logs.join("\n");
    expect(text).toContain("EventDariVersiBaru");
    expect(text).toContain("PreToolUse tidak sah");
    expect(text).not.toContain("RAHASIA-123");
    expect(emit).not.toHaveBeenCalled();
  });

  test("kesalahan tak terduga di pemetaan tidak sampai ke agent", async () => {
    const { context, logs } = fakeContext();
    const handler = createClaudeCodeHandler({
      emit: () => undefined,
      newId: () => {
        throw new Error("pembuat id rusak");
      },
    });
    expect(await handler(load("PreToolUse.Read.json"), context)).toBeUndefined();
    expect(logs.join("\n")).toContain("pemetaan hook gagal: pembuat id rusak");
  });
});

describe("terpasang di daemon sungguhan", () => {
  let home: string | undefined;
  let daemon: RunningDaemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function post(d: RunningDaemon, input: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: d.port,
          path: "/hook",
          method: "POST",
          headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(input));
    });
  }

  test("fixture dikirim lewat HTTP: dijawab {} dan event mengandung machineId laptop ini", async () => {
    home = mkdtempSync(join(tmpdir(), "agentmon-adapter-"));
    const seen: AgentMonEvent[] = [];
    daemon = await startDaemon({ home, port: 0, onHook: createClaudeCodeHandler({ emit: (event) => void seen.push(event) }) });

    const reply = await post(daemon, load("PreToolUse.Edit.json"));
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({});
    await settle();

    const machineId = readFileSync(paths(home).machineId, "utf8").trim();
    expect(machineId).not.toBe("");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "tool.requested", machineId, seq: 0 });
  });

  test("machineId tetap sama setelah daemon dimulai ulang", async () => {
    home = mkdtempSync(join(tmpdir(), "agentmon-adapter-"));
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      daemon = await startDaemon({
        home,
        port: 0,
        onHook: createClaudeCodeHandler({ emit: (event) => void ids.push(event.machineId) }),
      });
      await post(daemon, load("SessionStart.json"));
      await settle();
      await daemon.stop();
      daemon = undefined;
    }
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("batas antara inti daemon dan adapter", () => {
  // Kriteria issue: inti daemon tidak berisi logika khusus Claude Code. Pemeriksaan kasar
  // tapi berguna: berkas inti tidak mengimpor adapter dan tidak menyebut nama event Claude.
  const core = ["daemon.ts", "server.ts", "guard.ts", "home.ts", "logger.ts"];
  const claudeSpecific = /PreToolUse|PostToolUse|PermissionRequest|SessionStart|SessionEnd|UserPromptSubmit|tool_input|session_id/;

  test.each(core)("%s tidak mengimpor adapter dan tidak menyebut istilah event Claude Code", (name) => {
    const source = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\/adapters/);
    expect(source).not.toMatch(claudeSpecific);
  });
});
