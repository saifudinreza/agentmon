// =====================================================================================
// FILE INI: checkpoint = "FOTO KEADAAN PROYEK" sebelum agent mengubah berkas.
// =====================================================================================
//
// Bagaimana foto diambil TANPA mengganggu repo pengguna:
//   1. Index git milik pengguna DISALIN ke berkas sementara, lalu `git add -A` dijalankan terhadap salinan itu
//      (lewat GIT_INDEX_FILE). Index asli, cabang, stash, dan riwayat tidak disentuh. Karena salinan membawa
//      catatan "stat" berkas, repo besar tidak perlu dibaca ulang seluruhnya.
//   2. `git write-tree` mengubah salinan itu jadi pohon berkas, `git commit-tree` membungkusnya jadi commit
//      (induknya HEAD bila ada), dan `git update-ref` menyimpannya di `refs/agentmon/checkpoints/<id>`.
//      Nama itu di luar cabang, tag, dan stash, sehingga `git status`, `git branch`, `git stash list`, dan
//      `git log` (HEAD) pengguna sama persis. (`git log --all` akan menampilkan commit checkpoint.)
//   3. Hanya checkpoint terbaru yang disimpan (bawaan 50); yang lebih lama dihapus, dan HANYA dari namespace itu.
//
// Yang ditangkap: berkas yang dilacak ditambah berkas baru yang belum dilacak. Berkas yang di-ignore
// (.gitignore, misalnya .env) TIDAK ditangkap, jadi tidak ikut dipulihkan oleh rollback (PRD §9).
//
// Prinsip: membuat checkpoint TIDAK PERNAH boleh menghalangi agent. Semua galat (bukan repo git, git tidak
// terpasang, repo rusak, kehabisan waktu) menjadi hasil `ok: false` dengan pesan yang jelas, bukan lemparan.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const CHECKPOINT_NAMESPACE = "refs/agentmon/checkpoints/";
export const DEFAULT_KEEP = 50;
// Batas SELURUH pembuatan satu checkpoint. Checkpoint berjalan di jalur hook PreToolUse (agent menunggu), jadi
// dibuat ketat: lebih baik tidak ada checkpoint daripada agent tertahan lama.
export const DEFAULT_TIMEOUT_MS = 5_000;

export type CheckpointResult =
  | { ok: true; id: string; ref: string; commit: string; durationMs: number }
  | { ok: false; reason: "not_git" | "git_missing" | "too_broad" | "timeout" | "failed"; message: string };

export type CheckpointOptions = {
  /** Berapa checkpoint terbaru yang disimpan. */
  keep?: number;
  /** Batas waktu SELURUH pembuatan satu checkpoint. */
  timeoutMs?: number;
  now?: () => Date;
  /** Folder home pengguna. Repo yang akarnya folder ini terlalu luas untuk dipotret. Bawaan: os.homedir(). */
  homeDir?: string;
  /** Pencatat pesan ke log daemon (tanpa isi berkas). */
  log?: (message: string) => void;
};

type GitOutcome = { ok: true; stdout: string } | { ok: false; code: string | number | undefined; stderr: string; timedOut: boolean };

// Identitas untuk commit checkpoint, supaya tidak bergantung pada user.name/user.email pengguna.
const IDENTITY = { GIT_AUTHOR_NAME: "AgentMon", GIT_AUTHOR_EMAIL: "agentmon@localhost", GIT_COMMITTER_NAME: "AgentMon", GIT_COMMITTER_EMAIL: "agentmon@localhost" };

// Variabel GIT_* yang diwarisi dari lingkungan daemon dibuang (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// GIT_OBJECT_DIRECTORY, dan sejenisnya): bila terbawa, checkpoint bisa ditulis ke repo yang salah. Yang dibiarkan
// hanya GIT_CEILING_DIRECTORIES (batas pencarian repo, dipakai tes).
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.toUpperCase().startsWith("GIT_") && key.toUpperCase() !== "GIT_CEILING_DIRECTORIES") continue;
    env[key] = value;
  }
  return { ...env, ...extra, GIT_TERMINAL_PROMPT: "0" };
}

// Opsi -c yang dipasang pada SETIAP perintah git: tanpa hook milik pengguna (mis. reference-transaction lewat
// core.hooksPath) dan tanpa fsmonitor, supaya checkpoint tidak menjalankan kode dari konfigurasi repo.
function safeConfig(noHooksDir: string): string[] {
  return ["-c", `core.hooksPath=${noHooksDir}`, "-c", "core.fsmonitor=false"];
}

function git(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, input?: string): Promise<GitOutcome> {
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, env: cleanEnv(env), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout: String(stdout) });
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      resolve({ ok: false, code: e.code, stderr: String(stderr), timedOut: e.killed === true });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

const sameDir = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

// Nomor checkpoint: waktu sampai milidetik + penghitung (untuk yang lahir di milidetik yang sama) + acak (untuk
// beberapa daemon di satu repo). Diurutkan leksikal = diurutkan menurut waktu.
let counter = 0;
function nextId(date: Date): string {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  counter = (counter + 1) % 10_000;
  return `${stamp}-${String(counter).padStart(4, "0")}-${randomBytes(2).toString("hex")}`;
}

export function createCheckpointService(options: CheckpointOptions = {}) {
  const keep = Math.max(1, options.keep ?? DEFAULT_KEEP);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  // Alasan penonaktifan dicatat SEKALI per folder, supaya log tidak penuh di tiap aksi.
  const disabledNoted = new Set<string>();
  const noteDisabled = (cwd: string, message: string) => {
    if (disabledNoted.has(cwd)) return;
    disabledNoted.add(cwd);
    log(`checkpoint dinonaktifkan untuk folder ini: ${message}`);
  };

  /** Membuat satu checkpoint untuk repo yang memuat `cwd`. Tidak pernah melempar. */
  async function create(cwd: string): Promise<CheckpointResult> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let tmpDir: string | undefined;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "agentmon-cp-"));
      // Folder hook yang sengaja tidak ada: git tidak menemukan hook apa pun.
      const config = safeConfig(join(tmpDir, "tanpa-hook"));
      const run = (args: string[], at: string, env: Record<string, string> = {}, input?: string) => git([...config, ...args], at, env, left(), input);
      const top = await run(["rev-parse", "--show-toplevel"], cwd);
      if (!top.ok) {
        if (top.code === "ENOENT") {
          noteDisabled(cwd, "git tidak terpasang");
          return { ok: false, reason: "git_missing", message: "git tidak terpasang, jadi checkpoint tidak dibuat" };
        }
        if (top.timedOut) return { ok: false, reason: "timeout", message: "git terlalu lama menjawab" };
        if (/not a git repository/i.test(top.stderr)) {
          noteDisabled(cwd, "folder ini bukan repo git");
          return { ok: false, reason: "not_git", message: "folder ini bukan repo git, jadi checkpoint tidak dibuat" };
        }
        // Alasan lain (mis. kepemilikan folder dianggap tidak aman oleh git): jangan salah menyebutnya "bukan repo".
        return failure("git rev-parse", top);
      }
      const root = top.stdout.trim();
      // Repo yang akarnya folder home (mis. dotfiles) memuat seluruh isi home: memotretnya lambat dan menggembungkan .git.
      if (sameDir(root, options.homeDir ?? homedir())) {
        noteDisabled(cwd, "repo git berakar di folder home, terlalu luas untuk dipotret");
        return { ok: false, reason: "too_broad", message: "repo git ini berakar di folder home (terlalu luas), jadi checkpoint tidak dibuat" };
      }

      // Salinan index sementara; index asli tidak disentuh.
      const indexCopy = join(tmpDir, "index");
      // --git-path memberi lokasi index yang benar juga untuk worktree; bisa relatif terhadap root.
      const indexPath = await run(["rev-parse", "--git-path", "index"], root);
      const realIndex = indexPath.ok ? resolve(root, indexPath.stdout.trim()) : undefined;
      if (realIndex && existsSync(realIndex)) copyFileSync(realIndex, indexCopy);
      const env = { GIT_INDEX_FILE: indexCopy };

      const added = await run(["add", "-A"], root, env);
      if (!added.ok) return failure("git add", added);

      const tree = await run(["write-tree"], root, env);
      if (!tree.ok) return failure("git write-tree", tree);

      const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"], root);
      const id = nextId(now());
      const commitArgs = ["-c", "commit.gpgsign=false", "commit-tree", tree.stdout.trim(), ...(head.ok ? ["-p", head.stdout.trim()] : []), "-m", `agentmon checkpoint ${id}`];
      const commit = await run(commitArgs, root, { ...IDENTITY });
      if (!commit.ok) return failure("git commit-tree", commit);

      const ref = `${CHECKPOINT_NAMESPACE}${id}`;
      const stored = await run(["update-ref", ref, commit.stdout.trim()], root);
      if (!stored.ok) return failure("git update-ref", stored);

      await prune(root, run);
      return { ok: true, id, ref, commit: commit.stdout.trim(), durationMs: Date.now() - started };
    } catch (error) {
      return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  function failure(step: string, outcome: Extract<GitOutcome, { ok: false }>): CheckpointResult {
    if (outcome.timedOut) return { ok: false, reason: "timeout", message: `${step} melewati batas waktu` };
    // Hanya baris pertama pesan git (tanpa isi berkas), dibatasi panjangnya.
    const detail = outcome.stderr.trim().split("\n")[0]?.slice(0, 200) ?? "";
    return { ok: false, reason: "failed", message: `${step} gagal${detail ? `: ${detail}` : ""}` };
  }

  // Menghapus checkpoint lama. Hanya menyentuh ref di bawah refs/agentmon/checkpoints/.
  // Urutan: tanggal commit (yang terlama dulu), lalu nama ref sebagai pemutus seri; nama ref memuat milidetik dan
  // penghitung, jadi tetap menurun benar walau jam sistem mundur sedikit. Semua penghapusan dalam SATU perintah
  // (update-ref --stdin), sehingga memakan anggaran waktu yang sama dengan langkah lain.
  async function prune(root: string, run: (args: string[], at: string, env?: Record<string, string>, input?: string) => Promise<GitOutcome>): Promise<void> {
    const listed = await run(["for-each-ref", "--sort=refname", "--sort=committerdate", "--format=%(refname)", CHECKPOINT_NAMESPACE], root);
    if (!listed.ok) return;
    const refs = listed.stdout.split("\n").filter((r) => r.startsWith(CHECKPOINT_NAMESPACE));
    const old = refs.slice(0, Math.max(0, refs.length - keep));
    if (old.length === 0) return;
    await run(["update-ref", "--stdin"], root, {}, `start\n${old.map((ref) => `delete ${ref}\n`).join("")}prepare\ncommit\n`);
  }

  return { create };
}

export type CheckpointService = ReturnType<typeof createCheckpointService>;
