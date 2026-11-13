// =====================================================================================
// FILE INI: rollback = "TOMBOL KEMBALIKAN" ke sebuah checkpoint, dijalankan di laptop atas perintah HP.
// =====================================================================================
//
// Rollback itu DESTRUKTIF (berkas dihapus dan ditimpa), jadi dibuat berlapis supaya tidak ada yang hilang diam-diam:
//   1. Pratinjau: laptop menghitung berkas yang akan berubah (dipulihkan, ditimpa, dihapus) dan memberi sidiknya.
//   2. Penerapan harus membawa sidik pratinjau. Laptop menghitung ulang; bila daftarnya berbeda, ditolak.
//   3. Ditolak bila agent masih berjalan di sesi itu (agent akan menimpa hasil rollback atau berebut berkas).
//   4. Keadaan SEKARANG disimpan dulu sebagai checkpoint pengaman. Gagal menyimpannya = tidak ada yang diubah.
//      Membatalkan rollback = rollback ke checkpoint pengaman itu.
//   5. Semua jalur dicek aman SEBELUM berkas pertama disentuh, dan hasil akhir diverifikasi (keadaan berkas harus
//      sama persis dengan checkpoint). Bila gagal di tengah jalan, keadaan sebelumnya dipulihkan otomatis.
//
// Yang dipulihkan hanya yang ditangkap checkpoint: berkas yang dilacak dan berkas baru yang belum dilacak. Berkas
// yang di-ignore (.gitignore, mis. .env) tidak disentuh. Index git milik pengguna juga tidak diubah; hanya berkas
// di folder kerja. Efek di luar berkas (git push, jaringan, database) tidak bisa dibatalkan.
import { createHash } from "node:crypto";
import { lstatSync, rmSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  ROLLBACK_APPLY_COMMAND,
  ROLLBACK_PREVIEW_COMMAND,
  ROLLBACK_RESULT_REPLY,
  RollbackApplyCommandSchema,
  RollbackPreviewCommandSchema,
  type RollbackFileChange,
  type RollbackResult,
} from "@agentmon/shared";
import { CHECKPOINT_NAMESPACE, describeFailure, snapshotTree, withGit, type CheckpointService, type GitRun } from "./checkpoint";

/** Berapa berkas paling banyak yang dikirim di pratinjau (jumlah sebenarnya tetap dilaporkan). */
export const MAX_PREVIEW_FILES = 200;
export const DEFAULT_ROLLBACK_TIMEOUT_MS = 60_000;

export type RollbackOptions = {
  checkpoints: Pick<CheckpointService, "create" | "lookup">;
  /** Apakah agent masih berjalan di sesi ini? */
  isSessionRunning: (sessionId: string) => boolean;
  /** Dipanggil setelah rollback berhasil (untuk mengirim event `checkpoint.restored`). */
  onRestored?: (info: { checkpointId: string; safetyCheckpointId?: string; sessionId?: string }) => void;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** HANYA UNTUK TES: dipanggil tepat sebelum berkas diubah, untuk menyuntikkan kegagalan di tengah jalan. */
  beforePerform?: () => void | Promise<void>;
};

type Refusal = Extract<RollbackResult, { outcome: "refused" }>["reason"];
type Context = { commandId: string; checkpointId: string };

type Plan = { cpTree: string; curTree: string; changes: RollbackFileChange[]; hash: string };
type PlanResult = { ok: true; plan: Plan } | { ok: false; reason: Refusal; message: string };

// Nomor checkpoint dibuat daemon sendiri, tetapi tetap diperiksa bentuknya sebelum dipakai membentuk nama ref.
const SAFE_ID = /^[0-9A-Za-z._-]{1,200}$/;

/** Mengubah keluaran `git diff-tree -z --name-status` (STATUS\0jalur\0...) menjadi daftar perubahan untuk rollback. */
export function parseDiffTree(output: string): RollbackFileChange[] {
  const tokens = output.split("\0").filter((t) => t !== "");
  const changes: RollbackFileChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i] as string;
    const path = tokens[i + 1] as string;
    // Arah perbandingan: dari checkpoint ke KEADAAN SEKARANG. Ditambah sekarang = rollback menghapusnya, dihapus
    // sekarang = rollback membuatnya lagi, berubah = rollback mengembalikan isinya.
    const change = status.startsWith("A") ? "delete" : status.startsWith("D") ? "restore" : "overwrite";
    changes.push({ path, change });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Jalur dari git relatif terhadap akar repo. Ditolak: mutlak, mengandung "..", atau di dalam .git.
export function isSafePath(root: string, path: string): boolean {
  if (path === "" || isAbsolute(path) || path.includes("\0")) return false;
  const parts = path.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === "" || p.toLowerCase() === ".git")) return false;
  const full = resolve(root, path);
  return full.startsWith(resolve(root) + sep);
}

function hashOf(cpTree: string, changes: RollbackFileChange[]): string {
  return createHash("sha256")
    .update(cpTree)
    .update("\n")
    .update(changes.map((c) => `${c.change}\0${c.path}`).join("\n"))
    .digest("hex");
}

export function createRollbackService(options: RollbackOptions) {
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROLLBACK_TIMEOUT_MS;
  // Satu rollback pada satu waktu untuk tiap repo.
  const busy = new Set<string>();

  const reply = (ctx: Context, body: Record<string, unknown>) => ({ type: ROLLBACK_RESULT_REPLY, commandId: ctx.commandId, checkpointId: ctx.checkpointId, ...body });
  const refused = (ctx: Context, reason: Refusal, message: string) => reply(ctx, { outcome: "refused", reason, message });

  // Menghitung apa yang akan berubah bila kita kembali ke `ref`: bandingkan pohon checkpoint dengan keadaan sekarang.
  async function plan(run: GitRun, tmpDir: string, root: string, ref: string): Promise<PlanResult> {
    const exists = await run(["cat-file", "-e", `${ref}^{commit}`], root);
    if (!exists.ok) return { ok: false, reason: "checkpoint_missing", message: "Checkpoint ini sudah tidak ada di repo (mungkin sudah dibersihkan). Tidak ada yang diubah." };
    const treeOf = await run(["rev-parse", "--verify", `${ref}^{tree}`], root);
    if (!treeOf.ok) return { ok: false, reason: "checkpoint_invalid", message: "Checkpoint ini rusak dan tidak bisa dibaca. Tidak ada yang diubah." };
    const cpTree = treeOf.stdout.trim();
    const snap = await snapshotTree(run, root, tmpDir);
    if (!snap.ok) return { ok: false, reason: "checkpoint_invalid", message: `Keadaan sekarang tidak bisa dibaca (${snap.message}). Tidak ada yang diubah.` };
    const diff = await run(["diff-tree", "-r", "-z", "--name-status", "--no-renames", cpTree, snap.tree], root);
    if (!diff.ok) return { ok: false, reason: "checkpoint_invalid", message: `Checkpoint ini rusak (${describeFailure("git diff-tree", diff)}). Tidak ada yang diubah.` };
    const changes = parseDiffTree(diff.stdout);
    return { ok: true, plan: { cpTree, curTree: snap.tree, changes, hash: hashOf(cpTree, changes) } };
  }

  // Menerapkan rencana: hapus dulu yang bertambah, lalu tulis dari checkpoint yang hilang atau berubah.
  async function perform(run: GitRun, tmpDir: string, root: string, p: Plan): Promise<{ ok: true } | { ok: false; message: string }> {
    for (const change of p.changes) if (!isSafePath(root, change.path)) return { ok: false, message: "ada jalur berkas yang tidak aman" };

    // Hapus dulu (juga membereskan bentrokan berkas lawan folder), lalu bersihkan folder kosong yang tertinggal.
    for (const change of p.changes.filter((c) => c.change === "delete")) {
      const full = resolve(root, change.path);
      try {
        lstatSync(full); // ada? (symlink dihapus sebagai tautan, bukan tujuannya)
        rmSync(full, { recursive: false, force: true });
      } catch {
        // sudah tidak ada: tujuan tercapai
      }
      let dir = dirname(full);
      while (dir.startsWith(resolve(root) + sep)) {
        try {
          rmdirSync(dir);
        } catch {
          break; // tidak kosong atau tidak bisa dihapus
        }
        dir = dirname(dir);
      }
    }

    const restore = p.changes.filter((c) => c.change !== "delete").map((c) => c.path);
    if (restore.length > 0) {
      const env = { GIT_INDEX_FILE: join(tmpDir, "restore-index") };
      const read = await run(["read-tree", p.cpTree], root, env);
      if (!read.ok) return { ok: false, message: describeFailure("git read-tree", read) };
      const out = await run(["checkout-index", "-f", "-z", "--stdin"], root, env, restore.join("\0") + "\0");
      if (!out.ok) return { ok: false, message: describeFailure("git checkout-index", out) };
    }
    return { ok: true };
  }

  // Memastikan keadaan berkas sekarang sama persis dengan pohon target.
  async function verify(root: string, targetTree: string): Promise<boolean> {
    return withGit(timeoutMs, async (run, tmpDir) => {
      const snap = await snapshotTree(run, root, tmpDir);
      return snap.ok && snap.tree === targetTree;
    });
  }

  /** Pemeriksaan awal yang sama untuk pratinjau dan penerapan. */
  function resolveCheckpoint(ctx: Context): { ok: true; root: string; sessionId?: string; ref: string } | { ok: false; body: Record<string, unknown> } {
    const entry = SAFE_ID.test(ctx.checkpointId) ? options.checkpoints.lookup(ctx.checkpointId) : undefined;
    if (!entry) return { ok: false, body: refused(ctx, "not_found", "Checkpoint ini tidak dikenal laptop. Tidak ada yang diubah.") };
    return { ok: true, root: entry.root, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ref: `${CHECKPOINT_NAMESPACE}${ctx.checkpointId}` };
  }

  async function preview(ctx: Context): Promise<Record<string, unknown>> {
    const found = resolveCheckpoint(ctx);
    if (!found.ok) return found.body;
    const agentRunning = found.sessionId !== undefined && options.isSessionRunning(found.sessionId);
    const result = await withGit(timeoutMs, async (run, tmpDir) => plan(run, tmpDir, found.root, found.ref));
    if (!result.ok) return refused(ctx, result.reason, result.message);
    const { changes, hash } = result.plan;
    return reply(ctx, {
      outcome: "preview",
      files: changes.slice(0, MAX_PREVIEW_FILES),
      total: changes.length,
      truncated: changes.length > MAX_PREVIEW_FILES,
      previewHash: hash,
      agentRunning,
    });
  }

  async function apply(ctx: Context, previewHash: string): Promise<Record<string, unknown>> {
    const found = resolveCheckpoint(ctx);
    if (!found.ok) return found.body;
    if (found.sessionId !== undefined && options.isSessionRunning(found.sessionId)) {
      return refused(ctx, "agent_running", "Agent masih berjalan di sesi ini. Tunggu sampai selesai, lalu coba lagi. Tidak ada yang diubah.");
    }
    if (busy.has(found.root)) return refused(ctx, "busy", "Rollback lain sedang berjalan untuk proyek ini. Tidak ada yang diubah.");
    busy.add(found.root);
    try {
      // 1. Simpan keadaan SEKARANG lebih dulu. Gagal = berhenti di sini, belum ada yang disentuh.
      const safety = await options.checkpoints.create(found.root, { ...(found.sessionId ? { sessionId: found.sessionId } : {}), timeoutMs });
      if (!safety.ok) return refused(ctx, "safety_failed", `Keadaan sekarang tidak bisa disimpan dulu (${safety.message}), jadi rollback dibatalkan. Tidak ada yang diubah.`);

      return await withGit(timeoutMs, async (run, tmpDir) => {
        // 2. Hitung ulang dan bandingkan dengan yang disetujui pengguna.
        const result = await plan(run, tmpDir, found.root, found.ref);
        if (!result.ok) return refused(ctx, result.reason, result.message);
        if (result.plan.hash !== previewHash) {
          return refused(ctx, "preview_changed", "Isi proyek berubah sejak pratinjau. Lihat pratinjau lagi sebelum melanjutkan. Tidak ada yang diubah.");
        }
        if (result.plan.changes.some((c) => !isSafePath(found.root, c.path))) {
          return refused(ctx, "unsafe_path", "Ada jalur berkas yang tidak aman, jadi rollback dibatalkan. Tidak ada yang diubah.");
        }
        if (result.plan.changes.length === 0) return reply(ctx, { outcome: "applied", changed: 0 });

        // 3. Terapkan, lalu verifikasi hasilnya. Gagal di mana pun: pulihkan keadaan sebelumnya.
        await options.beforePerform?.();
        const done = await perform(run, tmpDir, found.root, result.plan);
        const verified = done.ok && (await verify(found.root, result.plan.cpTree));
        if (!verified) {
          const message = done.ok ? "hasil akhir tidak sama dengan checkpoint" : done.message;
          log(`rollback gagal (${message}); memulihkan keadaan sebelumnya`);
          const recovered = await recoverTo(found.root, `${CHECKPOINT_NAMESPACE}${safety.id}`);
          return reply(ctx, {
            outcome: "failed",
            message: `Rollback gagal di tengah jalan (${message}). ${recovered ? "Keadaan sebelumnya sudah dipulihkan otomatis." : `Pemulihan otomatis juga gagal; kembalikan manual dari checkpoint ${safety.id}.`}`,
            recovered,
            safetyCheckpointId: safety.id,
          });
        }
        log(`rollback ke ${ctx.checkpointId} selesai (${result.plan.changes.length} berkas)`);
        options.onRestored?.({ checkpointId: ctx.checkpointId, safetyCheckpointId: safety.id, ...(found.sessionId ? { sessionId: found.sessionId } : {}) });
        return reply(ctx, { outcome: "applied", safetyCheckpointId: safety.id, changed: result.plan.changes.length });
      });
    } catch (error) {
      return reply(ctx, { outcome: "failed", message: `Rollback gagal: ${error instanceof Error ? error.message : String(error)}`, recovered: false });
    } finally {
      busy.delete(found.root);
    }
  }

  // Memulihkan ke sebuah ref (dipakai setelah rollback gagal di tengah jalan). Mengembalikan true bila berhasil.
  async function recoverTo(root: string, ref: string): Promise<boolean> {
    try {
      return await withGit(timeoutMs, async (run, tmpDir) => {
        const result = await plan(run, tmpDir, root, ref);
        if (!result.ok) return false;
        const done = await perform(run, tmpDir, root, result.plan);
        return done.ok && (await verify(root, result.plan.cpTree));
      });
    } catch {
      return false;
    }
  }

  /**
   * Menangani satu perintah dari HP. Mengembalikan isi balasan, atau undefined bila perintahnya bukan perintah rollback
   * yang sah (HP tidak mendapat balasan; relay-client mencatatnya).
   */
  async function handle(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (body.type === ROLLBACK_PREVIEW_COMMAND) {
      const parsed = RollbackPreviewCommandSchema.safeParse(body);
      if (!parsed.success) return undefined;
      return preview(parsed.data);
    }
    if (body.type === ROLLBACK_APPLY_COMMAND) {
      const parsed = RollbackApplyCommandSchema.safeParse(body);
      if (!parsed.success) return undefined;
      return apply(parsed.data, parsed.data.previewHash);
    }
    return undefined;
  }

  return { handle };
}

export type RollbackService = ReturnType<typeof createRollbackService>;
