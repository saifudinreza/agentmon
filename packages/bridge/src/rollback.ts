// =====================================================================================
// FILE INI: rollback = "TOMBOL KEMBALIKAN" ke sebuah checkpoint, dijalankan di laptop atas perintah HP.
// =====================================================================================
//
// Rollback itu DESTRUKTIF (berkas dihapus dan ditimpa), jadi dibuat berlapis supaya tidak ada yang hilang diam-diam:
//   1. Pratinjau: laptop menghitung berkas yang akan berubah (dipulihkan, ditimpa, dihapus) dan memberi sidiknya.
//   2. Penerapan harus membawa sidik pratinjau. Laptop menghitung ulang; bila daftarnya berbeda, ditolak.
//   3. Ditolak bila agent masih berjalan di sesi itu (dicek di awal dan sekali lagi tepat sebelum berkas diubah).
//   4. Keadaan SEKARANG disimpan dulu sebagai checkpoint pengaman. Gagal menyimpannya = tidak ada yang diubah.
//      Membatalkan rollback = rollback ke checkpoint pengaman itu. Keadaan setelah pengaman dibuat harus SAMA dengan
//      yang disimpan; bila ada yang berubah di sela-selanya, rollback ditolak (tidak ada yang tersimpan = tidak dihapus).
//   5. Semua jalur dicek aman SEBELUM berkas pertama disentuh. Berkas yang di-ignore (tidak ada di checkpoint
//      maupun pengaman) TIDAK PERNAH ditimpa atau dihapus: bila ada yang menghalangi, rollback ditolak.
//   6. Hasil akhir diverifikasi (isi harus sama persis dengan checkpoint). Bila gagal di tengah jalan, jalur yang
//      tadi disentuh dipulihkan dari pengaman (hanya jalur itu, supaya berkas yang dibuat pihak lain tidak ikut terhapus).
//
// Yang dipulihkan hanya yang ditangkap checkpoint: berkas yang dilacak dan berkas baru yang belum dilacak. Berkas
// yang di-ignore (.gitignore, mis. .env) tidak disentuh. Index git milik pengguna juga tidak diubah; hanya berkas
// di folder kerja. Efek di luar berkas (git push, jaringan, database) tidak bisa dibatalkan. Repo bersarang dan
// submodule tidak didukung.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
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

const byPath = (a: RollbackFileChange, b: RollbackFileChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

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
  return changes.sort(byPath);
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

// Semua berkas (jalur relatif, pemisah "/") di bawah sebuah folder di disk. Dipakai memeriksa isi folder yang menghalangi.
function filesUnder(root: string, relDir: string, limit = 5000): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    if (out.length > limit) return;
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(relDir);
  return out;
}

/**
 * Mencari jalur di disk yang akan TERTIMPA atau TERHAPUS padahal tidak ada di keadaan yang kita potret (berkas yang
 * di-ignore, atau apa pun yang tidak terlihat git). Kosong = aman. `curPaths` = semua berkas di pohon keadaan sekarang.
 */
export function findConflicts(root: string, curPaths: Set<string>, changes: RollbackFileChange[]): string[] {
  const deleting = new Set(changes.filter((c) => c.change === "delete").map((c) => c.path));
  const conflicts: string[] = [];
  for (const change of changes) {
    if (change.change === "delete") continue;
    const parts = change.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join("/");
      let stat;
      try {
        stat = lstatSync(join(root, rel));
      } catch {
        break; // belum ada: tidak ada yang tertimpa, dan yang di bawahnya pun belum ada
      }
      const isLeaf = i === parts.length;
      if (stat.isDirectory()) {
        // Folder biasa di jalur induk tidak masalah. Folder yang menempati jalur BERKAS yang mau dipulihkan hanya
        // boleh berisi berkas yang memang akan dihapus; selain itu (mis. berkas ter-ignore) akan ikut hilang.
        if (isLeaf) {
          let inside: string[];
          try {
            inside = filesUnder(root, rel);
          } catch {
            inside = [rel];
          }
          if (inside.some((f) => !deleting.has(f))) conflicts.push(rel);
        }
        continue;
      }
      // Berkas (atau tautan) di jalur ini. Aman hanya bila terlihat di keadaan sekarang (jadi masuk pengaman) dan
      // memang bagian dari perubahan (overwrite/delete); selain itu ia tersembunyi dari git dan akan tertimpa.
      if (!curPaths.has(rel) || (isLeaf && change.change === "restore")) conflicts.push(rel);
      break;
    }
  }
  return [...new Set(conflicts)].sort();
}

export function createRollbackService(options: RollbackOptions) {
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROLLBACK_TIMEOUT_MS;
  // Satu rollback pada satu waktu untuk tiap repo.
  const busy = new Set<string>();

  const reply = (ctx: Context, body: Record<string, unknown>) => ({ type: ROLLBACK_RESULT_REPLY, commandId: ctx.commandId, checkpointId: ctx.checkpointId, ...body });
  const refused = (ctx: Context, reason: Refusal, message: string) => reply(ctx, { outcome: "refused", reason, message });

  // Menghitung apa yang akan berubah bila kita kembali ke `target` (SHA commit atau ref): bandingkan pohon target
  // dengan keadaan sekarang.
  async function plan(run: GitRun, tmpDir: string, root: string, target: string): Promise<PlanResult> {
    const exists = await run(["cat-file", "-e", `${target}^{commit}`], root);
    if (!exists.ok) return { ok: false, reason: "checkpoint_missing", message: "Checkpoint ini sudah tidak ada di repo (mungkin sudah dibersihkan). Tidak ada yang diubah." };
    const treeOf = await run(["rev-parse", "--verify", `${target}^{tree}`], root);
    if (!treeOf.ok) return { ok: false, reason: "checkpoint_invalid", message: "Checkpoint ini rusak dan tidak bisa dibaca. Tidak ada yang diubah." };
    const cpTree = treeOf.stdout.trim();
    const snap = await snapshotTree(run, root, tmpDir);
    if (!snap.ok) return { ok: false, reason: "checkpoint_invalid", message: `Keadaan sekarang tidak bisa dibaca (${snap.message}). Tidak ada yang diubah.` };
    const diff = await run(["diff-tree", "-r", "-z", "--name-status", "--no-renames", cpTree, snap.tree], root);
    if (!diff.ok) return { ok: false, reason: "checkpoint_invalid", message: `Checkpoint ini rusak (${describeFailure("git diff-tree", diff)}). Tidak ada yang diubah.` };
    const changes = parseDiffTree(diff.stdout);
    return { ok: true, plan: { cpTree, curTree: snap.tree, changes, hash: hashOf(cpTree, changes) } };
  }

  // Mengecek bahwa rencana tidak menyentuh jalur yang tersembunyi dari git atau tidak aman. Mengembalikan alasan penolakan
  // dan pesannya, atau undefined bila aman.
  async function guard(run: GitRun, root: string, p: Plan): Promise<{ reason: Refusal; message: string } | undefined> {
    if (p.changes.some((c) => !isSafePath(root, c.path))) {
      return { reason: "unsafe_path", message: "Ada jalur berkas yang tidak aman, jadi rollback dibatalkan. Tidak ada yang diubah." };
    }
    const listed = await run(["ls-tree", "-r", "-z", "--name-only", p.curTree], root);
    if (!listed.ok) return { reason: "checkpoint_invalid", message: "Keadaan sekarang tidak bisa dibaca. Tidak ada yang diubah." };
    const conflicts = findConflicts(root, new Set(listed.stdout.split("\0").filter(Boolean)), p.changes);
    if (conflicts.length > 0) {
      const shown = conflicts.slice(0, 5).join(", ");
      return {
        reason: "ignored_conflict",
        message: `Ada berkas yang diabaikan git (atau tersembunyi dari checkpoint) di jalur yang akan ditimpa: ${shown}${conflicts.length > 5 ? ", dan lainnya" : ""}. Rollback dibatalkan supaya berkas itu tidak hilang. Tidak ada yang diubah.`,
      };
    }
    return undefined;
  }

  // Menerapkan rencana: hapus dulu yang bertambah, lalu tulis dari checkpoint yang hilang atau berubah.
  async function perform(run: GitRun, tmpDir: string, root: string, p: Plan, target: string): Promise<{ ok: true } | { ok: false; message: string }> {
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
      const read = await run(["read-tree", target], root, env);
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

  // Urutan di pratinjau: yang paling berbahaya (dihapus) di atas, supaya tidak terpotong dari 200 berkas pertama.
  const PRIORITY = { delete: 0, overwrite: 1, restore: 2 } as const;
  const previewOrder = (a: RollbackFileChange, b: RollbackFileChange) => PRIORITY[a.change] - PRIORITY[b.change] || byPath(a, b);

  async function preview(ctx: Context): Promise<Record<string, unknown>> {
    const found = resolveCheckpoint(ctx);
    if (!found.ok) return found.body;
    const agentRunning = found.sessionId !== undefined && options.isSessionRunning(found.sessionId);
    const result = await withGit(timeoutMs, async (run, tmpDir) => plan(run, tmpDir, found.root, found.ref));
    if (!result.ok) return refused(ctx, result.reason, result.message);
    const { changes, hash } = result.plan;
    const counts = { restore: 0, overwrite: 0, delete: 0 };
    for (const change of changes) counts[change.change]++;
    const ordered = [...changes].sort(previewOrder);
    return reply(ctx, {
      outcome: "preview",
      files: ordered.slice(0, MAX_PREVIEW_FILES),
      total: changes.length,
      counts,
      truncated: changes.length > MAX_PREVIEW_FILES,
      previewHash: hash,
      agentRunning,
    });
  }

  const runningRefusal = (ctx: Context) => refused(ctx, "agent_running", "Agent masih berjalan di sesi ini. Tunggu sampai selesai, lalu coba lagi. Tidak ada yang diubah.");

  async function apply(ctx: Context, previewHash: string): Promise<Record<string, unknown>> {
    const found = resolveCheckpoint(ctx);
    if (!found.ok) return found.body;
    const running = () => found.sessionId !== undefined && options.isSessionRunning(found.sessionId);
    if (running()) return runningRefusal(ctx);
    if (busy.has(found.root)) return refused(ctx, "busy", "Rollback lain sedang berjalan untuk proyek ini. Tidak ada yang diubah.");
    busy.add(found.root);
    try {
      return await withGit(timeoutMs, async (run, tmpDir) => {
        // 1. Kunci target ke SHA commit SEKARANG. Membuat checkpoint pengaman memangkas checkpoint lama, dan itu
        //    tidak boleh menghilangkan target; objeknya tetap ada walau ref-nya terpangkas.
        const resolved = await run(["rev-parse", "--verify", `${found.ref}^{commit}`], found.root);
        if (!resolved.ok) return refused(ctx, "checkpoint_missing", "Checkpoint ini sudah tidak ada di repo (mungkin sudah dibersihkan). Tidak ada yang diubah.");
        const target = resolved.stdout.trim();

        // 2. Hitung dan bandingkan dengan yang disetujui pengguna SEBELUM membuat apa pun (penolakan tidak memakan slot).
        const first = await plan(run, tmpDir, found.root, target);
        if (!first.ok) return refused(ctx, first.reason, first.message);
        if (first.plan.hash !== previewHash) {
          return refused(ctx, "preview_changed", "Isi proyek berubah sejak pratinjau. Lihat pratinjau lagi sebelum melanjutkan. Tidak ada yang diubah.");
        }
        const early = await guard(run, found.root, first.plan);
        if (early) return refused(ctx, early.reason, early.message);
        if (first.plan.changes.length === 0) return reply(ctx, { outcome: "applied", changed: 0 });

        // 3. Simpan keadaan SEKARANG. Gagal = berhenti di sini, belum ada yang disentuh.
        const safety = await options.checkpoints.create(found.root, { ...(found.sessionId ? { sessionId: found.sessionId } : {}), timeoutMs });
        if (!safety.ok) return refused(ctx, "safety_failed", `Keadaan sekarang tidak bisa disimpan dulu (${safety.message}), jadi rollback dibatalkan. Tidak ada yang diubah.`);
        const safetyTree = await run(["rev-parse", "--verify", `${safety.commit}^{tree}`], found.root);

        // 4. Hitung ulang dan pastikan keadaan sama dengan yang baru disimpan. Bila ada yang berubah di sela-sela, yang
        //    berubah itu tidak ada di pengaman: berhenti, jangan menghapusnya.
        const second = await plan(run, tmpDir, found.root, target);
        if (!second.ok) return refused(ctx, second.reason, second.message);
        if (!safetyTree.ok || second.plan.curTree !== safetyTree.stdout.trim() || second.plan.hash !== previewHash) {
          return refused(ctx, "preview_changed", "Isi proyek berubah saat keadaan sekarang disimpan. Lihat pratinjau lagi sebelum melanjutkan. Tidak ada yang diubah.");
        }
        const late = await guard(run, found.root, second.plan);
        if (late) return refused(ctx, late.reason, late.message);
        // Pemeriksaan terakhir tepat sebelum berkas diubah.
        if (running()) return runningRefusal(ctx);

        // 5. Terapkan, lalu verifikasi hasilnya. Gagal di mana pun: pulihkan jalur yang tadi disentuh dari pengaman.
        await options.beforePerform?.();
        const done = await perform(run, tmpDir, found.root, second.plan, target);
        const verified = done.ok && (await verify(found.root, second.plan.cpTree));
        if (!verified) {
          const message = done.ok ? "hasil akhir tidak sama dengan checkpoint" : done.message;
          log(`rollback gagal (${message}); memulihkan jalur yang disentuh`);
          const recovered = await recoverTo(found.root, safety.commit, new Set(second.plan.changes.map((c) => c.path)));
          return reply(ctx, {
            outcome: "failed",
            message: `Rollback gagal di tengah jalan (${message}). ${recovered ? "Berkas yang tadi disentuh sudah dipulihkan otomatis." : `Pemulihan otomatis juga gagal; kembalikan manual dari checkpoint ${safety.id}.`}`,
            recovered,
            safetyCheckpointId: safety.id,
          });
        }
        log(`rollback ke ${ctx.checkpointId} selesai (${second.plan.changes.length} berkas)`);
        options.onRestored?.({ checkpointId: ctx.checkpointId, safetyCheckpointId: safety.id, ...(found.sessionId ? { sessionId: found.sessionId } : {}) });
        return reply(ctx, { outcome: "applied", safetyCheckpointId: safety.id, changed: second.plan.changes.length });
      });
    } catch (error) {
      return reply(ctx, { outcome: "failed", message: `Rollback gagal: ${error instanceof Error ? error.message : String(error)}`, recovered: false });
    } finally {
      busy.delete(found.root);
    }
  }

  // Memulihkan jalur yang disentuh rollback dari commit pengaman. HANYA jalur itu: berkas lain yang muncul sesudah
  // pengaman dibuat (mis. ditulis pihak lain) tidak boleh ikut terhapus. Mengembalikan true bila semuanya pulih.
  async function recoverTo(root: string, safetyCommit: string, only: Set<string>): Promise<boolean> {
    try {
      return await withGit(timeoutMs, async (run, tmpDir) => {
        const result = await plan(run, tmpDir, root, safetyCommit);
        if (!result.ok) return false;
        const changes = result.plan.changes.filter((c) => only.has(c.path));
        const limited: Plan = { ...result.plan, changes };
        if (await guard(run, root, limited)) return false;
        const done = await perform(run, tmpDir, root, limited, safetyCommit);
        if (!done.ok) return false;
        // Terverifikasi hanya untuk jalur yang kita sentuh: sisa selisih (kalau ada) milik pihak lain.
        const after = await plan(run, tmpDir, root, safetyCommit);
        return after.ok && after.plan.changes.every((c) => !only.has(c.path));
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
