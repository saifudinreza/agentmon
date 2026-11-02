import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_PORT, startDaemon, type RunningDaemon } from "./daemon";
import { buildClaudeHookSettings, DEFAULT_HOOK_TIMEOUT_SECONDS, HOOK_EVENTS } from "./hook-config";

const TOKEN = "a".repeat(64);

describe("buildClaudeHookSettings", () => {
  test("mendaftarkan semua event yang dipakai kontrak, dan tidak mendaftarkan UserPromptSubmit", () => {
    const { hooks } = buildClaudeHookSettings({ token: TOKEN });
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(Object.keys(hooks)).not.toContain("UserPromptSubmit");
  });

  test("setiap hook bertipe http ke 127.0.0.1 dengan token dan batas waktu", () => {
    const { hooks } = buildClaudeHookSettings({ token: TOKEN, port: 51234, timeoutSeconds: 30 });
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]).toEqual([
        {
          hooks: [
            {
              type: "http",
              url: "http://127.0.0.1:51234/hook",
              headers: { Authorization: `Bearer ${TOKEN}` },
              timeout: 30,
            },
          ],
        },
      ]);
    }
  });

  test("memakai port dan batas waktu bawaan bila tidak diisi", () => {
    const hook = buildClaudeHookSettings({ token: TOKEN }).hooks.PreToolUse[0]?.hooks[0];
    expect(hook?.url).toBe(`http://127.0.0.1:${DEFAULT_PORT}/hook`);
    expect(hook?.timeout).toBe(DEFAULT_HOOK_TIMEOUT_SECONDS);
  });

  test("tidak pernah memuat onFailure (agar kegagalan tidak memblokir agent) maupun localhost", () => {
    const text = JSON.stringify(buildClaudeHookSettings({ token: TOKEN }));
    expect(text).not.toContain("onFailure");
    expect(text).not.toContain("block");
    expect(text).not.toContain("localhost");
  });

  test.each([
    ["port 0", { port: 0, token: TOKEN }],
    ["port terlalu besar", { port: 70000, token: TOKEN }],
    ["port pecahan", { port: 80.5, token: TOKEN }],
    ["token pendek", { token: "abc" }],
    ["token bukan heksadesimal", { token: "z".repeat(64) }],
    ["batas waktu nol", { token: TOKEN, timeoutSeconds: 0 }],
    ["batas waktu pecahan", { token: TOKEN, timeoutSeconds: 1.5 }],
  ])("menolak %s", (_name, options) => {
    expect(() => buildClaudeHookSettings(options)).toThrow();
  });
});

describe("cocok dengan daemon", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("permintaan persis seperti yang dikonfigurasi diterima daemon sungguhan", async () => {
    home = mkdtempSync(join(tmpdir(), "agentmon-cfg-"));
    daemon = await startDaemon({ home, port: 0 });
    const hook = buildClaudeHookSettings({ port: daemon.port, token: daemon.token }).hooks.PreToolUse[0]?.hooks[0];
    if (!hook) throw new Error("hook tidak ada");

    // Meniru Claude Code: POST JSON ke alamat dan dengan header dari konfigurasi.
    const url = new URL(hook.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { ...hook.headers, "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write" }));
    });
    expect(status).toBe(200);
  });
});
