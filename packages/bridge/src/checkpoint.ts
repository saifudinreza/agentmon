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
export const DEFAULT_TIMEOUT_MS = 10_000;

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

function git(args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, stdout: String(stdout) });
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      resolve({ ok: false, code: e.code, stderr: String(stderr), timedOut: e.killed === true });
    });
  });
}

const sameDir = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

function compactStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
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
      const top = await git(["rev-parse", "--show-toplevel"], cwd, {}, left());
      if (!top.ok) {
        if (top.code === "ENOENT") {
          noteDisabled(cwd, "git tidak terpasang");
          return { ok: false, reason: "git_missing", message: "git tidak terpasang, jadi checkpoint tidak dibuat" };
        }
        if (top.timedOut) return { ok: false, reason: "timeout", message: "git terlalu lama menjawab" };
        noteDisabled(cwd, "folder ini bukan repo git");
        return { ok: false, reason: "not_git", message: "folder ini bukan repo git, jadi checkpoint tidak dibuat" };
      }
      const root = top.stdout.trim();
      // Repo yang akarnya folder home (mis. dotfiles) memuat seluruh isi home: memotretnya lambat dan menggembungkan .git.
      if (sameDir(root, options.homeDir ?? homedir())) {
        noteDisabled(cwd, "repo git berakar di folder home, terlalu luas untuk dipotret");
        return { ok: false, reason: "too_broad", message: "repo git ini berakar di folder home (terlalu luas), jadi checkpoint tidak dibuat" };
      }

      // Salinan index sementara; index asli tidak disentuh.
      tmpDir = mkdtempSync(join(tmpdir(), "agentmon-cp-"));
      const indexCopy = join(tmpDir, "index");
      // --git-path memberi lokasi index yang benar juga untuk worktree; bisa relatif terhadap root.
      const indexPath = await git(["rev-parse", "--git-path", "index"], root, {}, left());
      const realIndex = indexPath.ok ? resolve(root, indexPath.stdout.trim()) : undefined;
      if (realIndex && existsSync(realIndex)) copyFileSync(realIndex, indexCopy);
      const env = { GIT_INDEX_FILE: indexCopy };

      const added = await git(["add", "-A"], root, env, left());
      if (!added.ok) return failure("git add", added);

      const tree = await git(["write-tree"], root, env, left());
      if (!tree.ok) return failure("git write-tree", tree);

      const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], root, {}, left());
      const id = `${compactStamp(now())}-${randomBytes(3).toString("hex")}`;
      const commitArgs = ["-c", "commit.gpgsign=false", "commit-tree", tree.stdout.trim(), ...(head.ok ? ["-p", head.stdout.trim()] : []), "-m", `agentmon checkpoint ${id}`];
      const commit = await git(commitArgs, root, { ...IDENTITY }, left());
      if (!commit.ok) return failure("git commit-tree", commit);

      const ref = `${CHECKPOINT_NAMESPACE}${id}`;
      const stored = await git(["update-ref", ref, commit.stdout.trim()], root, {}, left());
      if (!stored.ok) return failure("git update-ref", stored);

      await prune(root, left());
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
  async function prune(root: string, budget: number): Promise<void> {
    const listed = await git(["for-each-ref", "--format=%(refname)", CHECKPOINT_NAMESPACE], root, {}, budget);
    if (!listed.ok) return;
    const refs = listed.stdout.split("\n").filter((r) => r.startsWith(CHECKPOINT_NAMESPACE)).sort();
    for (const old of refs.slice(0, Math.max(0, refs.length - keep))) {
      await git(["update-ref", "-d", old], root, {}, budget);
    }
  }

  return { create };
}

export type CheckpointService = ReturnType<typeof createCheckpointService>;
