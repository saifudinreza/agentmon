// Membuat file settings berisi hook pencatat untuk semua event yang kita pakai.
// Pemakaian: node make-settings.mjs <path-log-hook.mjs> <timeoutDetik> [event,event,...]
import process from "node:process";

const [hookPath, timeout, only] = process.argv.slice(2);
const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop", "SessionEnd"];
const chosen = only ? only.split(",") : events;
const hooks = Object.fromEntries(
  chosen.map((name) => [name, [{ hooks: [{ type: "command", ...(process.env.SPIKE_HTTP_URL ? { type: "http", url: process.env.SPIKE_HTTP_URL } : { command: `node "${hookPath}" ${name}` }), timeout: Number(timeout) }] }]]),
);
process.stdout.write(JSON.stringify({ hooks }, null, 2));
