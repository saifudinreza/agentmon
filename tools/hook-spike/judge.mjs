// Menilai hasil satu eksperimen anti-macet.
// Pemakaian: node judge.mjs <folder-hasil> <nama> <diharapkan: ditolak|disetujui> <batasMs>
//
// "ditolak" berarti aksi tidak boleh berjalan (alur izin normal, yang di mode non-interaktif
// berarti ditolak). "disetujui" dipakai untuk kontrol positif.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const [dir, name, expected, limit] = process.argv.slice(2);
const rows = existsSync(`${dir}/stream.jsonl`)
  ? readFileSync(`${dir}/stream.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const result = rows.find((m) => m.type === "result");
const seed = new Set(readdirSync(new URL("./seed/", import.meta.url)));
const created = readdirSync(`${dir}/project`).filter((f) => !seed.has(f));

const toolErrors = rows
  .filter((m) => m.type === "user")
  .flatMap((m) => m.message?.content ?? [])
  .filter((c) => c.type === "tool_result" && c.is_error)
  .map((c) => String(c.content));
// Pesan penolakan izin normal Claude Code (alat Write/Edit memakai "requested permissions",
// alat shell dengan pengalihan keluaran memakai "needs approval").
const permissionPrompted = toolErrors.some((t) => /requested permissions|haven't granted|needs approval|permission/i.test(t));
// Pesan yang hanya muncul bila hook memblokir atau menambah konteks ke Claude.
const hookError = toolErrors.some((t) => /hook (error|additional context)|^(PreToolUse|PermissionRequest):/i.test(t));

const finished = result?.subtype === "success";
const ms = result?.duration_ms ?? -1;
const approved = created.length > 0;

const problems = [];
if (!finished) problems.push("sesi tidak selesai");
if (limit && ms > Number(limit)) problems.push(`lambat (${ms} ms > ${limit} ms)`);
if (expected === "ditolak") {
  if (approved) problems.push(`AKSI DISETUJUI: ${created.join(", ")}`);
  if (!permissionPrompted) problems.push("alur izin normal tidak teramati");
  if (hookError) problems.push("pesan error hook sampai ke Claude");
} else if (!approved) {
  problems.push("kontrol positif gagal: aksi tidak disetujui padahal jawabannya allow");
}

const verdict = problems.length === 0 ? "LOLOS" : `GAGAL: ${problems.join("; ")}`;
process.stdout.write(
  `${name.padEnd(26)} | sesi ${finished ? "selesai" : "TIDAK selesai"} | ${String(ms).padStart(6)} ms | berkas baru: ${created.length ? created.join(",") : "-"} | ${verdict}\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
