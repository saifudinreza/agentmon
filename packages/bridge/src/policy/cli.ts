// =====================================================================================
// FILE INI: perintah `agentmon policy ...`. Hanya MENGUJI dan MENCETAK; tidak pernah menjalankan perintah yang diuji.
//   policy test "<perintah>" [--tool Bash] [--file <jalur>] [--cwd <folder>] [--scripts-changed]
//   policy preset [nama]
// =====================================================================================
import { loadPolicy, repoPolicyPath, userPolicyPath } from "./config";
import { evaluatePolicy } from "./evaluate";
import { PRESETS } from "./presets";

export const POLICY_USAGE = [
  'Pemakaian: agentmon policy test "<perintah>" [--tool Bash] [--cwd <folder>] [--scripts-changed]',
  "            agentmon policy test --tool Write --file <jalur> [--cwd <folder>]",
  "            agentmon policy preset [nama]",
].join("\n");

const ACTION: Record<string, string> = { allow: "IZINKAN otomatis", ask: "TANYA (naik ke HP)", deny: "TOLAK otomatis" };
const WHY: Record<string, string> = {
  "deny-rule": "cocok dengan aturan tolak",
  "ask-rule": "cocok dengan aturan tanya",
  "agent-rule": "aturan milik agent",
  "risk-high": "risiko TINGGI tidak pernah diizinkan otomatis",
  "risk-uncertain": "penilai tidak yakin (risiko sedang selain 'menjalankan kode proyek'), jadi tidak diizinkan otomatis",
  "no-allow-rules": "tidak ada aturan izinkan (default: tanya)",
  "scripts-changed": "berkas skrip berubah di sesi ini, izin ditangguhkan",
  "not-analyzable": "perintah tidak bisa dianalisis dengan pasti (rantai, substitusi, redirect, atau variabel)",
  "unmatched-part": "ada bagian perintah yang tidak diizinkan aturan mana pun",
  "allow-rule": "semua bagian diizinkan aturan",
  error: "galat, jadi bertanya",
};

export function runPolicy(args: string[], deps: { out: (text: string) => void; err: (text: string) => void }, home: string): number {
  const [sub, ...rest] = args;
  if (sub === "preset") {
    const name = rest[0];
    if (!name) {
      for (const [key, preset] of Object.entries(PRESETS)) deps.out(`${key}: ${preset.description}`);
      deps.out("Cetak isinya dengan `agentmon policy preset <nama>`, lalu simpan sendiri ke policy.json bila cocok. Tidak ada yang aktif sampai Anda menyimpannya.");
      return 0;
    }
    const preset = PRESETS[name];
    if (!preset) {
      deps.err(`Preset '${name}' tidak ada.`);
      return 2;
    }
    deps.out(JSON.stringify(preset.file, null, 2));
    return 0;
  }
  if (sub !== "test") {
    deps.err(POLICY_USAGE);
    return 2;
  }

  let tool = "Bash";
  let cwd = process.cwd();
  let file: string | undefined;
  let scriptsChanged = false;
  let command: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--tool" || arg === "--cwd" || arg === "--file") {
      const value = rest[++i];
      if (value === undefined) {
        deps.err(`${arg} butuh nilai.\n${POLICY_USAGE}`);
        return 2;
      }
      if (arg === "--tool") tool = value;
      else if (arg === "--cwd") cwd = value;
      else file = value;
    } else if (arg === "--scripts-changed") scriptsChanged = true;
    else if (command === undefined && !arg.startsWith("--")) command = arg;
    else {
      deps.err(`Argumen tidak dikenal: ${arg}\n${POLICY_USAGE}`);
      return 2;
    }
  }
  if ((command === undefined) === (file === undefined)) {
    deps.err(POLICY_USAGE);
    return 2;
  }

  const load = loadPolicy({ userPath: userPolicyPath(home), repoPath: repoPolicyPath(cwd) });
  const toolInput = file !== undefined ? { file_path: file } : { command };
  const result = evaluatePolicy({ toolName: tool, toolInput, cwd }, load, { scriptsChanged });
  deps.out(`Hasil   : ${ACTION[result.action]}`);
  deps.out(`Aturan  : ${result.matched.length > 0 ? result.matched.join(", ") : "(bawaan)"}`);
  deps.out(`Alasan  : ${WHY[result.why] ?? result.why}`);
  deps.out(`Risiko  : ${result.risk.level}${result.risk.reasons.length > 0 ? ` (${result.risk.reasons.map((r) => r.message).join(" ")})` : ""}`);
  deps.out("Perintah ini TIDAK dijalankan.");
  for (const problem of load.problems) deps.err(`PERINGATAN: ${problem}`);
  return 0;
}
