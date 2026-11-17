// =====================================================================================
// FILE INI: format dan pemuat berkas aturan = "BUKU ATURAN" milik pengguna untuk policy engine.
// =====================================================================================
//
// Berkas aturan pengguna: `~/.agentmon/policy.json`. Contoh:
//   { "version": 1, "rules": [
//       { "id": "tes", "action": "allow", "tool": "Bash", "commands": ["npm test", "git status", "git diff *"] },
//       { "id": "env", "action": "ask", "tool": "*" }
//   ] }
//
// Prinsip (PRD §9): berkas ini hanya boleh MELONGGARKAN bila datang dari pengguna.
//   - Berkas rusak, kosong, berversi asing, terlalu besar, atau berisi kolom yang tidak dikenal: SELURUH berkas ditolak,
//     jadi tidak ada aturan izinkan sama sekali (gagal tertutup). Pengguna diberi tahu lewat `problems`.
//   - Berkas tidak ada: tidak ada aturan, dan itu wajar (bukan masalah).
//   - Aturan di dalam repo (`<proyek>/.agentmon/policy.json`) hanya boleh MEMPERKETAT: aturan `allow` darinya diabaikan.
//     Repo tidak dipercaya; repo jahat tidak boleh mengizinkan aksinya sendiri.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { MAX_POLICY_BYTES, PolicyFileSchema, type PolicyFile, type Rule } from "@agentmon/shared";

// Bentuk berkasnya didefinisikan di paket shared (dipakai juga oleh HP); diteruskan di sini untuk kemudahan.
export { MAX_POLICY_BYTES, MAX_RULES, POLICY_VERSION, PolicyFileSchema, RuleSchema, type PolicyFile, type Rule } from "@agentmon/shared";

export type FileStatus = "ok" | "missing" | "invalid";

export type PolicyLoad = {
  /** Aturan yang berlaku, urutan berkas: milik pengguna dulu, lalu milik repo (id repo diberi awalan `repo:`). */
  rules: Rule[];
  userFile: FileStatus;
  repoFile: FileStatus;
  /** Berapa aturan `allow` dari repo yang diabaikan. */
  ignoredRepoAllow: number;
  /** Masalah yang harus diberitahukan ke pengguna (Bahasa Indonesia). Kosong bila semuanya baik. */
  problems: string[];
};

export type ReadText = (path: string) => string | undefined;

/**
 * Membaca teks berkas; undefined bila tidak ada. Berkas yang ada tetapi tidak terbaca, bukan berkas biasa (folder, FIFO,
 * perangkat), atau lebih besar dari batas dikembalikan sebagai teks yang pasti ditolak (rusak). Hanya MAX+1 byte yang dibaca,
 * karena berkas aturan di dalam repo dikendalikan penyerang.
 */
export const readTextFile: ReadText = (path) => {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (!fstatSync(fd).isFile()) return "";
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const n = readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
    }
    return buffer.subarray(0, total).toString("utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

function parseFile(text: string | undefined, label: string): { status: FileStatus; file?: PolicyFile; problem?: string } {
  if (text === undefined) return { status: "missing" };
  if (Buffer.byteLength(text, "utf8") > MAX_POLICY_BYTES) return { status: "invalid", problem: `${label}: berkas terlalu besar, semua aturannya diabaikan.` };
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { status: "invalid", problem: `${label}: bukan JSON yang sah (atau kosong), semua aturannya diabaikan.` };
  }
  const parsed = PolicyFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (di ${issue.path.join(".")})` : "";
    return { status: "invalid", problem: `${label}: isi tidak sah${where}, semua aturannya diabaikan. ${issue?.message ?? ""}`.trim() };
  }
  return { status: "ok", file: parsed.data };
}

/**
 * Memuat aturan. `userPath` adalah berkas milik pengguna; `repoPath` (opsional) berkas di dalam proyek.
 * Tidak pernah melempar galat. Berkas pengguna yang rusak berarti TIDAK ADA aturan izinkan.
 */
export function loadPolicy(options: { userPath: string; repoPath?: string; readText?: ReadText }): PolicyLoad {
  const read = options.readText ?? readTextFile;
  const problems: string[] = [];
  const rules: Rule[] = [];

  const user = parseFile(read(options.userPath), "Aturan Anda (policy.json)");
  if (user.problem) problems.push(user.problem);
  if (user.file) rules.push(...user.file.rules);

  let repoStatus: FileStatus = "missing";
  let ignoredRepoAllow = 0;
  if (options.repoPath !== undefined) {
    const repo = parseFile(read(options.repoPath), "Aturan di dalam proyek (.agentmon/policy.json)");
    repoStatus = repo.status;
    if (repo.problem) problems.push(repo.problem);
    for (const rule of repo.file?.rules ?? []) {
      // Repo tidak dipercaya: hanya boleh memperketat. Id diberi awalan supaya tidak menimpa atau meniru aturan pengguna.
      if (rule.action === "allow") ignoredRepoAllow += 1;
      else rules.push({ ...rule, id: `repo:${rule.id}` });
    }
    if (ignoredRepoAllow > 0) problems.push(`Aturan di dalam proyek: ${ignoredRepoAllow} aturan 'allow' diabaikan (proyek tidak boleh mengizinkan aksinya sendiri).`);
  }

  return { rules, userFile: user.status, repoFile: repoStatus, ignoredRepoAllow, problems };
}

export const userPolicyPath = (home: string) => join(home, "policy.json");
export const repoPolicyPath = (cwd: string) => join(cwd, ".agentmon", "policy.json");
