import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_PORT, startDaemon, type RunningDaemon } from "./daemon";
import {
  buildClaudeHookSettings,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  DEFAULT_OBSERVE_TIMEOUT_SECONDS,
  HOOK_EVENTS,
} from "./hook-config";

const TOKEN = "a".repeat(64);

describe("buildClaudeHookSettings", () => {
  // Daftar ini sengaja ditulis eksplisit (bukan diambil dari HOOK_EVENTS): menambah atau
  // menghapus event adalah perubahan kontrak, dan test ini harus ikut diubah dengan sadar.
  test("mendaftarkan persis tujuh event yang dipakai kontrak, dan tidak mendaftarkan UserPromptSubmit", () => {
    const { hooks } = buildClaudeHookSettings({ token: TOKEN });
    expect(Object.keys(hooks).sort()).toEqual(
      ["Notification", "PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop"],
    );
    expect(Object.keys(hooks)).not.toContain("UserPromptSubmit");
  });

  test("setiap hook bertipe http ke 127.0.0.1 dengan token dan batas waktu", () => {
    const { hooks } = buildClaudeHookSettings({ token: TOKEN, port: 51234, timeoutSeconds: 30, observeTimeoutSeconds: 5 });
    for (const event of HOOK_EVENTS) {
      expect(hooks[event]).toEqual([
        {
          hooks: [
            {
              type: "http",
              url: "http://127.0.0.1:51234/hook",
              headers: { Authorization: `Bearer ${TOKEN}` },
              timeout: event === "PreToolUse" || event === "PermissionRequest" ? 30 : 5,
            },
          ],
        },
      ]);
    }
  });

  test("hanya event keputusan yang menunggu lama, event pengamatan memakai batas pendek", () => {
    const { hooks } = buildClaudeHookSettings({ token: TOKEN });
    const timeoutOf = (event: (typeof HOOK_EVENTS)[number]) => hooks[event][0]?.hooks[0]?.timeout;
    expect(timeoutOf("PreToolUse")).toBe(DEFAULT_HOOK_TIMEOUT_SECONDS);
    expect(timeoutOf("PermissionRequest")).toBe(DEFAULT_HOOK_TIMEOUT_SECONDS);
    for (const event of ["SessionStart", "PostToolUse", "Notification", "Stop", "SessionEnd"] as const) {
      expect(timeoutOf(event)).toBe(DEFAULT_OBSERVE_TIMEOUT_SECONDS);
    }
    expect(DEFAULT_OBSERVE_TIMEOUT_SECONDS).toBeLessThan(DEFAULT_HOOK_TIMEOUT_SECONDS);
  });

  test("memakai port dan batas waktu bawaan bila tidak diisi", () => {
    const hook = buildClaudeHookSettings({ token: TOKEN }).hooks.PreToolUse[0]?.hooks[0];
    expect(hook?.url).toBe(`http://127.0.0.1:${DEFAULT_PORT}/hook`);
    expect(hook?.timeout).toBe(DEFAULT_HOOK_TIMEOUT_SECONDS);
  });

  test("tiap event punya objek headers sendiri (mengubah satu tidak mengubah yang lain)", () => {
    const { hooks } = buildClaudeHookSettings({ token: TOKEN });
    const first = hooks.PreToolUse[0]?.hooks[0];
    const second = hooks.PostToolUse[0]?.hooks[0];
    if (!first || !second) throw new Error("hook tidak ada");
    expect(first.headers).not.toBe(second.headers);
    first.headers.Authorization = "diubah";
    expect(second.headers.Authorization).toBe(`Bearer ${TOKEN}`);
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
    ["batas waktu pengamatan nol", { token: TOKEN, observeTimeoutSeconds: 0 }],
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
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { ...hook.headers, "content-type": "application/json" } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write" }));
    });
    expect(reply.status).toBe(200);
    // Tanpa penangan keputusan, jawabannya harus "tidak ada keputusan", bukan persetujuan.
    expect(JSON.parse(reply.body)).toEqual({});
  });
});
