// =====================================================================================
// FILE INI: policy engine = "PETUGAS PENENTU" yang memutuskan satu permintaan izin: izinkan, tanya, atau tolak.
// =====================================================================================
//
// Delapan aturan keselamatan (PRD §9) dan di mana ditegakkan di sini:
//   1. Batas keras: risiko TINGGI tidak pernah `allow` (cek sebelum aturan izinkan dibaca).
//   2. Default ketat: tanpa aturan izinkan yang cocok, hasilnya `ask`. Risiko rendah saja tidak cukup.
//   3. Ragu berarti tanya: perintah berantai, substitusi, redirect, kata dinamis, kutip tak tertutup: setiap bagiannya
//      harus diizinkan, dan yang tidak bisa dianalisis tidak pernah `allow`.
//   4. Celah skrip: bila agent sudah mengubah proyek di sesi ini (`scriptsChanged`), aturan izinkan untuk perintah shell yang menjalankan
//      kode proyek (risiko bukan rendah, mis. `npm test`) ditangguhkan; perintah baca-saja yang dikenali tetap jalan.
//   5. Repo tidak dipercaya: ditegakkan di `loadPolicy` (config.ts); aturan `allow` dari repo tidak pernah sampai ke sini.
//   6. Aturan agent (`agentRule` ask/deny) tidak pernah dilonggarkan.
//   7. Bisa diaudit: hasil memuat `ruleId` dan `matched` (aturan penyebab) untuk dicatat pemanggil.
//   8. Dievaluasi di laptop: fungsi murni tanpa jaringan. Relay tidak punya jalan masuk ke sini.
//
// Urutan keputusan: aturan deny > aturan ask > batas risiko > prasyarat izinkan > aturan allow > default ask.
//
// KESELAMATAN `allow` TIDAK BOLEH BERSANDAR PADA PENILAI RISIKO. Penilai berbasis daftar hitam dan sudah terbukti bocor (sed
// `s|x|y|e`, awk -f, git grep --open, sort -o, spasi Unicode di PowerShell, ...). Maka mesin ini menambah lapisan sendiri
// yang tidak bergantung padanya:
//   - Aturan allow untuk SHELL wajib punya `commands`. Tidak ada "izinkan semua perintah".
//   - Pola persis (tanpa `*`) mengizinkan tepat perintah itu. Pola dengan `*` hanya menerima argumen berupa KATA BIASA:
//     tanpa flag (`-x`), tanpa kutip, koma, titik dua, `=`, `|`, `{}`, atau karakter non-ASCII. Semua serangan lewat opsi
//     atau skrip inline (flag apa pun) otomatis jatuh ke `ask`. Perintah yang argumennya bisa berupa skrip atau tujuan tulis
//     (sed, awk, find, sort, uniq, tee, cp, ...) tidak pernah dicocokkan lewat `*`.
//   - Pipa, `cd`, `export`, `alias`, `source`, dan sejenisnya (perintah yang mengubah keadaan shell) tidak pernah di-allow.
//   - Risiko SEDANG ("menjalankan kode proyek", misalnya `npm test`) hanya boleh lewat pola PERSIS.
//   - Risiko selain itu (tidak dikenal, tidak bisa diurai, di luar proyek, dst.) tidak pernah di-allow: ragu berarti tanya.
//
// Fungsi ini murni (kecuali `assessRisk` dengan `realpath` opsional) dan TIDAK PERNAH menjalankan aksinya. Tidak melempar galat:
// kegagalan apa pun berujung `ask`.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PolicyResult, Risk } from "@agentmon/shared";
import { assessRisk, lexShell, type AssessOptions, type ShellKind, type Stage } from "../risk";
import { filePathOf } from "../risk/assess";
import type { PolicyLoad, Rule } from "./config";

export type PolicyInput = { toolName: string; toolInput: unknown; cwd?: string };

export type PolicyContext = {
  /** Berkas skrip/build (package.json, Makefile, dan sejenisnya) sudah berubah di sesi ini: aturan izinkan shell ditangguhkan. */
  scriptsChanged?: boolean;
  /** Aturan milik agent sendiri (deny/ask) yang berlaku untuk permintaan ini. Tidak pernah dilonggarkan. */
  agentRule?: "ask" | "deny";
};

export type PolicyWhy =
  | "deny-rule"
  | "ask-rule"
  | "agent-rule"
  | "risk-high"
  | "risk-uncertain"
  | "no-allow-rules"
  | "scripts-changed"
  | "not-analyzable"
  | "unmatched-part"
  | "allow-rule"
  | "error";

export type PolicyDecision = PolicyResult & {
  why: PolicyWhy;
  /** Semua aturan yang ikut menentukan (urutan dipakai). Kosong untuk hasil bawaan. */
  matched: string[];
  risk: Risk;
};

const MAX_DEPTH = 3;
const MAX_PARTS = 60;
/** Jalur yang lebih panjang dari ini tidak dicocokkan dengan pola (mencegah pencocokan mahal) dan dianggap tidak pasti. */
const MAX_PATH_LENGTH = 512;
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "ls", "notebookread"]);
/** Satu-satunya alasan risiko SEDANG yang masih boleh di-allow: perintah memang menjalankan kode proyek (npm test, dan sejenisnya). */
const ALLOWABLE_MEDIUM = new Set(["runs-project-code"]);
/** Perintah yang mengubah keadaan shell (folder kerja, variabel, alias): perintah sesudahnya berjalan di tempat yang tidak diketahui. */
const STATEFUL = new Set(["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location", "export", "unset", "set", "setx", "alias", "unalias", "source", ".", "eval", "exec", "function", "readonly", "declare", "local", "typeset", "shopt", "umask", "trap", "ulimit", "set-variable", "sv", "new-alias", "set-alias", "sal", "new-variable", "nv", "read", "hash", "enable", "let", "mapfile", "readarray", "new-psdrive", "set-item", "si"]);
/** Perintah yang TIDAK PERNAH dicocokkan lewat pola `*`: argumennya bisa berupa skrip, program, atau tujuan tulis. Tetap bisa lewat pola persis. */
const WILDCARD_FORBIDDEN = new Set([
  "sed", "awk", "gawk", "mawk", "nawk", "perl", "python", "python3", "ruby", "php", "lua", "node", "deno", "bun", "sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd",
  "find", "xargs", "env", "time", "nohup", "nice", "ionice", "timeout", "sudo", "doas", "su", "watch", "stdbuf", "setsid", "command", "builtin",
  "sort", "uniq", "tee", "cp", "mv", "ln", "install", "dd", "touch", "mkdir", "rmdir", "rm", "split", "csplit", "truncate", "chmod", "chown", "shuf", "date", "history", "tree", "file",
  "ssh", "scp", "rsync", "curl", "wget", "nc", "ncat", "socat", "less", "more", "man", "vi", "vim", "nano", "emacs", "code", "open", "start", "explorer", "xdg-open",
  "hostname", "sleep", "kill", "pkill", "killall", "shutdown", "reboot", "du",
]);
/**
 * Kata biasa: huruf, angka, titik, garis miring, garis penghubung di dalam kata. Tidak diawali `-` (flag), `/` `\` `~` (jalur
 * mutlak atau rumah: di Git Bash `/c` adalah drive C:, dan UNC memicu SMB), tidak ada segmen `..`, kutip, koma, titik dua, `=`, `|`,
 * `$`, `{}`, atau non-ASCII.
 */
const PLAIN_WORD = /^[A-Za-z0-9_.][A-Za-z0-9_./\\@+~^-]*$/;
const PARENT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;
const isPlain = (word: string) => PLAIN_WORD.test(word) && !PARENT_SEGMENT.test(word);
/** Subperintah git yang MENAMPILKAN isi berkas dari riwayat: argumen revisi lewat `*` bisa membuka rahasia yang pernah di-commit. */
const GIT_CONTENT = new Set(["show", "cat-file", "grep", "blame", "annotate", "diff", "difftool", "format-patch", "archive", "bundle", "whatchanged"]);
const isRevisionLike = (word: string) => /^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)/i.test(word) || /[~^]/.test(word) || /^[0-9a-f]{7,40}$/i.test(word);
/** Alat pencari folder: hanya boleh di-allow oleh aturan yang menyebut `paths` (folder yang disebut pengguna), karena membaca isi folder secara rekursif. */
const SEARCH_TOOLS = new Set(["grep", "glob", "ls"]);
/** Realpath bawaan: tautan simbolik/junction di proyek tidak boleh menyamarkan jalur di luar proyek. */
const defaultRealpath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
/** Pembungkus yang meneruskan perintah lain; dibuka untuk pencocokan aturan tolak/tanya. */
const WRAPPERS = new Set(["command", "env", "builtin", "nohup", "time", "sudo", "doas", "exec", "nice", "stdbuf", "timeout", "xargs", "setsid", "pkexec"]);
/** Nama pendek PowerShell untuk cmdlet yang sering ditolak. Hanya untuk aturan tolak/tanya. */
const ALIASES: Record<string, string> = { ri: "remove-item", del: "remove-item", erase: "remove-item", rd: "remove-item", rmdir: "remove-item", rm: "remove-item", gci: "get-childitem", dir: "get-childitem", ls: "get-childitem", iex: "invoke-expression", iwr: "invoke-webrequest", curl: "invoke-webrequest", wget: "invoke-webrequest" };

type Part =
  | { kind: "shell"; words: string[]; variants: string[][] }
  | { kind: "file"; path: string | undefined }
  | { kind: "tool" };
type Target = { parts: Part[]; analyzable: boolean };

const toolOf = (input: PolicyInput) => (typeof input.toolName === "string" ? input.toolName.trim().toLowerCase() : "");

/** Nama perintah seragam: tanpa folder dan ekstensi, huruf kecil (Windows dan PowerShell tidak membedakan huruf). */
function canonicalName(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

/**
 * Bentuk-bentuk lain dari satu perintah yang berarti hal yang sama bagi shell: huruf besar kecil, jalur lengkap, `.exe`,
 * pembungkus (`env`, `command`, `sudo`, ...), awalan variabel, dan nama pendek PowerShell. HANYA dipakai untuk aturan tolak/tanya
 * (yang boleh berlebihan); aturan izinkan memakai kata persis apa adanya.
 */
function variantsOf(words: readonly string[]): string[][] {
  const out: string[][] = [words.map((w) => w.toLowerCase())];
  let current = [...words];
  for (let round = 0; round < 4 && current.length > 0; round++) {
    let start = 0;
    while (start < current.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[start]!)) start += 1;
    const head = start < current.length ? canonicalName(current[start]!) : "";
    if (WRAPPERS.has(head)) {
      start += 1;
      while (start < current.length && current[start]!.startsWith("-")) start += 1;
    }
    const next = current.slice(start);
    const first = next[0] === undefined ? undefined : canonicalName(next[0]);
    if (first !== undefined) {
      const rest = next.slice(1).map((w) => w.toLowerCase());
      out.push([first, ...rest]);
      if (ALIASES[first] !== undefined) out.push([ALIASES[first]!, ...rest]);
    }
    if (start === 0) break;
    current = next;
  }
  return out;
}

function isHarmlessRedirect(target: string | undefined, kind: ShellKind): boolean {
  // Di bash, pembuangan ke /dev/null tidak berefek. Di PowerShell itu menulis berkas bernama \dev\null.
  return kind === "bash" && target === "/dev/null";
}

/** Memecah perintah shell menjadi perintah-perintah tunggal (termasuk isi substitusi). Mengembalikan false bila ada yang tidak pasti. */
function shellParts(command: string, kind: ShellKind, depth: number, out: Part[]): boolean {
  if (depth > MAX_DEPTH) return false;
  const lexed = lexShell(command, kind);
  let ok = !lexed.unbalanced;
  for (const pipeline of lexed.pipelines) {
    // Pipa meneruskan keluaran satu perintah ke perintah lain (mis. daftar berkas ke Get-Content): hubungan itu tidak bisa dinilai per bagian.
    if (pipeline.length > 1) ok = false;
    for (const stage of pipeline as Stage[]) {
      if (out.length >= MAX_PARTS) return false;
      if (stage.words.length === 0) {
        ok = false; // hanya redirect, atau kosong: tidak ada perintah yang bisa dicocokkan
        continue;
      }
      if (stage.words.some((w) => w.dynamic)) ok = false;
      if (stage.heredoc !== undefined) ok = false;
      if (stage.redirects.some((r) => !isHarmlessRedirect(r.target?.text, kind) || r.target?.dynamic === true)) ok = false;
      const words = stage.words.map((w) => w.text);
      const variants = variantsOf(words);
      if (variants.some((v) => v[0] !== undefined && STATEFUL.has(v[0]))) ok = false;
      out.push({ kind: "shell", words, variants });
    }
  }
  for (const inner of lexed.substitutions) {
    if (!shellParts(inner, kind, depth + 1, out)) ok = false;
  }
  return ok;
}

/** Jalur relatif terhadap proyek dengan pemisah `/`, atau undefined bila di luar proyek, terlalu panjang, atau tidak bisa dipastikan. */
function relativeToProject(path: string | undefined, cwd: string | undefined): string | undefined {
  if (path === undefined || cwd === undefined || cwd === "" || path.includes("\0") || path.length > MAX_PATH_LENGTH) return undefined;
  const rel = relative(resolve(cwd), resolve(cwd, path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

function targetOf(input: PolicyInput): Target {
  const tool = toolOf(input);
  const toolInput = typeof input.toolInput === "object" && input.toolInput !== null && !Array.isArray(input.toolInput) ? (input.toolInput as Record<string, unknown>) : undefined;
  if (SHELL_TOOLS.has(tool)) {
    const command = toolInput?.command;
    if (typeof command !== "string" || command.trim() === "") return { parts: [], analyzable: false };
    const parts: Part[] = [];
    const ok = shellParts(command, tool === "powershell" ? "powershell" : "bash", 0, parts);
    return { parts, analyzable: ok && parts.length > 0 };
  }
  if (WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    // Kunci jalur dipilih oleh fungsi yang SAMA dengan penilai risiko, supaya keduanya selalu membicarakan berkas yang sama.
    const raw = toolInput ? filePathOf(toolInput) : null;
    const parts: Part[] = [{ kind: "file", path: relativeToProject(raw ?? undefined, input.cwd) }];
    // Alat pencari memuat pola jalur sendiri (Glob.pattern, Grep.glob): pola itu juga diperiksa terhadap aturan jalur.
    // Grep.pattern adalah REGEX isi berkas, bukan jalur: tidak diperlakukan sebagai jalur.
    if (READ_TOOLS.has(tool) && toolInput) {
      for (const key of tool === "grep" ? ["glob"] : ["pattern", "glob"]) {
        const v = toolInput[key];
        if (typeof v === "string" && v !== "" && v.length <= MAX_PATH_LENGTH && !isAbsolute(v) && !v.startsWith("..")) parts.push({ kind: "file", path: v.replace(/\\/g, "/").replace(/^\.\//, "") });
      }
    }
    // Alat tulis wajib punya jalur yang sah; alat baca tanpa jalur memakai folder kerja.
    const analyzable = WRITE_TOOLS.has(tool) ? raw !== null && raw !== undefined : raw !== null;
    return { parts, analyzable };
  }
  // Alat lain (WebFetch, MCP, ...): tidak ada yang bisa dianalisis selain namanya, jadi hanya aturan `tool` polos yang berlaku,
  // dan masukan yang bukan objek atau nama kosong dianggap tidak bisa dianalisis.
  return { parts: [{ kind: "tool" }], analyzable: tool !== "" && toolInput !== undefined };
}

const globCache = new Map<string, { strict: RegExp; loose: RegExp }>();
function globToRegExp(glob: string, loose: boolean): RegExp {
  let cached = globCache.get(glob);
  if (!cached) {
    let source = "";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i]!;
      if (c === "*") {
        if (glob[i + 1] === "*") {
          const slash = glob[i + 2] === "/";
          source += slash ? "(?:.*/)?" : ".*";
          i += slash ? 2 : 1;
        } else source += "[^/]*";
      } else if (c === "?") source += "[^/]";
      else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    cached = { strict: new RegExp(`^${source}$`), loose: new RegExp(`^${source}$`, "i") };
    if (globCache.size > 500) globCache.clear();
    globCache.set(glob, cached);
  }
  return loose ? cached.loose : cached.strict;
}

/** `loose` (aturan tolak/tanya): tanpa membedakan huruf besar kecil dan dengan bentuk-bentuk lain perintah. Aturan izinkan: persis. */
function commandMatches(pattern: string, part: Extract<Part, { kind: "shell" }>, loose: boolean): boolean {
  const want = pattern.trim().split(/\s+/);
  const wildcard = want[want.length - 1] === "*";
  const prefix = (wildcard ? want.slice(0, -1) : want).map((w) => (loose ? w.toLowerCase() : w));
  const candidates = loose ? part.variants : [part.words];
  return candidates.some((words) => (wildcard ? words.length >= prefix.length : words.length === prefix.length) && prefix.every((w, i) => words[i] === w));
}

/** Pencocokan KETAT untuk aturan allow pada perintah shell. "exact" = tepat perintah yang disebut; "wild" = lewat `*` dengan kata biasa. */
function shellAllowMatch(pattern: string, words: readonly string[]): "exact" | "wild" | undefined {
  const want = pattern.trim().split(/\s+/);
  const wildcard = want[want.length - 1] === "*";
  const prefix = wildcard ? want.slice(0, -1) : want;
  if (prefix.length === 0) return undefined; // pola "*" saja = "izinkan semua perintah": tidak ada
  if (words.length < prefix.length || !prefix.every((w, i) => words[i] === w)) return undefined;
  const extras = words.slice(prefix.length);
  if (!wildcard) return extras.length === 0 ? "exact" : undefined;
  if (WILDCARD_FORBIDDEN.has(canonicalName(words[0]!))) return undefined;
  if (!extras.every(isPlain)) return undefined;
  if (canonicalName(words[0]!) === "git" && GIT_CONTENT.has(words[1] ?? "") && extras.some(isRevisionLike)) return undefined;
  // Pola dengan `*` TIDAK pernah dihitung persis, walau tanpa argumen: `yarn *` mengizinkan `yarn` (= yarn install). Risiko sedang butuh pola tanpa `*`.
  return "wild";
}

function allowMatch(rule: Rule, tool: string, part: Part): "exact" | "wild" | undefined {
  if (!toolMatches(rule, tool)) return undefined;
  if (part.kind === "shell") {
    // Perintah shell WAJIB disebut lewat `commands`: tidak ada aturan allow tanpa pola yang berlaku untuk semua perintah.
    if (rule.paths !== undefined || rule.commands === undefined) return undefined;
    let best: "wild" | undefined;
    for (const pattern of rule.commands) {
      const m = shellAllowMatch(pattern, part.words);
      if (m === "exact") return "exact";
      if (m === "wild") best = "wild";
    }
    return best;
  }
  // Pencarian folder membaca isinya secara rekursif: hanya aturan yang menyebut folder (`paths`) yang boleh mengizinkannya.
  if (SEARCH_TOOLS.has(tool) && rule.paths === undefined) return undefined;
  return partMatches(rule, tool, part) ? "exact" : undefined;
}

function toolMatches(rule: Rule, tool: string): boolean {
  return rule.tool === "*" || rule.tool.toLowerCase() === tool;
}

function partMatches(rule: Rule, tool: string, part: Part): boolean {
  if (!toolMatches(rule, tool)) return false;
  const loose = rule.action !== "allow";
  if (part.kind === "shell") return rule.paths === undefined && (rule.commands === undefined || rule.commands.some((p) => commandMatches(p, part, loose)));
  if (part.kind === "file") return rule.commands === undefined && (rule.paths === undefined || (part.path !== undefined && rule.paths.some((g) => globToRegExp(g, loose).test(part.path!))));
  return rule.commands === undefined && rule.paths === undefined;
}

const decision = (action: PolicyResult["action"], why: PolicyWhy, risk: Risk, matched: string[] = []): PolicyDecision => ({ action, ruleId: matched[0] ?? null, why, matched, risk });

/** Boleh di-allow otomatis menurut penilai? Rendah, atau sedang yang HANYA karena menjalankan kode proyek. */
function riskAllowsAuto(risk: Risk): boolean {
  if (risk.level === "low") return true;
  return risk.level === "medium" && risk.reasons.length > 0 && risk.reasons.every((r) => ALLOWABLE_MEDIUM.has(r.code));
}

/**
 * Memutuskan satu permintaan. `load` berasal dari `loadPolicy`. Tidak pernah melempar galat dan tidak pernah menjalankan aksinya.
 */
export function evaluatePolicy(input: PolicyInput, load: PolicyLoad, context: PolicyContext = {}, assessOptions: AssessOptions = {}): PolicyDecision {
  let risk: Risk = { level: "high", reasons: [] };
  try {
    // Tautan simbolik dan junction diselesaikan SECARA BAWAAN: `src/lnk/x` yang menunjuk ke luar proyek bukan lagi "di dalam proyek".
    risk = assessRisk({ toolName: input.toolName, toolInput: input.toolInput, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) }, { realpath: defaultRealpath, ...assessOptions });
    const tool = toolOf(input);
    const target = targetOf(input);

    // Aturan agent tidak pernah dilonggarkan (aturan 6).
    if (context.agentRule === "deny") return decision("deny", "agent-rule", risk, ["agent:deny"]);

    // deny mengalahkan segalanya, lalu ask. Cocok bila SALAH SATU bagian cocok.
    const denied = load.rules.filter((r) => r.action === "deny" && target.parts.some((p) => partMatches(r, tool, p)));
    if (denied.length > 0) return decision("deny", "deny-rule", risk, denied.map((r) => r.id));
    if (context.agentRule === "ask") return decision("ask", "agent-rule", risk, ["agent:ask"]);
    const asked = load.rules.filter((r) => r.action === "ask" && target.parts.some((p) => partMatches(r, tool, p)));
    if (asked.length > 0) return decision("ask", "ask-rule", risk, asked.map((r) => r.id));

    // Batas keras (aturan 1) dan keraguan penilai: sampai sini hanya `allow` yang tersisa.
    if (risk.level === "high") return decision("ask", "risk-high", risk);
    if (!riskAllowsAuto(risk)) return decision("ask", "risk-uncertain", risk);

    const allows = load.rules.filter((r) => r.action === "allow");
    if (allows.length === 0) return decision("ask", "no-allow-rules", risk); // aturan 2
    // Aturan 4. Hanya perintah yang BUKAN baca-saja ditangguhkan (mis. `npm test`, yang menjalankan kode proyek): perintah baca-saja
    // yang dikenali (git status, ls, cat berkas proyek) tidak menjalankan skrip proyek, jadi tidak ada alasan menanyakannya.
    if (context.scriptsChanged === true && SHELL_TOOLS.has(tool) && risk.level !== "low") return decision("ask", "scripts-changed", risk);
    if (!target.analyzable) return decision("ask", "not-analyzable", risk); // aturan 3

    // Setiap bagian harus diizinkan oleh minimal satu aturan allow (aturan 3).
    const used: string[] = [];
    let allExact = true;
    for (const part of target.parts) {
      let found: { rule: Rule; exact: boolean } | undefined;
      for (const r of allows) {
        const m = allowMatch(r, tool, part);
        if (m === "exact") {
          found = { rule: r, exact: true };
          break;
        }
        if (m === "wild" && !found) found = { rule: r, exact: false };
      }
      if (!found) return decision("ask", "unmatched-part", risk);
      if (!found.exact) allExact = false;
      if (!used.includes(found.rule.id)) used.push(found.rule.id);
    }
    // Risiko sedang (menjalankan kode proyek) hanya lewat pola persis: argumen tambahan bisa memuat program atau konfigurasi.
    if (risk.level !== "low" && !allExact) return decision("ask", "risk-uncertain", risk);
    return decision("allow", "allow-rule", risk, used);
  } catch {
    return decision("ask", "error", risk);
  }
}
