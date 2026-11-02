// Membuat file settings berisi hook pencatat untuk semua event yang kita pakai.
// Pemakaian: node make-settings.mjs <path-log-hook.mjs> <timeoutDetik> [event,event,...]
//
// Variabel untuk hook bertipe "http":
//   SPIKE_HTTP_URL          alamat penerima. Bila diisi, hook memakai type "http"
//   SPIKE_HTTP_HEADERS      objek JSON berisi header, misalnya {"Authorization":"Bearer ..."}
//   SPIKE_HTTP_ALLOWED_ENV  daftar nama variabel lingkungan (dipisah koma) yang boleh
//                           diselipkan ke nilai header lewat $NAMA
import process from "node:process";

const [hookPath, timeout, only] = process.argv.slice(2);
const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop", "SessionEnd"];
const chosen = only ? only.split(",") : events;

const handler = (name) => {
  if (!process.env.SPIKE_HTTP_URL) {
    return { type: "command", command: `node "${hookPath}" ${name}`, timeout: Number(timeout) };
  }
  return {
    type: "http",
    url: process.env.SPIKE_HTTP_URL,
    ...(process.env.SPIKE_HTTP_HEADERS ? { headers: JSON.parse(process.env.SPIKE_HTTP_HEADERS) } : {}),
    ...(process.env.SPIKE_HTTP_ALLOWED_ENV ? { allowedEnvVars: process.env.SPIKE_HTTP_ALLOWED_ENV.split(",") } : {}),
    timeout: Number(timeout),
  };
};

const hooks = Object.fromEntries(chosen.map((name) => [name, [{ hooks: [handler(name)] }]]));
process.stdout.write(JSON.stringify({ hooks }, null, 2));
