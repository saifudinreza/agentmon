// =====================================================================================
// FILE INI: penilai risiko = "PETUGAS KEAMANAN" yang memberi tiap permintaan izin level rendah, sedang, atau tinggi.
// =====================================================================================
//
// Berbasis aturan, tanpa AI, dan KONSERVATIF (PRD §9, FR-70 sampai FR-74):
//   - Yang dinilai hanya INPUT ALAT yang sebenarnya (perintah, jalur berkas). Penjelasan agent ("ini aman") tidak dibaca.
//   - Yang tidak bisa dinilai (input rusak, kosong, terlalu panjang, alat tidak dikenal, kutip tidak ditutup, nama
//     perintah yang dibentuk saat dijalankan) TIDAK PERNAH rendah. "Ragu berarti tanya."
//   - Rendah hanya untuk dua hal: mengubah berkas biasa di dalam proyek lewat alat berkas, dan perintah baca-saja yang
//     dikenali tanpa menyentuh berkas rahasia atau tempat di luar proyek.
//
// Fungsi ini murni dan tidak pernah melempar galat. Satu-satunya hal yang menyentuh disk adalah `realpath` (opsional,
// diberikan pemanggil) untuk melihat ke mana tautan simbolik menunjuk.
import type { Risk, RiskLevel } from "@agentmon/shared";
import { classifyPath } from "../diff/sensitive";
import { lexShell, type ShellKind, type Stage, type Word } from "./shell";

export type AssessInput = {
  toolName: string;
  toolInput: unknown;
  /** Folder proyek (cwd agent). Tanpa ini, jalur absolut tidak bisa dipastikan berada di dalam proyek. */
  cwd?: string;
};

export type AssessOptions = {
  /** Menyelesaikan tautan simbolik. Mengembalikan undefined bila jalurnya tidak ada. Bawaan: tidak ada (murni). */
  realpath?: (path: string) => string | undefined;
  /** Folder rumah pengguna, untuk menafsirkan `~`. Tanpa ini, `~` dianggap di luar proyek. */
  home?: string;
};

/** Perintah atau input yang lebih panjang dari ini tidak bisa dinilai dengan yakin: paling rendah "sedang". */
export const MAX_ASSESSABLE_LENGTH = 10_000;
/** Lebih panjang dari ini: tidak dibaca seluruhnya, jadi langsung "tinggi". */
export const MAX_SCANNED_LENGTH = 200_000;
const MAX_DEPTH = 3;
const MAX_STAGES = 150;
const MAX_REASONS = 8;

type Finding = { level: RiskLevel; code: string; message: string };
const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

// ---- ALASAN (Bahasa Indonesia, teks tetap: tidak pernah memuat isi dari agent) -----------------------------------------
const MSG = {
  "secret-file": "Menyentuh berkas rahasia atau kredensial (mis. .env, kunci, token).",
  "outside-project": "Menyentuh berkas di luar folder proyek.",
  "unresolved-path": "Lokasi berkas tidak bisa dipastikan berada di dalam proyek.",
  "sensitive-config": "Mengubah berkas yang membuat perintah berjalan sendiri atau mematikan pengawasan (hook git, CI, profil shell, pengaturan agent).",
  "script-config": "Mengubah berkas skrip atau build proyek; perintah 'aman' berikutnya bisa menjalankan kode yang sudah diubah.",
  "mass-delete": "Menghapus banyak berkas sekaligus atau secara rekursif.",
  "delete-file": "Menghapus berkas.",
  "discard-changes": "Membuang perubahan yang belum disimpan atau menulis ulang riwayat git.",
  "git-push": "Mengirim perubahan ke repositori jauh (git push).",
  publish: "Menerbitkan paket atau citra ke layanan luar.",
  "infra-change": "Mengubah infrastruktur atau kontainer di luar proyek.",
  "download-execute": "Mengunduh sesuatu lalu menjalankannya.",
  "pipe-to-interpreter": "Memasukkan keluaran perintah lain ke interpreter untuk dijalankan.",
  "dynamic-eval": "Menjalankan teks yang baru dibentuk saat berjalan sehingga isinya tidak bisa dilihat dulu.",
  "encoded-command": "Perintah disandikan (encoded) sehingga tidak bisa dibaca.",
  "obfuscated-command": "Nama perintah memuat karakter pengganti (wildcard) yang menyamarkan perintah sebenarnya.",
  privilege: "Berjalan dengan hak istimewa (sudo, admin).",
  "system-change": "Mengubah pengaturan sistem atau disk di luar proyek.",
  "recursive-permission": "Mengubah izin atau pemilik berkas secara rekursif.",
  "raw-pattern": "Memuat pola yang dikenal merusak (mis. bom fork atau tulis langsung ke disk).",
  "install-dependency": "Memasang atau mengubah dependency.",
  "fetch-and-run": "Mengunduh paket lalu langsung menjalankannya.",
  "runs-project-code": "Menjalankan kode atau skrip proyek (isinya bisa sudah diubah).",
  "runs-script": "Menjalankan skrip atau program.",
  "inline-code": "Menjalankan kode inline yang tidak bisa dinilai isinya.",
  "nested-command": "Menjalankan perintah di dalam perintah lain.",
  "code-danger": "Kode inline memuat operasi hapus atau eksekusi.",
  network: "Mengakses jaringan.",
  "modifies-files": "Mengubah berkas lewat shell.",
  "writes-file": "Menulis berkas lewat pengalihan (>).",
  symlink: "Membuat tautan simbolik atau pintasan yang bisa menunjuk ke luar proyek.",
  "unknown-command": "Perintah tidak dikenali.",
  "dynamic-command": "Nama perintah dibentuk dari variabel atau substitusi sehingga tidak bisa dilihat dulu.",
  "dynamic-argument": "Argumen berisi variabel atau substitusi yang nilainya tidak diketahui.",
  wildcard: "Memakai wildcard yang bisa mencakup berkas rahasia.",
  "recursive-search": "Pencarian rekursif bisa membaca berkas rahasia di dalam folder.",
  "git-config-override": "Menimpa pengaturan git lewat perintah (bisa menjalankan perintah lain).",
  "git-modify": "Mengubah repositori git.",
  "kill-process": "Menghentikan proses.",
  unparseable: "Perintah tidak bisa diurai dengan yakin (kutip atau kurung tidak seimbang).",
  "too-long": "Terlalu panjang untuk dinilai dengan yakin.",
  "too-complex": "Terlalu rumit untuk dinilai dengan yakin.",
  "invalid-input": "Input alat kosong atau bentuknya tidak dikenali.",
  "unknown-tool": "Alat ini tidak dikenali penilai risiko.",
  "network-tool": "Mengakses jaringan.",
  "read-only": "Perintah baca saja yang dikenali.",
  "edit-in-project": "Mengubah berkas biasa di dalam proyek.",
  "no-side-effect": "Alat tanpa efek samping pada berkas.",
  "assessment-error": "Penilaian gagal; dianggap perlu ditinjau.",
  "env-override": "Menimpa variabel lingkungan yang memengaruhi cara perintah berjalan.",
  "secret-env": "Menampilkan variabel lingkungan yang kemungkinan berisi rahasia.",
  "runs-program-option": "Opsi ini menjalankan program yang disebutkan di argumennya.",
} as const;
type Code = keyof typeof MSG;

class Acc {
  findings: Finding[] = [];
  download = false;
  execute = false;
  add(level: RiskLevel, code: Code): void {
    this.findings.push({ level, code, message: MSG[code] });
  }
  merge(other: Acc): void {
    this.findings.push(...other.findings);
    this.download ||= other.download;
    this.execute ||= other.execute;
  }
  get level(): RiskLevel {
    let top: RiskLevel = "low";
    for (const f of this.findings) if (RANK[f.level] > RANK[top]) top = f.level;
    return top;
  }
}

type Ctx = {
  cwd?: string;
  realpath?: (p: string) => string | undefined;
  home?: string;
  shell: ShellKind;
  cwdUnknown: boolean;
  /** Anggaran kerja per penilaian (jumlah kandidat jalur). Habis berarti terlalu rumit untuk dinilai: tinggi. */
  budget: number;
  /** Anggaran panggilan realpath (menyentuh disk) per penilaian. */
  realBudget: number;
};

// ---- JALUR ------------------------------------------------------------------------------------------------------------

const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults?)$/;
// Nama yang mirip .env: .env, .env.local, .env-prod, .env_backup, .envrc, prod.env. (Bukan env.ts atau environment.ts.)
const envLike = (base: string): boolean => (/^\.env/.test(base) && !ENV_TEMPLATE.test(base)) || /\.env$/.test(base);
// Berkas rahasia selain yang sudah dikenal classifyPath.
const EXTRA_SECRET_NAMES = new Set([".pgpass", ".htpasswd", ".my.cnf", ".boto", ".s3cfg", ".vault-token", ".pypirc", ".terraformrc", "terraform.tfvars"]);
// Berkas yang membuat perintah berjalan sendiri atau mengatur agent: menulisnya sama bahayanya dengan menulis hook.
const EXTRA_CONFIG_NAMES = new Set([".mcp.json", "claude.md", "agents.md", ".gitmodules", ".gitattributes", ".yarnrc", ".yarnrc.yml"]);
const EXTRA_CONFIG_FOLDERS = new Set([".vscode", ".idea", ".husky", ".cursor"]);
const SECRET_SAMPLES = [".env", ".env.local", ".env.production", ".envrc", "id_rsa", "id_ed25519", ".npmrc", ".netrc", ".git-credentials", "credentials"];
const HOME_VARS = /^(\$home|\$\{home\}|\$profile|\$pshome|%userprofile%|%homepath%|%homedrive%|%appdata%|%localappdata%|%temp%|%tmp%|\$env:(userprofile|home|appdata|localappdata|temp|tmp|programfiles|windir|systemroot))/i;
/** Panjang kata yang dianalisis sebagai jalur. Jalur sungguhan tidak melewati ini; yang lebih panjang tidak dibaca. */
const MAX_PATH_TOKEN = 2048;
const MAX_CANDIDATES_PER_WORD = 64;

type Verdict = { secret: boolean; outside: boolean; unresolved: boolean; config: boolean; scriptish: boolean };

/**
 * Menyeragamkan jalur seperti Windows membacanya: titik dan spasi di ujung SETIAP bagian dibuang (".git." = ".git",
 * ".env " = ".env"), dan aliran data NTFS di nama berkas dibuang (".env::$DATA", ".env:aliran"). Dikerjakan tanpa
 * regex yang bisa berulang-ulang di nama panjang.
 */
function cleanName(path: string): string {
  const segments = path.split(/[\\/]/);
  const last = segments.length - 1;
  return segments
    .map((segment, index) => {
      let s = segment;
      if (index === last) {
        const colon = s.indexOf(":");
        if (colon > 0 && !(index === 0 && colon === 1 && /^[A-Za-z]:/.test(s))) s = s.slice(0, colon);
      }
      if (s === "." || s === "..") return s;
      let end = s.length;
      while (end > 0 && (s[end - 1] === "." || s[end - 1] === " ")) end -= 1;
      return end === s.length ? s : s.slice(0, end);
    })
    .join("/");
}

function climbs(path: string): boolean {
  let depth = 0;
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (--depth < 0) return true;
    } else depth += 1;
  }
  return false;
}

// Batas wildcard: pola dengan banyak * bisa membuat pencocokan regex meledak. Lebih dari ini dianggap bisa cocok dengan rahasia.
const MAX_GLOB_WILDCARDS = 8;

function globRegex(pattern: string): RegExp | undefined {
  try {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!;
      if (c === "*") {
        while (pattern[i + 1] === "*") i += 1; // ** sama dengan *
        source += "[^/\\\\]*";
      } else if (c === "?") source += "[^/\\\\]";
      else if (c === "[") {
        const end = pattern.indexOf("]", i + 2);
        if (end < 0) source += "\\[";
        else {
          source += `[${pattern.slice(i + 1, end).replace(/\\/g, "\\\\")}]`;
          i = end;
        }
      } else source += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`, "i");
  } catch {
    return undefined;
  }
}

/** Apakah pola wildcard bisa mencocokkan berkas rahasia? Wildcard polos (hanya * dan ?) tidak dihitung di sini. */
function globHitsSecret(text: string, shell: ShellKind): boolean {
  const last = text.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!/[*?[]/.test(last) || !/[A-Za-z0-9._-]/.test(last)) return false;
  if (last.length > 256) return true; // nama sepanjang ini bukan nama berkas; tidak dicocokkan, dianggap berisiko
  if ((last.match(/[*?[]/g) ?? []).length > MAX_GLOB_WILDCARDS) return true;
  const regex = globRegex(last);
  if (!regex) return true; // pola yang tidak bisa dibaca: ragu berarti tanya
  return SECRET_SAMPLES.some((sample) => (shell === "bash" && sample.startsWith(".") && !last.startsWith(".") && !last.startsWith("[") ? false : regex.test(sample)));
}

function realOf(abs: string, ctx: Ctx): string | undefined {
  if (!ctx.realpath) return undefined;
  let current = abs;
  const rest: string[] = [];
  for (let n = 0; n < 16; n++) {
    if (ctx.realBudget <= 0) return undefined;
    ctx.realBudget -= 1;
    let real: string | undefined;
    try {
      real = ctx.realpath(current);
    } catch {
      real = undefined;
    }
    if (typeof real === "string" && real !== "") return rest.length > 0 ? `${real}/${rest.reverse().join("/")}` : real;
    const cut = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
    if (cut <= 0) return undefined;
    rest.push(current.slice(cut + 1));
    current = current.slice(0, cut);
  }
  return undefined;
}

// Nama pendek 8.3 Windows (GIT~1, PROGRA~1, ENV~1.TXT): bisa menunjuk nama panjang apa pun, jadi tidak bisa dipastikan.
const SHORT_NAME = /^[^~.]{1,8}~\d+(\.[^.]{0,3})?$/;

function judgePath(raw: string, ctx: Ctx, rev = false): Verdict {
  const verdict: Verdict = { secret: false, outside: false, unresolved: false, config: false, scriptish: false };
  const text = raw.trim();
  if (text === "") return verdict;
  if (HOME_VARS.test(text) || /^~(?=[\\/]|$)/.test(text)) {
    if (ctx.home && /^~(?=[\\/]|$)/.test(text)) return judgePath(ctx.home + text.slice(1), ctx, rev);
    verdict.outside = true;
  } else if (/^~[^\\/]/.test(text)) {
    verdict.outside = true; // ~pengguna: folder rumah orang lain
  }
  if (text.includes("$")) verdict.unresolved = true;

  const cleaned = cleanName(text);
  // Bagian jalur yang sama dengan folder proyek tidak diperiksa: folder sementara dan folder rumah di Windows sering
  // bernama pendek (C:\Users\RUNNER~1\...) padahal itu justru lokasi proyek yang sah.
  let checkable = cleaned;
  if (ctx.cwd) {
    const root = cleanName(ctx.cwd).replace(/\/+$/, "").toLowerCase();
    if (root !== "" && cleaned.toLowerCase().startsWith(`${root}/`)) checkable = cleaned.slice(root.length + 1);
  }
  const segments = checkable.split("/");
  // Revisi git (HEAD~1, main~3) tanpa pemisah bukan nama pendek Windows.
  if (!(rev && segments.length === 1) && segments.some((seg, index) => !(index === 0 && /^[A-Za-z]:$/.test(seg)) && SHORT_NAME.test(seg))) verdict.unresolved = true;
  const unc = /^[/]{2}/.test(cleaned);
  const absolute = /^([A-Za-z]:)?\//.test(cleaned) || /^[A-Za-z]:/.test(cleaned);
  let abs = cleaned;
  if (unc) {
    verdict.outside = true; // jalur jaringan: tidak pernah di dalam proyek, dan tidak pernah disentuh realpath (bisa memblokir dan membocorkan)
  } else if (!absolute) {
    if (ctx.cwdUnknown) verdict.outside = true;
    else if (ctx.cwd) abs = `${ctx.cwd.replace(/[\\/]+$/, "")}/${cleaned}`;
    if (climbs(cleaned) && !ctx.cwd) verdict.outside = true;
  } else if (!ctx.cwd) verdict.unresolved = true;

  const apply = (path: string, root: string | undefined) => {
    const reasons = classifyPath(path, root !== undefined ? { projectRoot: root } : {});
    for (const r of reasons) {
      if (r.code === "env_file" || r.code === "private_key" || r.code === "credentials") verdict.secret = true;
      else if (r.code === "outside_project") verdict.outside = true;
      else if (r.code === "git_internals" || r.code === "ci_workflow" || r.code === "agent_config" || r.code === "shell_profile") verdict.config = true;
      else if (r.code === "script_config" || r.code === "container_config") verdict.scriptish = true;
    }
    const parts = path.replace(/\\/g, "/").toLowerCase().split("/");
    const base = parts.at(-1) ?? "";
    const folders = parts.slice(0, -1);
    if (envLike(base) || EXTRA_SECRET_NAMES.has(base) || (base === "config" && folders.at(-1) === ".git")) verdict.secret = true;
    if (EXTRA_CONFIG_NAMES.has(base) || folders.some((f) => EXTRA_CONFIG_FOLDERS.has(f))) verdict.config = true;
  };
  apply(abs, ctx.cwd);
  if (ctx.cwd && ctx.realpath && !unc) {
    const real = realOf(abs, ctx);
    if (real !== undefined && real.replace(/\\/g, "/") !== abs.replace(/\\/g, "/")) {
      const rootReal = /^[/]{2}/.test(ctx.cwd) ? ctx.cwd : (realOf(ctx.cwd, ctx) ?? ctx.cwd);
      apply(real, rootReal);
    }
  }
  return verdict;
}

/** Memperluas {a,b} sederhana (dibatasi) menjadi semua kemungkinan, karena shell melakukannya sebelum perintah berjalan. */
function expandBraces(text: string, limit = 32): string[] {
  let results = [text];
  for (let round = 0; round < 4; round++) {
    const next: string[] = [];
    let changed = false;
    for (const t of results) {
      const open = t.indexOf("{");
      const close = open < 0 ? -1 : t.indexOf("}", open);
      const inner = close < 0 ? "" : t.slice(open + 1, close);
      if (open < 0 || close < 0 || !inner.includes(",") || inner.includes("{")) {
        next.push(t);
        continue;
      }
      changed = true;
      for (const alt of inner.split(",")) {
        next.push(t.slice(0, open) + alt + t.slice(close + 1));
        if (next.length > limit) return next;
      }
    }
    results = next;
    if (!changed) break;
  }
  return results;
}

/** Kandidat jalur dari satu kata: kata itu sendiri (nilai sesungguhnya dan bentuk mentah), hasil ekspansi {a,b}, bagian setelah "=" atau ":" , tanpa @ atau <. */
function candidates(word: Word): string[] {
  const out = new Set<string>();
  // Alamat (https://host/jalur) bukan jalur berkas.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word.text)) return [];
  const add = (text: string) => {
    const isFlag = text.startsWith("-");
    if (!isFlag) {
      out.add(text);
      out.add(text.replace(/^[@<>]+/, ""));
    }
    const eq = text.indexOf("=");
    if (eq >= 0 && eq < text.length - 1) out.add(text.slice(eq + 1).replace(/^[@<>]+/, ""));
    const colon = /^-[A-Za-z]+:(.+)$/.exec(text);
    if (colon) out.add(colon[1]!);
    // HEAD:.env dan host:.env: bagian setelah titik dua juga dinilai sebagai jalur.
    if (!isFlag && text.includes(":")) for (const part of text.split(":")) if (part.length > 1) out.add(part);
    if (!isFlag && /\s/.test(text)) for (const part of text.split(/\s+/)) if (part) out.add(part);
  };
  for (const base of [word.text, ...(word.raw !== undefined ? [word.raw] : [])]) {
    for (const expanded of expandBraces(base)) add(expanded);
    if (out.size > MAX_CANDIDATES_PER_WORD) break;
  }
  out.delete("");
  return [...out].slice(0, MAX_CANDIDATES_PER_WORD);
}

type ScanMode = "read" | "write";

function scanPaths(words: readonly Word[], mode: ScanMode, ctx: Ctx, acc: Acc, options: { rev?: boolean } = {}): void {
  for (const word of words) {
    const text = word.text;
    if (/^\/[A-Za-z?]$/.test(text)) continue; // opsi gaya Windows (/s, /q)
    if (text.length > MAX_PATH_TOKEN) {
      acc.add("medium", "too-long");
      continue;
    }
    for (const candidate of candidates(word)) {
      if ((ctx.budget -= 1) < 0) {
        acc.add("high", "too-complex");
        return;
      }
      if (globHitsSecret(candidate, ctx.shell)) acc.add("high", "secret-file");
      const v = judgePath(candidate, ctx, options.rev === true);
      if (v.secret) acc.add("high", "secret-file");
      if (v.outside) acc.add(mode === "write" ? "high" : "medium", "outside-project");
      else if (v.unresolved) acc.add("medium", "unresolved-path");
      if (mode === "write") {
        if (v.config) acc.add("high", "sensitive-config");
        if (v.scriptish) acc.add("medium", "script-config");
      }
    }
  }
}

// ---- KOSAKATA PERINTAH -----------------------------------------------------------------------------------------------

const set = (...items: string[]): ReadonlySet<string> => new Set(items);

const READ_ONLY = set(
  "ls", "dir", "pwd", "cd", "chdir", "echo", "printf", "cat", "type", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "findstr",
  "tree", "stat", "file", "du", "df", "which", "where", "whoami", "hostname", "date", "uname", "basename", "dirname", "realpath", "readlink",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "true", "false", "test", "[", "sleep", "id", "less", "more", "nl", "column", "fold", "comm", "cal",
  "get-childitem", "gci", "get-content", "gc", "select-string", "sls", "get-location", "gl", "set-location", "sl", "get-item", "gi", "test-path",
  "get-command", "measure-object", "write-output", "write-host", "get-date", "resolve-path", "select-object", "sort-object", "format-table",
  "format-list", "out-string", "get-filehash", "pushd", "popd", "clear", "cls", "history",
);
const NO_FILE_ARGS = set("echo", "printf", "pwd", "date", "whoami", "hostname", "uname", "true", "false", "sleep", "id", "write-output", "write-host", "get-date", "get-location", "gl", "clear", "cls", "cal", "history", "basename", "dirname", "popd");
const LISTERS = set("ls", "dir", "get-childitem", "gci", "tree", "stat", "file", "du", "df", "test-path", "get-item", "gi", "which", "where", "realpath", "readlink", "get-command", "resolve-path", "test", "[", "cd", "chdir", "set-location", "sl", "pushd");
const PATTERN_FIRST = set("grep", "egrep", "fgrep", "rg", "ag", "findstr", "select-string", "sls");
const CD = set("cd", "chdir", "set-location", "sl", "pushd");
const DELETERS = set("rm", "rmdir", "del", "erase", "rd", "remove-item", "ri", "rimraf", "unlink", "shred", "trash", "trash-put");
const MUTATORS = set(
  "cp", "copy", "copy-item", "cpi", "ci", "xcopy", "robocopy", "mv", "move", "move-item", "mi", "ren", "rename", "rename-item", "mkdir", "md", "new-item", "ni",
  "touch", "ln", "mklink", "chmod", "chown", "chgrp", "icacls", "attrib", "tee", "dd", "truncate", "install", "set-content", "add-content", "ac", "out-file", "clear-content",
  "tar", "unzip", "7z", "expand-archive", "patch", "perl-i", "truncate",
);
const SYSTEM = set(
  "su", "runas", "shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer", "format", "diskpart", "fdisk", "parted", "mount", "umount", "reg", "regedit",
  "schtasks", "crontab", "systemctl", "service", "launchctl", "setx", "netsh", "sc", "net", "bcdedit", "cipher", "takeown", "iptables", "ufw", "useradd", "usermod", "passwd",
  "visudo", "insmod", "set-executionpolicy", "defaults",
);
const KILLERS = set("kill", "pkill", "killall", "taskkill", "stop-process");
const SHELLS = set("sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh", "cmd", "powershell", "pwsh");
const LANGS = set("node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "osascript", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "py", "python", "python2", "python3");
const EVALS = set("eval", "source", ".", "iex", "invoke-expression", "invoke-command", "call");
const DOWNLOADERS = set("curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "aria2c", "certutil", "bitsadmin", "start-bitstransfer", "fetch");
const NETWORK = set("ssh", "scp", "sftp", "ftp", "rsync", "nc", "ncat", "netcat", "telnet", "ping", "nslookup", "dig", "test-netconnection", "gh");
const PKG = set(
  "npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "uvx", "pip", "pip3", "pipx", "uv", "poetry", "cargo", "go", "gem", "bundle", "composer", "apt", "apt-get", "brew",
  "choco", "winget", "scoop", "dnf", "yum", "pacman", "apk", "dotnet", "nuget", "conda", "mamba", "twine",
);
const FETCH_AND_RUN = set("npx", "pnpx", "bunx", "uvx", "pipx", "dlx");
const INSTALL_SUBS = set("install", "i", "add", "ci", "update", "upgrade", "up", "remove", "rm", "uninstall", "un", "link", "get", "sync", "global", "restore");
const RUNNERS = set(
  "make", "cmake", "ninja", "gradle", "gradlew", "mvn", "mvnw", "tsc", "vitest", "jest", "mocha", "eslint", "prettier", "pytest", "ruff", "mypy", "rustc", "gcc", "g++", "clang",
  "javac", "java", "tsx", "ts-node", "vite", "webpack", "next", "turbo", "nx",
);
const INFRA = set("docker", "kubectl", "terraform", "helm");
const WRAPPERS = set("sudo", "doas", "pkexec", "env", "nohup", "time", "nice", "ionice", "command", "exec", "builtin", "stdbuf", "timeout", "xargs", "watch", "setsid");
// Pembungkus yang opsinya tidak dikenal: perintah nyata dicari di antara argumennya.
const GENERIC_WRAPPERS = set("busybox", "strace", "ltrace", "chroot", "unshare", "nsenter", "flock", "script", "wsl", "coproc", "parallel", "taskset", "fakeroot", "proot", "setpriv", "firejail", "runuser");
const ALIAS_MAKERS = set("alias", "sal", "set-alias", "new-alias");
const PRIVILEGE = set("sudo", "doas", "pkexec");
const KEYWORDS = set("if", "then", "else", "elif", "fi", "do", "done", "while", "until", "case", "esac", "for", "select", "function", "!", "{", "}");
const LOOP_HEADERS = set("for", "select", "case", "function", "done", "fi", "esac", "}");
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: set("-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U"),
  doas: set("-u", "-C"),
  env: set("-u", "-C", "-S"),
  xargs: set("-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "-i"),
  timeout: set("-s", "-k"),
  nice: set("-n"),
  ionice: set("-c", "-n", "-p"),
  time: set("-f", "-o"),
  watch: set("-n", "-d"),
};

/** Nama perintah yang baku: tanpa jalur, ekstensi, kutip, dan karakter escape (\rm, r^m). */
function canon(text: string): string {
  let t = text;
  const windowsPath = /^[A-Za-z]:\\/.test(t) || t.startsWith("\\\\") || /^\.{1,2}\\/.test(t);
  t = windowsPath ? t.slice(t.lastIndexOf("\\") + 1) : t.replace(/\\/g, "").replace(/^.*\//, "");
  t = t.replace(/\^/g, "").toLowerCase().trim();
  return t.replace(/\.(exe|cmd|bat|com|ps1|sh)$/, "");
}

const isFlag = (w: Word) => w.text.startsWith("-");
const lower = (w: Word) => w.text.toLowerCase();
const positional = (args: readonly Word[]) => args.filter((w) => !isFlag(w));
/** Opsi PowerShell boleh disingkat: -r, -re, -rec ... cocok dengan -Recurse. */
const psFlag = (w: Word, full: string, min = 2) => {
  const t = lower(w).split(":")[0]!; // -Recurse:$true sama dengan -Recurse
  return t.length >= min && t.startsWith("-") && `-${full}`.startsWith(t);
};
const hasShortFlag = (args: readonly Word[], letters: string) => args.some((w) => /^-[A-Za-z]+$/.test(w.text) && [...letters].some((l) => w.text.slice(1).includes(l)));

// ---- PENILAIAN PERINTAH SHELL ----------------------------------------------------------------------------------------

type StageFlags = { piped: boolean; viaXargs: boolean; viaFind: boolean };

// Perintah yang dikenal berisiko: dipakai untuk mencari perintah nyata di balik pembungkus atau argumen yang tidak dikenal.
const RISKY: ReadonlySet<string> = new Set([...DELETERS, ...SHELLS, ...EVALS, ...SYSTEM, ...DOWNLOADERS, ...MUTATORS, ...INFRA, ...PKG, ...LANGS, "git", "find", "xargs", "sudo", "doas", "pkexec"]);
// Variabel lingkungan yang mengubah cara perintah lain berjalan (pager, pemuat pustaka, jalur pencarian, ...).
const DANGEROUS_ENV = /^(.*_PAGER|PAGER|GIT_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|LESSOPEN|LESSCLOSE|PATH|PYTHONPATH|PYTHONSTARTUP|NODE_OPTIONS|NODE_PATH|PROMPT_COMMAND|PS4|EDITOR|VISUAL|SHELLOPTS|BASHOPTS|IFS|RUBYOPT|PERL5OPT|GCONV_PATH)$/i;
const SECRET_VAR = /\$\{?(env:)?[A-Za-z0-9_]*(secret|token|passw|credential|api_?key|private)/i;

const INJECTING_ENV = /^(LD_.*|DYLD_.*|BASH_ENV|ENV|PYTHONSTARTUP|NODE_OPTIONS|PERL5OPT|RUBYOPT|GCONV_PATH|PROMPT_COMMAND)$/i;

function envOverride(assign: Word, withCommand: boolean, ctx: Ctx, acc: Acc, depth: number): void {
  const eq = assign.text.indexOf("=");
  const name = assign.text.slice(0, eq);
  const value = assign.text.slice(eq + 1);
  const dangerous = DANGEROUS_ENV.test(name);
  if (dangerous || withCommand || assign.dynamic) acc.add("medium", "env-override");
  // Variabel pemuat atau skrip awal: nilainya adalah KODE yang dimuat atau dijalankan program berikutnya.
  if (INJECTING_ENV.test(name) && value !== "") acc.add("high", "env-override");
  // Nilai variabel seperti GIT_PAGER atau LESSOPEN DIJALANKAN sebagai perintah oleh program yang membacanya.
  if (dangerous && value !== "") acc.merge(assessCommand(value, ctx.shell, ctx, depth + 1));
}

function assessCommand(command: string, shell: ShellKind, ctx: Ctx, depth: number): Acc {
  const acc = new Acc();
  if (depth > MAX_DEPTH) {
    acc.add("high", "too-complex"); // tidak dinilai sampai ujung: ragu berarti tanya, dan tinggi tidak bisa disetujui otomatis
    return acc;
  }
  if (/:\s*\(\s*\)\s*\{/.test(command) || /\bof=\/dev\/(sd|hd|nvme|disk|mmcblk)/i.test(command) || />\s*\/dev\/(sd|hd|nvme|disk|mmcblk)/i.test(command) || /\\\\\.\\PhysicalDrive/i.test(command)) {
    acc.add("high", "raw-pattern");
  }
  if (/\b(DownloadString|DownloadFile|DownloadData|Net\.WebClient|Start-BitsTransfer)\b/i.test(command)) acc.download = true;
  const lexed = lexShell(command, shell);
  if (lexed.unbalanced) acc.add("medium", "unparseable");
  for (const inner of lexed.substitutions) acc.merge(assessCommand(inner, shell, ctx, depth + 1));
  let stages = 0;
  for (const pipeline of lexed.pipelines) {
    let downloaded = false;
    pipeline.forEach((stage, index) => {
      if (++stages > MAX_STAGES) return;
      const before = acc.download;
      const reads = assessStage(stage, ctx, acc, depth, { piped: index > 0, viaXargs: false, viaFind: false });
      if (reads && index > 0) acc.add("high", downloaded || before || acc.download ? "download-execute" : "pipe-to-interpreter");
      downloaded ||= acc.download;
    });
  }
  if (stages > MAX_STAGES) acc.add("high", "too-complex");
  if (lexed.pipelines.length === 0 && lexed.substitutions.length === 0) acc.add("medium", "unparseable");
  return acc;
}

type FlagValue = { flag: string; value: Word };

/** Membuka pembungkus (sudo, env, timeout, ...): mengembalikan sisa perintah, nilai opsinya, dan penugasan variabel. */
function unwrap(name: string, args: Word[]): { rest: Word[]; values: FlagValue[]; assigns: Word[] } {
  const valueFlags = VALUE_FLAGS[name];
  const values: FlagValue[] = [];
  const assigns: Word[] = [];
  let i = 0;
  let durationSkipped = false;
  while (i < args.length) {
    const w = args[i]!;
    if (isFlag(w)) {
      const value = args[i + 1];
      if (valueFlags?.has(w.text) && value) {
        values.push({ flag: w.text, value });
        i += 2;
      } else i += 1;
    } else if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) {
      assigns.push(w);
      i += 1;
    } else if ((name === "timeout" || name === "nice" || name === "watch" || name === "ionice") && !durationSkipped && /^[\d.]+[smhd]?$/.test(w.text)) {
      durationSkipped = true;
      i += 1;
    } else break;
  }
  return { rest: args.slice(i), values, assigns };
}

/** Mencari perintah berisiko yang dikenal di balik argumen (mis. `wsl rm -rf ~`, `parallel rm`), lalu menilainya. */
function assessTail(args: readonly Word[], ctx: Ctx, acc: Acc, depth: number, f: StageFlags): boolean {
  for (let i = 0; i < Math.min(args.length, 8); i++) {
    const w = args[i]!;
    if (!w.dynamic && RISKY.has(canon(w.text))) return assessStage({ words: args.slice(i), redirects: [] }, ctx, acc, depth, f);
  }
  return false;
}

/** Argumen yang berupa kalimat perintah (vim -c ':!rm -rf ~', man -P 'rm -rf ~', tar --checkpoint-action=exec=...) dinilai sebagai perintah. */
function assessEmbedded(args: readonly Word[], ctx: Ctx, acc: Acc, depth: number): void {
  let checked = 0;
  for (const w of args) {
    if (checked >= 8) return;
    if (!/\s/.test(w.text) && !/^:?!/.test(w.text)) continue;
    checked += 1;
    const afterEquals = w.text.startsWith("-") ? w.text.slice(w.text.lastIndexOf("=") + 1) : w.text;
    acc.merge(assessCommand(afterEquals.replace(/^:?!/, ""), ctx.shell, ctx, depth + 1));
  }
}

/** PowerShell: isi { ... } (ForEach-Object, Invoke-Command, &{...}) adalah perintah yang berjalan, jadi dinilai juga. */
function assessBlocks(stage: Stage, ctx: Ctx, acc: Acc, depth: number): void {
  let rest = stage.words.map((w) => w.text).join(" ");
  if (!rest.includes("{")) return;
  for (let round = 0; round < 5; round++) {
    const blocks = [...rest.matchAll(/\{([^{}]*)\}/g)];
    if (blocks.length === 0) break;
    for (const m of blocks.slice(0, 8)) {
      const inner = m[1]!.trim();
      if (inner !== "") {
        acc.merge(assessCommand(inner, "powershell", ctx, depth + 1));
        acc.add("medium", "nested-command");
      }
    }
    rest = rest.replace(/\{[^{}]*\}/g, " ");
  }
}

/** Mengembalikan true bila perintah ini adalah interpreter yang membaca skrip dari stdin (berbahaya bila disambung dari pipa). */
function assessStage(stage: Stage, ctx: Ctx, acc: Acc, depth: number, flags: StageFlags): boolean {
  let words = stage.words.slice();
  const assigns: Word[] = [];
  for (;;) {
    const w = words[0];
    if (!w) break;
    if (!w.dynamic && KEYWORDS.has(w.text.toLowerCase())) {
      const loop = LOOP_HEADERS.has(w.text.toLowerCase());
      words.shift();
      if (loop) words = [];
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) {
      assigns.push(w);
      words.shift();
      continue;
    }
    break;
  }
  for (const a of assigns) envOverride(a, words.length > 0, ctx, acc, depth);
  assessRedirects(stage, ctx, acc);
  if (words.length === 0) return false;
  if (ctx.shell === "powershell") assessBlocks({ words, redirects: [] }, ctx, acc, depth);

  let viaXargs = flags.viaXargs;
  for (let n = 0; n < 6 && words.length > 0; n++) {
    const w0 = words[0]!;
    const name = canon(w0.text);
    if (!WRAPPERS.has(name) || w0.dynamic) break;
    const rest = words.slice(1);
    // `command -v x` hanya mencari; opsinya harus tepat sesudah `command` (bukan -v di mana saja: `command rm -rf -v x` menghapus).
    if (name === "command") {
      const first = rest.find((w) => w.text !== "-p");
      if (first && (first.text === "-v" || first.text === "-V")) {
        acc.add("low", "read-only");
        return false;
      }
    }
    if (PRIVILEGE.has(name)) acc.add("high", "privilege");
    if (name === "xargs") viaXargs = true;
    const u = unwrap(name, rest);
    for (const a of u.assigns) envOverride(a, true, ctx, acc, depth);
    for (const { flag, value } of u.values) {
      if (name === "env" && flag === "-S") {
        acc.merge(assessCommand(value.text, ctx.shell, ctx, depth + 1));
        acc.add("medium", "nested-command");
      } else scanPaths([value], "write", ctx, acc); // time -o ~/.bashrc, xargs -a .env: nilai opsi adalah jalur
    }
    words = u.rest;
  }
  if (words.length === 0) {
    acc.add("medium", "unknown-command"); // pembungkus tanpa perintah (mis. "env" saja)
    return false;
  }

  const head = words[0]!;
  const name = canon(head.text);
  const args = words.slice(1);
  const f: StageFlags = { ...flags, viaXargs };

  if (head.dynamic) acc.add("medium", "dynamic-command");
  if (head.text !== "[" && head.text !== "[[" && /[*?[]/.test(head.text)) acc.add("high", "obfuscated-command");
  else if (/[{}]/.test(head.text) && head.text.includes(",")) acc.add("medium", "unparseable");

  if (/^\.{1,2}[\\/]/.test(head.text) || (/[\\/]/.test(head.text) && !/^([\\/]|[A-Za-z]:)/.test(head.text))) {
    // Program di dalam proyek (./install.sh, scripts/run.sh): isinya tidak terlihat. Bukan "install" milik coreutils.
    acc.add("medium", "runs-script");
    acc.execute = true;
    scanPaths(args, "read", ctx, acc);
    assessEmbedded(args, ctx, acc, depth);
  } else if (name.startsWith("mkfs") || SYSTEM.has(name)) {
    acc.add("high", "system-change");
    scanPaths(args, "write", ctx, acc);
  } else if (KILLERS.has(name)) {
    acc.add("medium", "kill-process");
  } else if (DELETERS.has(name)) {
    deleteStage(name, args, ctx, acc, f);
  } else if (name === "git") {
    gitStage(args, ctx, acc, f);
  } else if (INFRA.has(name)) {
    infraStage(name, args, acc);
  } else if (PKG.has(name)) {
    pkgStage(name, args, ctx, acc);
  } else if (SHELLS.has(name) || LANGS.has(name) || EVALS.has(name) || /^python[0-9.]*$/.test(name)) {
    return interpreterStage(name, args, stage, ctx, acc, depth, f);
  } else if (ALIAS_MAKERS.has(name)) {
    // Alias atau fungsi baru bisa menyamarkan perintah berbahaya di perintah berikutnya.
    acc.add("medium", "unknown-command");
    if (args.some((w) => w.text.split(/[=\s]+/).some((part) => RISKY.has(canon(part))))) acc.add("high", "obfuscated-command");
  } else if (DOWNLOADERS.has(name) || NETWORK.has(name)) {
    acc.add("medium", "network");
    if (DOWNLOADERS.has(name)) acc.download = true;
    const writes = name === "scp" || name === "rsync" || name === "sftp" || args.some((w) => /^(-o|-O|--output|--remote-name|-outfile|-out-file)/i.test(w.text) || psFlag(w, "outfile", 4));
    scanPaths(args, writes ? "write" : "read", ctx, acc);
    assessEmbedded(args, ctx, acc, depth); // rsync -e 'sh -c ...', ssh -o ProxyCommand=...
  } else if (name === "sed") {
    sedStage(args, ctx, acc);
  } else if (name === "awk" || name === "gawk" || name === "mawk") {
    awkStage(args, ctx, acc);
  } else if (name === "jq") {
    scanPaths(args, "read", ctx, acc);
    acc.add("low", "read-only");
  } else if (MUTATORS.has(name)) {
    mutatorStage(name, args, ctx, acc);
    assessEmbedded(args, ctx, acc, depth);
  } else if (name === "find") {
    findStage(args, ctx, acc, depth, f);
  } else if (READ_ONLY.has(name)) {
    readStage(name, args, ctx, acc);
  } else if (RUNNERS.has(name)) {
    acc.add("medium", "runs-project-code");
    scanPaths(args, "read", ctx, acc);
  } else if (GENERIC_WRAPPERS.has(name)) {
    acc.add("medium", "unknown-command");
    scanPaths(args, "write", ctx, acc);
    assessEmbedded(args, ctx, acc, depth);
    return assessTail(args, ctx, acc, depth, f); // busybox sh, wsl bash: tetap interpreter yang membaca stdin
  } else {
    acc.add("medium", "unknown-command");
    if (/[\\/]/.test(head.text) || head.text.startsWith(".")) acc.execute = true;
    scanPaths(args, "read", ctx, acc);
    assessTail(args, ctx, acc, depth, f);
    assessEmbedded(args, ctx, acc, depth);
  }
  return false;
}

function assessRedirects(stage: Stage, ctx: Ctx, acc: Acc): void {
  for (const r of stage.redirects) {
    if (r.op === "<<" || r.op === "<<<" || !r.target) continue;
    const t = r.target.text;
    if (/^(\/dev\/null|nul|\$null)$/i.test(t)) continue;
    if (r.op === "<") {
      scanPaths([r.target], "read", ctx, acc);
      continue;
    }
    scanPaths([r.target], "write", ctx, acc);
    acc.add("medium", "writes-file");
    if (r.target.dynamic) acc.add("medium", "dynamic-argument");
  }
}

/** Teks yang diberikan ke stdin lewat heredoc (<<EOF) atau herestring (<<<). */
function stdinPayload(stage: Stage): string | undefined {
  if (stage.heredoc !== undefined) return stage.heredoc;
  return stage.redirects.find((r) => r.op === "<<<" && r.target)?.target?.text;
}

/** Kode inline atau skrip dari stdin: tidak dianalisis penuh, tetapi nama berkas rahasia di dalamnya dicari dan pola berbahaya dikenali. */
function scanCode(code: string, ctx: Ctx, acc: Acc, mode: ScanMode = "read"): void {
  if (DANGER_CODE.test(code)) acc.add("high", "code-danger");
  const tokens = code.split(/[^A-Za-z0-9._\-/\\~:]+/).filter((t) => t.length > 1).slice(0, 300);
  scanPaths(tokens.map((text) => ({ text, dynamic: false })), mode, ctx, acc);
}

// ---- PERINTAH PER JENIS ----------------------------------------------------------------------------------------------

function deleteStage(name: string, args: readonly Word[], ctx: Ctx, acc: Acc, f: StageFlags): void {
  const targets = positional(args).filter((w) => !/^\/[A-Za-z?]$/.test(w.text));
  // Opsi rekursif: gugus pendek berisi r/R (rm -rf, rm -fvrdi), --recursive dan singkatannya (--rec), /s (cmd), -Recurse
  // dan singkatannya (PowerShell, boleh dengan :$true).
  const recursive =
    name === "rimraf" ||
    name === "shred" ||
    args.some((w) => /^-[A-Za-z]+$/.test(w.text) && /[rR]/.test(w.text) && (ctx.shell === "bash" || w.text.length <= 4)) ||
    args.some((w) => (w.text.length >= 5 && "--recursive".startsWith(w.text)) || w.text === "--no-preserve-root" || /^\/s$/i.test(w.text) || psFlag(w, "recurse"));
  // Penghapusan dari pipa tanpa target sendiri (Get-ChildItem -Recurse | Remove-Item) menghapus apa pun yang dialirkan.
  const broad = targets.some((w) => w.dynamic || /[*?[]/.test(w.text) || /^(\/|~|\.|\.\.|\\|[A-Za-z]:\\?)$/.test(w.text) || HOME_VARS.test(w.text)) || (f.piped && targets.length === 0);
  if (recursive || broad || f.viaXargs || f.viaFind) acc.add("high", "mass-delete");
  else acc.add("medium", "delete-file");
  scanPaths(args, "write", ctx, acc);
}

function mutatorStage(name: string, args: readonly Word[], ctx: Ctx, acc: Acc): void {
  acc.add("medium", "modifies-files");
  if (name === "ln" || name === "mklink") acc.add("medium", "symlink");
  if (["chmod", "chown", "chgrp", "icacls"].includes(name) && args.some((w) => w.text === "-R" || w.text === "--recursive" || /^\/t$/i.test(w.text) || psFlag(w, "recurse"))) {
    acc.add("high", "recursive-permission");
  }
  if (name === "chmod" && args.some((w) => /^[ugoa]*\+[rwxXst]*x/.test(w.text) || /^0?[0-7]*[1357][0-7]{0,2}$/.test(w.text))) acc.execute = true;
  scanPaths(args, "write", ctx, acc);
}

/** sed tanpa -i, tanpa perintah w/e, dan tanpa -f hanya membaca; selainnya mengubah berkas atau menjalankan perintah. */
function sedStage(args: readonly Word[], ctx: Ctx, acc: Acc): void {
  if (args.some((w) => (/^-[A-Za-z]*i/.test(w.text) && !w.text.startsWith("--")) || w.text.startsWith("--in-place"))) {
    mutatorStage("sed", args, ctx, acc);
    return;
  }
  const scripty = args.some((w) => w.text === "-f" || w.text.startsWith("--file") || /(^|[;{}\n0-9$/!,\s])[wWe](?![A-Za-z0-9_])/.test(w.text) || /\/[gpiImMx0-9]*[we][gpiImMx0-9]*$/.test(w.text));
  scanPaths(args, "read", ctx, acc);
  if (scripty) acc.add("medium", "unknown-command");
  else acc.add("low", "read-only");
}

/** awk yang tidak memanggil system(), getline, atau menulis/menyalurkan keluaran hanya membaca. */
function awkStage(args: readonly Word[], ctx: Ctx, acc: Acc): void {
  const scripty = args.some((w) => w.text === "-f" || /system\s*\(|getline|\|\s*"|"\s*\||\bprintf?\b[^;}]*[>|]|>>/.test(w.text));
  scanPaths(args.filter((w) => !/\s/.test(w.text)), "read", ctx, acc);
  if (scripty) acc.add("medium", "unknown-command");
  else acc.add("low", "read-only");
}

function findStage(args: readonly Word[], ctx: Ctx, acc: Acc, depth: number, f: StageFlags): void {
  const VALUE = set("-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-type", "-newer", "-user", "-group", "-perm", "-size", "-mtime", "-atime", "-ctime", "-mmin", "-maxdepth", "-mindepth");
  const paths: Word[] = [];
  let seenExpression = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const t = lower(w);
    if (t === "-delete") acc.add("high", "mass-delete");
    else if (["-exec", "-execdir", "-ok", "-okdir"].includes(t)) {
      acc.add("medium", "nested-command");
      const inner: Word[] = [];
      for (i += 1; i < args.length; i++) {
        const x = args[i]!.text;
        if (x === ";" || x === "\\;" || x === "+") break;
        inner.push(args[i]!);
      }
      assessStage({ words: inner, redirects: [] }, ctx, acc, depth + 1, { ...f, viaFind: true, piped: false });
    } else if (t.startsWith("-fprint") || t === "-fls") {
      acc.add("medium", "writes-file");
      const target = args[i + 1];
      if (target) scanPaths([target], "write", ctx, acc);
      i += 1;
    } else if (VALUE.has(t)) i += 1;
    else if (isFlag(w) || w.text === "(" || w.text === "!") seenExpression = true;
    else if (!seenExpression) paths.push(w);
  }
  scanPaths(paths, "read", ctx, acc);
  acc.add("low", "read-only");
}

function readStage(name: string, args: readonly Word[], ctx: Ctx, acc: Acc): void {
  let scan = [...args];
  if (PATTERN_FIRST.has(name) && !args.some((w) => ["-e", "-f", "--regexp", "--file"].includes(w.text))) {
    const first = args.findIndex((w) => !isFlag(w));
    if (first >= 0) scan = args.filter((_, i) => i !== first);
  }
  if (name === "sort" && args.some((w) => w.text === "-o" || w.text.startsWith("--output"))) {
    acc.add("medium", "writes-file");
    scanPaths(args, "write", ctx, acc);
    return;
  }
  if (PATTERN_FIRST.has(name)) {
    if (args.some((w) => (/^-[A-Za-z]{1,4}$/.test(w.text) && /[rR]/.test(w.text)) || w.text === "--recursive" || w.text.startsWith("--dereference-recursive"))) acc.add("medium", "recursive-search");
    if (args.some((w) => w.text.startsWith("--pre") || w.text === "--hidden" || w.text === "-uu" || w.text === "-uuu" || w.text === "--no-ignore")) acc.add("medium", "recursive-search");
  }
  if (CD.has(name)) {
    const target = positional(args)[0];
    if (target) {
      const v = judgePath(target.text, ctx);
      if (v.secret) acc.add("high", "secret-file");
      if (target.dynamic || v.outside || v.unresolved || target.text === "-") {
        acc.add("medium", v.outside ? "outside-project" : "unresolved-path");
        ctx.cwdUnknown = true;
      }
    }
    acc.add("low", "read-only");
    return;
  }
  if (NO_FILE_ARGS.has(name)) {
    if (args.some((w) => SECRET_VAR.test(w.text))) acc.add("medium", "secret-env");
  } else {
    scanPaths(scan, "read", ctx, acc);
    if (!LISTERS.has(name)) {
      // Wildcard polos (*, .*) mencakup berkas rahasia; pola seperti src/*.ts tidak.
      if (positional(scan).some((w) => /(^|[\\/])[*?]+$/.test(w.text))) acc.add("medium", "wildcard");
    }
    if (scan.some((w) => w.dynamic)) acc.add("medium", "dynamic-argument");
  }
  acc.add("low", "read-only");
}

const GIT_READ = set(
  "status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "rev-list", "cat-file", "ls-tree", "diff-tree", "grep", "whatchanged",
  "count-objects", "name-rev", "merge-base", "for-each-ref", "show-ref", "version", "help",
);
const GIT_VALUE_FLAGS = set("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env");
// Pengaturan git yang nilainya dijalankan sebagai perintah.
const GIT_RUNS_CONFIG = /^(core\.(pager|sshcommand|editor|fsmonitor|hookspath|askpass|gitproxy)|alias\..+|credential\..*helper|diff\..*\.(command|textconv)|filter\..+|sequence\.editor|gpg\..*program|protocol\.ext\.allow|url\..*)/i;

function gitStage(args: readonly Word[], ctx: Ctx, acc: Acc, f: StageFlags): void {
  let i = 0;
  let overridden = false;
  while (i < args.length && isFlag(args[i]!)) {
    const t = args[i]!.text;
    if (t === "-c" || t.startsWith("--config-env") || t.startsWith("--exec-path")) overridden = true;
    if (t === "-c") {
      const key = (args[i + 1]?.text ?? "").split("=")[0] ?? "";
      if (GIT_RUNS_CONFIG.test(key)) acc.add("high", "runs-program-option");
    }
    if (t === "-C") {
      const dir = args[i + 1];
      if (dir) {
        scanPaths([dir], "read", ctx, acc);
        const v = judgePath(dir.text, ctx);
        if (v.outside || v.unresolved || dir.dynamic) ctx.cwdUnknown = true;
      }
    }
    i += GIT_VALUE_FLAGS.has(t) ? 2 : 1;
  }
  if (overridden) acc.add("medium", "git-config-override");
  const subWord = args[i];
  const rest = args.slice(i + 1);
  const sub = subWord ? lower(subWord) : "";
  const flagTexts = rest.map((w) => w.text);
  const hasFlag = (...names: string[]) => flagTexts.some((t) => names.some((n) => t === n || t.startsWith(`${n}=`)));
  const broad = rest.some((w) => w.text === "." || w.text === ":/" || w.text === "*" || w.text === ":/.");
  scanPathsGit(sub, rest, ctx, acc);
  // Opsi yang menjalankan program yang disebutkan di argumennya (git grep -O, ls-remote --upload-pack, ...).
  const runsProgram = flagTexts.some((t) => t.startsWith("--upload-pack") || t.startsWith("--receive-pack") || t.startsWith("--exec") || t.startsWith("--open-files-in-pager") || (sub === "grep" && /^-[A-Za-z]*O/.test(t)));
  if (runsProgram) acc.add("high", "runs-program-option");

  if (!sub) {
    acc.add("medium", "unknown-command");
  } else if (sub === "push") {
    acc.add("high", "git-push");
  } else if (sub === "reset") {
    acc.add(hasFlag("--hard", "--merge", "--keep") ? "high" : "medium", hasFlag("--hard", "--merge", "--keep") ? "discard-changes" : "git-modify");
  } else if (sub === "clean") {
    acc.add(hasFlag("-n", "--dry-run") && !hasFlag("-f", "--force") ? "medium" : "high", hasFlag("-n", "--dry-run") && !hasFlag("-f", "--force") ? "git-modify" : "discard-changes");
  } else if (["checkout", "restore", "switch"].includes(sub)) {
    if (broad || hasFlag("-f", "--force", "--hard", "-B", "--discard-changes")) acc.add("high", "discard-changes");
    else acc.add("medium", "git-modify");
  } else if (sub === "rm") {
    if (hasShortFlag(rest, "rf") || hasFlag("--recursive") || f.viaXargs || broad) acc.add("high", "mass-delete");
    else acc.add("medium", "delete-file");
  } else if (sub === "stash" && flagTexts.some((t) => t === "drop" || t === "clear")) {
    acc.add("high", "discard-changes");
  } else if (sub === "branch" && flagTexts.some((t) => t === "-D" || t === "--delete" || t === "-d")) {
    acc.add(flagTexts.includes("-d") && !flagTexts.includes("-D") && !hasFlag("--force", "-f") ? "medium" : "high", flagTexts.includes("-d") && !flagTexts.includes("-D") && !hasFlag("--force", "-f") ? "git-modify" : "discard-changes");
  } else if (sub === "worktree" && flagTexts.some((t) => t === "remove" || t === "prune")) {
    acc.add(hasFlag("--force", "-f") ? "high" : "medium", hasFlag("--force", "-f") ? "discard-changes" : "git-modify");
  } else if (["filter-branch", "filter-repo", "replace", "update-ref", "gc", "prune", "reflog"].includes(sub) && (sub !== "reflog" || flagTexts.some((t) => ["expire", "delete"].includes(t))) && (sub !== "gc" || hasFlag("--prune")) && (sub !== "update-ref" || hasFlag("-d"))) {
    acc.add("high", "discard-changes");
  } else if (["clone", "fetch", "pull", "submodule", "ls-remote", "remote", "request-pull"].includes(sub) && !(sub === "remote" && (flagTexts.length === 0 || flagTexts.every((t) => ["-v", "--verbose", "show", "get-url"].includes(t))))) {
    acc.add("medium", "network");
    if (["clone", "fetch", "pull", "submodule"].includes(sub)) acc.download = true; // hasilnya bisa langsung dijalankan (git clone x && ./install.sh)
  } else if (GIT_READ.has(sub)) {
    if (hasFlag("--output", "--ext-diff")) acc.add("medium", "git-modify");
    else if (!overridden && !runsProgram) acc.add("low", "read-only");
  } else if (sub === "branch" && flagTexts.every((t) => ["-a", "-r", "-v", "-vv", "--list", "--show-current", "-l", "--all", "--remotes", "--verbose"].includes(t))) {
    if (!overridden) acc.add("low", "read-only");
    else acc.add("medium", "git-modify");
  } else if (sub === "remote" && flagTexts.every((t) => ["-v", "--verbose", "show", "get-url"].includes(t))) {
    if (!overridden) acc.add("low", "read-only");
  } else if (sub === "tag" && flagTexts.every((t) => ["-l", "--list"].includes(t))) {
    if (!overridden) acc.add("low", "read-only");
  } else if (sub === "stash" && flagTexts.length > 0 && ["list", "show"].includes(flagTexts[0]!)) {
    if (!overridden) acc.add("low", "read-only");
  } else {
    acc.add("medium", "git-modify");
  }
}

function scanPathsGit(sub: string, rest: readonly Word[], ctx: Ctx, acc: Acc): void {
  // Pesan commit bukan jalur.
  const skip = new Set<number>();
  if (sub === "commit" || sub === "tag" || sub === "stash") {
    rest.forEach((w, i) => {
      if (w.text === "-m" || w.text === "--message") skip.add(i + 1);
    });
  }
  // --output=berkas menulis berkas walau subperintahnya hanya membaca.
  const mutating = ["rm", "mv", "checkout", "restore", "clean", "apply", "add"].includes(sub) || rest.some((w) => w.text.startsWith("--output"));
  scanPaths(
    rest.filter((_, i) => !skip.has(i)),
    mutating ? "write" : "read",
    ctx,
    acc,
    { rev: true },
  );
}

function infraStage(name: string, args: readonly Word[], acc: Acc): void {
  const words = positional(args).map((w) => lower(w));
  const sub = words[0] ?? "";
  const second = words[1] ?? "";
  if (name === "docker") {
    if (sub === "push") acc.add("high", "publish");
    else if (["rm", "rmi", "prune", "kill", "stop", "down"].includes(sub) || (["system", "volume", "network", "container", "image"].includes(sub) && ["rm", "prune", "rmi"].includes(second)) || (sub === "compose" && args.some((w) => w.text === "-v"))) acc.add("high", "infra-change");
    else if (args.some((w) => /(^|=)(\/|~|[A-Za-z]:\\?):\S/.test(w.text))) acc.add("high", "infra-change"); // memasang folder akar atau rumah laptop ke kontainer
    else acc.add("medium", "runs-project-code");
  } else if (name === "kubectl") {
    acc.add(["get", "describe", "logs", "version", "config", "explain", "top"].includes(sub) ? "medium" : "high", ["get", "describe", "logs", "version", "config", "explain", "top"].includes(sub) ? "network" : "infra-change");
  } else if (name === "terraform") {
    acc.add(["apply", "destroy", "import", "state", "taint", "untaint", "force-unlock"].includes(sub) ? "high" : "medium", ["apply", "destroy", "import", "state", "taint", "untaint", "force-unlock"].includes(sub) ? "infra-change" : "runs-project-code");
  } else {
    acc.add(["install", "upgrade", "uninstall", "rollback", "delete"].includes(sub) ? "high" : "medium", ["install", "upgrade", "uninstall", "rollback", "delete"].includes(sub) ? "infra-change" : "network");
  }
}

function pkgStage(name: string, args: readonly Word[], ctx: Ctx, acc: Acc): void {
  const pos = positional(args).map((w) => lower(w));
  const sub = pos[0] ?? "";
  const infoOnly = args.length > 0 && args.every((w) => ["-v", "-V", "--version", "-h", "--help", "version", "help"].includes(w.text));
  if (infoOnly || args.length === 0) {
    acc.add(infoOnly ? "low" : "medium", infoOnly ? "read-only" : "runs-project-code");
    return;
  }
  if (pos.includes("publish") || (name === "gem" && sub === "push") || (name === "twine" && sub === "upload")) acc.add("high", "publish");
  else if (FETCH_AND_RUN.has(name) || sub === "dlx" || sub === "exec" || sub === "x") {
    acc.add("medium", "fetch-and-run");
    acc.download = true;
    // npx rimraf ~, npm exec -- rm -rf ~: perintah yang dijalankan paket dinilai juga.
    assessTail(args, ctx, acc, 0, { piped: false, viaXargs: false, viaFind: false });
  } else if (INSTALL_SUBS.has(sub)) acc.add("medium", "install-dependency");
  else acc.add("medium", "runs-project-code");
  scanPaths(args, "read", ctx, acc);
}

const DANGER_CODE = /rmtree|rmSync|\bunlink\b|os\.remove|os\.system|child_process|subprocess|execSync|spawnSync|Runtime\.getRuntime|shutil\.rmtree|fs\.rm\b|fs\.unlink|\beval\b|\bexec\(|rm\s+-/i;

/** Opsi interpreter yang membaca skrip dari stdin: -s, -, /dev/stdin. */
const readsStdinMarker = (args: readonly Word[]) => args.some((w) => w.text === "-s" || w.text === "-" || w.text.startsWith("/dev/stdin") || w.text.startsWith("/proc/self/fd/0") || w.text === "/dev/fd/0");

function interpreterStage(name: string, args: readonly Word[], stage: Stage, ctx: Ctx, acc: Acc, depth: number, f: StageFlags): boolean {
  acc.execute = true;
  const payload = stdinPayload(stage);
  const pos = positional(args);
  const isShell = SHELLS.has(name);
  const stdinMarker = readsStdinMarker(args);

  if (EVALS.has(name)) {
    if (name === "iex" || name === "invoke-expression") {
      if (args.length === 0 || f.piped) return true; // membaca dari pipa
    }
    if ((name === "source" || name === ".") && stdinMarker) return f.piped;
    if (args.some((w) => w.dynamic) || args.length === 0) {
      acc.add("high", "dynamic-eval");
    } else {
      acc.add("medium", name === "source" || name === "." ? "runs-script" : "nested-command");
      if (name !== "source" && name !== ".") acc.merge(assessCommand(args.map((w) => w.text).join(" "), ctx.shell, ctx, depth + 1));
    }
    scanPaths(args, "read", ctx, acc);
    return false;
  }

  // Teks dari heredoc atau herestring yang diberikan ke interpreter dijalankan oleh interpreter itu.
  const assessPayload = (kind: ShellKind | "code") => {
    if (payload === undefined) return;
    acc.add("medium", "nested-command");
    if (kind === "code") scanCode(payload, ctx, acc);
    else acc.merge(assessCommand(payload, kind, ctx, depth + 1));
  };

  // powershell / pwsh
  if (name === "powershell" || name === "pwsh") {
    const enc = args.findIndex((w) => psFlag(w, "encodedcommand", 2) || lower(w) === "-e" || lower(w) === "-ec");
    if (enc >= 0) {
      acc.add("high", "encoded-command");
      return false;
    }
    const cmd = args.findIndex((w) => psFlag(w, "command", 2) || lower(w) === "-c");
    if (cmd >= 0) {
      const body = args.slice(cmd + 1);
      if (body.length === 1 && body[0]!.text === "-") {
        // -Command - : skrip dibaca dari stdin
        acc.add("medium", "runs-script");
        assessPayload("powershell");
        return f.piped;
      }
      if (body.some((w) => w.dynamic) && body.length === 1) acc.add("high", "dynamic-eval");
      acc.add("medium", "nested-command");
      acc.merge(assessCommand(body.map((w) => w.text).join(" "), "powershell", ctx, depth + 1));
      return false;
    }
    if (args.some((w) => psFlag(w, "file", 2))) {
      acc.add("medium", "runs-script");
      return false;
    }
    acc.add("medium", "runs-script");
    assessPayload("powershell");
    return f.piped && (pos.length === 0 || args.some((w) => w.text === "-"));
  }

  if (name === "cmd") {
    const c = args.findIndex((w) => /^\/[ckr]$/i.test(w.text));
    if (c >= 0) {
      const body = args.slice(c + 1);
      acc.add("medium", "nested-command");
      acc.merge(assessCommand(body.map((w) => w.text).join(" "), "powershell", ctx, depth + 1));
      return false;
    }
    acc.add("medium", "runs-script");
    assessPayload("powershell");
    return f.piped && pos.length === 0;
  }

  if (isShell) {
    const c = args.findIndex((w) => /^-[A-Za-z]*c$/.test(w.text) && !w.text.startsWith("--"));
    if (c >= 0) {
      const body = args[c + 1];
      acc.add("medium", "nested-command");
      // xargs sh -c '{}' atau "$@": yang dijalankan adalah keluaran perintah sebelumnya.
      if (f.viaXargs && (!body || /\{\}|\$@|\$\*|\$1/.test(body.text))) acc.add("high", "pipe-to-interpreter");
      if (body) {
        if (body.dynamic) acc.add("high", "dynamic-eval");
        acc.merge(assessCommand(body.text, "bash", ctx, depth + 1));
      }
      return false;
    }
    if (pos.length > 0 && !stdinMarker) {
      acc.add("medium", "runs-script");
      scanPaths(pos, "read", ctx, acc);
      return false;
    }
    acc.add("medium", "runs-script");
    assessPayload("bash");
    return f.piped; // tanpa skrip: membaca perintah dari stdin
  }

  // python, node, perl, ruby, php, ...
  if (args.length > 0 && args.every((w) => ["--version", "-v", "-V", "--help", "-h", "-version"].includes(w.text))) {
    acc.add("low", "read-only");
    return false;
  }
  const inline = args.findIndex((w) => ["-c", "-e", "--eval", "-p", "--print", "-E", "-r"].includes(w.text));
  if (inline >= 0) {
    acc.add("medium", "inline-code");
    // perl -pi -e ... berkas dan ruby -i mengubah berkasnya di tempat.
    const inPlace = args.some((w) => /^-[A-Za-z]*i/.test(w.text) && !w.text.startsWith("--"));
    scanCode(args.slice(inline + 1).map((w) => w.text).join(" "), ctx, acc, inPlace ? "write" : "read");
    return false;
  }
  // mshta https://..., regsvr32 /i:https://...: mengunduh lalu menjalankan.
  if (args.some((w) => /:\/\//.test(w.text))) acc.download = true;
  if (pos.length > 0 && !stdinMarker) {
    acc.add("medium", "runs-script");
    scanPaths(pos, "read", ctx, acc);
    return false;
  }
  acc.add("medium", "runs-script");
  assessPayload("code");
  return f.piped;
}

// ---- ALAT ------------------------------------------------------------------------------------------------------------

const FILE_WRITE_TOOLS = set("write", "edit", "multiedit", "notebookedit");
const FILE_READ_TOOLS = set("read", "glob", "grep", "ls", "notebookread");

/**
 * Jalur berkas dari input alat berkas. `undefined` = tidak ada; `null` = tidak sah. Alat berkas yang sah hanya memakai SATU
 * kunci jalur (file_path, notebook_path, atau path). Dua kunci yang berbeda nilainya membuat penilai dan pembaca lain bisa
 * memilih kunci yang berbeda, jadi dianggap tidak sah (tidak pernah dinilai rendah).
 */
export function filePathOf(input: Record<string, unknown>): string | undefined | null {
  const found = new Set<string>();
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim() === "") return null;
    found.add(v);
  }
  if (found.size > 1) return null;
  return found.values().next().value;
}
const pathOf = filePathOf;

function assessFileTool(write: boolean, requiresPath: boolean, input: Record<string, unknown>, ctx: Ctx, acc: Acc): void {
  const path = pathOf(input);
  if (path === null || (path === undefined && requiresPath)) {
    acc.add("medium", "invalid-input");
    return;
  }
  if (path === undefined) {
    acc.add("low", "read-only"); // Glob/Grep/LS tanpa path = folder kerja
    return;
  }
  if (path.length > MAX_ASSESSABLE_LENGTH) {
    acc.add("medium", "too-long");
    return;
  }
  const v = judgePath(path, ctx);
  if (v.secret || globHitsSecret(path, ctx.shell)) acc.add("high", "secret-file");
  if (v.outside) acc.add(write ? "high" : "medium", "outside-project");
  else if (v.unresolved) acc.add("medium", "unresolved-path");
  if (write) {
    if (v.config) acc.add("high", "sensitive-config");
    if (v.scriptish) acc.add("medium", "script-config");
    acc.add("low", "edit-in-project");
  } else acc.add("low", "read-only");
}

function assess(input: AssessInput, options: AssessOptions): Acc {
  const acc = new Acc();
  const ctx: Ctx = { shell: "bash", cwdUnknown: false, budget: 4000, realBudget: 8, ...(input.cwd !== undefined && input.cwd !== "" ? { cwd: input.cwd } : {}), ...(options.realpath ? { realpath: options.realpath } : {}), ...(options.home ? { home: options.home } : {}) };
  const tool = typeof input.toolName === "string" ? input.toolName.trim().toLowerCase() : "";
  const toolInput = typeof input.toolInput === "object" && input.toolInput !== null && !Array.isArray(input.toolInput) ? (input.toolInput as Record<string, unknown>) : undefined;
  if (tool === "") {
    acc.add("medium", "unknown-tool");
    return acc;
  }
  if (!toolInput) {
    acc.add("medium", "invalid-input");
    return acc;
  }

  if (tool === "bash" || tool === "powershell") {
    const command = toolInput.command;
    if (typeof command !== "string" || command.trim() === "") {
      acc.add("medium", "invalid-input");
      return acc;
    }
    ctx.shell = tool === "powershell" ? "powershell" : "bash";
    if (command.length > MAX_SCANNED_LENGTH) {
      acc.add("high", "too-long");
      return acc;
    }
    if (command.length > MAX_ASSESSABLE_LENGTH) acc.add("medium", "too-long");
    acc.merge(assessCommand(command, ctx.shell, ctx, 0));
    if (acc.download && acc.execute) acc.add("high", "download-execute");
    return acc;
  }
  if (FILE_WRITE_TOOLS.has(tool)) {
    assessFileTool(true, true, toolInput, ctx, acc);
    return acc;
  }
  if (FILE_READ_TOOLS.has(tool)) {
    assessFileTool(false, tool === "read" || tool === "notebookread", toolInput, ctx, acc);
    // Pola pencarian juga menyebut jalur: Glob("/etc/**"), Grep(glob: ".env*").
    for (const key of ["pattern", "glob"]) {
      const value = toolInput[key];
      if (typeof value !== "string" || value === "") continue;
      if (value.length > MAX_ASSESSABLE_LENGTH) acc.add("medium", "too-long");
      else if (key === "glob" || tool === "glob") scanPaths([{ text: value, dynamic: false }], "read", ctx, acc);
    }
    return acc;
  }
  if (tool === "webfetch" || tool === "websearch") {
    acc.add("medium", "network-tool");
    return acc;
  }
  if (tool === "todowrite") {
    acc.add("low", "no-side-effect");
    return acc;
  }
  acc.add("medium", "unknown-tool");
  return acc;
}

/**
 * Menilai satu permintaan izin. Tidak pernah melempar galat dan tidak pernah mengembalikan "rendah" untuk input yang
 * tidak bisa dinilai. Hanya `toolName`, `toolInput`, dan `cwd` yang dibaca; penjelasan agent diabaikan.
 */
export function assessRisk(input: AssessInput, options: AssessOptions = {}): Risk {
  let acc: Acc;
  try {
    acc = assess(input, options);
  } catch {
    acc = new Acc();
    acc.add("medium", "assessment-error");
  }
  if (acc.findings.length === 0) acc.add("medium", "unparseable");
  const level = acc.level;
  const seen = new Set<string>();
  const reasons = acc.findings
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => (level === "low" ? f.level === "low" : f.level !== "low"))
    .sort((a, b) => RANK[b.f.level] - RANK[a.f.level] || a.index - b.index)
    .filter(({ f }) => !seen.has(f.code) && !!seen.add(f.code))
    .slice(0, MAX_REASONS)
    .map(({ f }) => ({ code: f.code, message: f.message }));
  return { level, reasons };
}
