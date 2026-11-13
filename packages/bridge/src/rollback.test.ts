import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RollbackResultSchema } from "@agentmon/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCheckpointService, type CheckpointService } from "./checkpoint";
import { createRollbackService, isSafePath, parseDiffTree } from "./rollback";

vi.setConfig({ testTimeout: 60_000 });

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentmon-rbtest-"));
  // Lihat checkpoint.test.ts: folder temp bisa berada di dalam repo milik pengguna.
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
});
afterEach(() => {
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} gagal: ${r.stderr}`);
  return r.stdout;
}
const write = (name: string, content: string) => {
  const full = join(dir, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const exists = (name: string) => {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
};

// Semua berkas di folder kerja (tanpa .git) sebagai peta jalur -> isi, untuk membandingkan keadaan persis.
function snapshotFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(join(dir, path), "utf8");
    }
  };
  walk("");
  return out;
}

function initRepo() {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Penguji"]);
  git(["config", "user.email", "penguji@contoh.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);
  write(".gitignore", "rahasia.env\n");
  write("a.txt", "isi a\n");
  write("b.txt", "isi b\n");
  write("lib/dalam.txt", "di folder\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "awal"]);
}

type Setup = { checkpoints: CheckpointService; service: ReturnType<typeof createRollbackService>; running: { value: boolean }; restored: unknown[] };
function setup(extra: { checkpoints?: Pick<CheckpointService, "create" | "lookup">; keep?: number; isSessionRunning?: () => boolean } = {}): Setup {
  const checkpoints = createCheckpointService({ timeoutMs: 60_000, registryFile: join(dir, "..", `reg-${Date.now()}-${Math.random()}.json`), ...(extra.keep ? { keep: extra.keep } : {}) });
  const running = { value: false };
  const restored: unknown[] = [];
  const service = createRollbackService({
    checkpoints: extra.checkpoints ?? checkpoints,
    isSessionRunning: extra.isSessionRunning ?? (() => running.value),
    onRestored: (info) => restored.push(info),
    timeoutMs: 60_000,
  });
  return { checkpoints, service, running, restored };
}

const previewCmd = (checkpointId: string) => ({ type: "rollback.preview", commandId: COMMAND_ID, checkpointId });
const applyCmd = (checkpointId: string, previewHash: string) => ({ type: "rollback.apply", commandId: COMMAND_ID, checkpointId, previewHash });
type Reply = Record<string, unknown>;
const call = async (s: Setup, body: Record<string, unknown>) => (await s.service.handle(body)) as Reply;
const makeCheckpoint = async (s: Setup) => {
  const r = await s.checkpoints.create(dir, { sessionId: "sesi-1" });
  if (!r.ok) throw new Error(r.message);
  return r.id;
};

// Keadaan "setelah checkpoint": ubah, tambah, dan hapus berkas (termasuk folder).
function messUp() {
  write("a.txt", "isi a DIUBAH agent\n");
  write("baru.txt", "berkas baru dari agent\n");
  write("folder-baru/dalam.txt", "di folder baru\n");
  rmSync(join(dir, "b.txt"));
  rmSync(join(dir, "lib"), { recursive: true });
}

describe("putaran penuh", () => {
  test("ubah, tambah, hapus lalu rollback: isi sama PERSIS dengan saat checkpoint (termasuk berkas yang belum dilacak)", async () => {
    initRepo();
    write("belum-dilacak.txt", "belum di-add\n"); // belum dilacak saat checkpoint
    write("rahasia.env", "KUNCI=1\n"); // di-ignore: tidak disentuh
    const s = setup();
    const before = snapshotFiles();
    const id = await makeCheckpoint(s);
    messUp();

    const preview = await call(s, previewCmd(id));
    expect(preview.outcome).toBe("preview");
    const applied = await call(s, applyCmd(id, preview.previewHash as string));
    expect(applied.outcome).toBe("applied");
    expect(snapshotFiles()).toEqual(before);
    expect(exists("folder-baru")).toBe(false); // folder kosong yang tertinggal dibersihkan
    expect(s.restored).toEqual([{ checkpointId: id, safetyCheckpointId: applied.safetyCheckpointId, sessionId: "sesi-1" }]);
  });

  test("berkas yang di-ignore tidak ikut dipulihkan maupun dihapus", async () => {
    initRepo();
    write("rahasia.env", "KUNCI=awal\n");
    const s = setup();
    const id = await makeCheckpoint(s);
    write("rahasia.env", "KUNCI=diubah\n");
    write("a.txt", "diubah\n");
    const preview = await call(s, previewCmd(id));
    await call(s, applyCmd(id, preview.previewHash as string));
    expect(read("rahasia.env")).toBe("KUNCI=diubah\n");
    expect(read("a.txt")).toBe("isi a\n");
  });

  test("balasan sesuai skema bersama (preview, applied)", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    const preview = await call(s, previewCmd(id));
    expect(RollbackResultSchema.safeParse(preview).success).toBe(true);
    const applied = await call(s, applyCmd(id, preview.previewHash as string));
    expect(RollbackResultSchema.safeParse(applied).success).toBe(true);
  });
});

describe("pratinjau", () => {
  test("menyebut SEMUA berkas yang akan berubah, termasuk pekerjaan setelah checkpoint, dengan jenis yang benar", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    const preview = await call(s, previewCmd(id));
    // Yang paling berbahaya (dihapus) di atas, lalu dikembalikan, lalu dibuat lagi; di dalam kelompok menurut jalur.
    expect(preview.files).toEqual([
      { path: "baru.txt", change: "delete" },
      { path: "folder-baru/dalam.txt", change: "delete" },
      { path: "a.txt", change: "overwrite" },
      { path: "b.txt", change: "restore" },
      { path: "lib/dalam.txt", change: "restore" },
    ]);
    expect(preview.counts).toEqual({ restore: 2, overwrite: 1, delete: 2 });
    expect(preview.total).toBe(5);
    expect(preview.truncated).toBe(false);
    expect(preview.agentRunning).toBe(false);
  });

  test("tanpa perubahan sejak checkpoint: daftar kosong, dan menerapkannya tidak mengubah apa pun", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    const preview = await call(s, previewCmd(id));
    expect(preview).toMatchObject({ outcome: "preview", total: 0, files: [] });
    const applied = await call(s, applyCmd(id, preview.previewHash as string));
    expect(applied).toMatchObject({ outcome: "applied", changed: 0 });
  });

  test("daftar panjang dipotong untuk dikirim, tetapi jumlah sebenarnya tetap dilaporkan", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    for (let i = 0; i < 260; i++) write(`banyak/f${i}.txt`, `${i}\n`);
    const preview = await call(s, previewCmd(id));
    expect(preview.total).toBe(260);
    expect(preview.counts).toEqual({ restore: 0, overwrite: 0, delete: 260 }); // jumlah dari daftar penuh, bukan 200 yang dikirim
    expect((preview.files as unknown[]).length).toBe(200);
    expect(preview.truncated).toBe(true);
  });

  test("menandai agentRunning bila agent masih berjalan (pratinjau tetap diberikan)", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    s.running.value = true;
    expect((await call(s, previewCmd(id))).agentRunning).toBe(true);
  });
});

describe("pembatalan rollback", () => {
  test("rollback lalu batalkan (rollback ke checkpoint pengaman): kembali ke keadaan sebelum rollback", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    write("rahasia-baru.txt", "pekerjaan sesudah checkpoint\n");
    const afterWork = snapshotFiles();

    const preview = await call(s, previewCmd(id));
    const applied = await call(s, applyCmd(id, preview.previewHash as string));
    expect(snapshotFiles()).not.toEqual(afterWork);

    const safetyId = applied.safetyCheckpointId as string;
    const undoPreview = await call(s, previewCmd(safetyId));
    expect(undoPreview.outcome).toBe("preview");
    const undone = await call(s, applyCmd(safetyId, undoPreview.previewHash as string));
    expect(undone.outcome).toBe("applied");
    expect(snapshotFiles()).toEqual(afterWork);
  });
});

describe("penolakan", () => {
  test("agent masih berjalan: ditolak dan tidak ada berkas yang berubah", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    const preview = await call(s, previewCmd(id));
    s.running.value = true;
    const before = snapshotFiles();
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "agent_running" });
    expect(snapshotFiles()).toEqual(before);
    expect(s.restored).toEqual([]);
  });

  test("checkpoint tidak dikenal: ditolak dengan pesan jelas", async () => {
    initRepo();
    const s = setup();
    for (const body of [previewCmd("tidak-ada"), applyCmd("tidak-ada", "x"), previewCmd("../../etc/passwd")]) {
      expect(await call(s, body)).toMatchObject({ outcome: "refused", reason: "not_found" });
    }
  });

  test("checkpoint hilang dari repo (dibersihkan): ditolak, dan tidak ada yang diubah", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    const preview = await call(s, previewCmd(id));
    git(["update-ref", "-d", `refs/agentmon/checkpoints/${id}`]);
    const before = snapshotFiles();
    expect(await call(s, previewCmd(id))).toMatchObject({ outcome: "refused", reason: "checkpoint_missing" });
    expect(await call(s, applyCmd(id, preview.previewHash as string))).toMatchObject({ outcome: "refused", reason: "checkpoint_missing" });
    expect(snapshotFiles()).toEqual(before);
  });

  test("checkpoint rusak (objek pohon hilang): ditolak, dan tidak ada yang diubah", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    // Ref diarahkan ke commit yang pohonnya tidak ada di database objek.
    const missingTree = spawnSync("git", ["hash-object", "-t", "commit", "-w", "--stdin", "--literally"], {
      cwd: dir,
      input: "tree 1111111111111111111111111111111111111111\nauthor A <a@a> 0 +0000\ncommitter A <a@a> 0 +0000\n\nrusak\n",
      encoding: "utf8",
    });
    expect(missingTree.status).toBe(0);
    git(["update-ref", `refs/agentmon/checkpoints/${id}`, missingTree.stdout.trim()]);
    write("a.txt", "diubah\n");
    const before = snapshotFiles();
    const result = await call(s, previewCmd(id));
    expect(result).toMatchObject({ outcome: "refused", reason: "checkpoint_invalid" });
    expect(snapshotFiles()).toEqual(before);
  });

  test("isi proyek berubah sejak pratinjau: ditolak (preview_changed), dan tidak ada berkas yang berubah", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    const preview = await call(s, previewCmd(id));
    write("diam-diam.txt", "muncul setelah pratinjau\n");
    const before = snapshotFiles();
    expect(await call(s, applyCmd(id, preview.previewHash as string))).toMatchObject({ outcome: "refused", reason: "preview_changed" });
    expect(snapshotFiles()).toEqual(before);
  });

  test("sidik asal-asalan ditolak", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    const before = snapshotFiles();
    expect(await call(s, applyCmd(id, "sidik-palsu"))).toMatchObject({ outcome: "refused", reason: "preview_changed" });
    expect(snapshotFiles()).toEqual(before);
  });

  test("keadaan sekarang tidak bisa disimpan dulu: dibatalkan sebelum menyentuh berkas apa pun", async () => {
    initRepo();
    const real = setup();
    const id = await makeCheckpoint(real);
    messUp();
    const preview = await call(real, previewCmd(id));
    const failing = { create: async () => ({ ok: false as const, reason: "failed" as const, message: "disk penuh" }), lookup: real.checkpoints.lookup };
    const s = setup({ checkpoints: failing });
    const before = snapshotFiles();
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "safety_failed" });
    expect(String(result.message)).toContain("disk penuh");
    expect(snapshotFiles()).toEqual(before);
  });

  test("dua rollback bersamaan untuk repo yang sama: yang kedua ditolak (busy)", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    messUp();
    const preview = await call(s, previewCmd(id));
    const [first, second] = await Promise.all([call(s, applyCmd(id, preview.previewHash as string)), call(s, applyCmd(id, preview.previewHash as string))]);
    expect([first.outcome, second.outcome].sort()).toEqual(["applied", "refused"]);
    const refusal = first.outcome === "refused" ? first : second;
    expect(refusal.reason).toBe("busy");
  });

  test("perintah yang bukan rollback atau bentuknya salah: tidak dibalas (undefined)", async () => {
    initRepo();
    const s = setup();
    expect(await s.service.handle({ type: "lain" })).toBeUndefined();
    expect(await s.service.handle({ type: "rollback.preview" })).toBeUndefined();
    expect(await s.service.handle({ type: "rollback.apply", commandId: COMMAND_ID, checkpointId: "x" })).toBeUndefined();
  });
});

describe("gagal di tengah jalan", () => {
  test("hasil akhir tidak sama dengan checkpoint: keadaan sebelumnya dipulihkan otomatis, dan hasilnya failed/recovered", async () => {
    initRepo();
    const s0 = setup();
    const id = await makeCheckpoint(s0);
    messUp();
    const afterWork = snapshotFiles();
    const preview = await call(s0, previewCmd(id));
    // Suntik kegagalan: berkas baru muncul tepat sebelum rollback bekerja. Ia tidak ada di rencana, jadi tidak dihapus,
    // dan verifikasi akhir (keadaan harus sama persis dengan checkpoint) gagal SETELAH berkas diubah.
    const restored: unknown[] = [];
    const service = createRollbackService({
      checkpoints: s0.checkpoints,
      isSessionRunning: () => false,
      onRestored: (info) => restored.push(info),
      timeoutMs: 60_000,
      beforePerform: () => write("penyusup.txt", "muncul tepat sebelum rollback"),
    });
    const result = (await service.handle(applyCmd(id, preview.previewHash as string))) as Reply;
    expect(result).toMatchObject({ outcome: "failed", recovered: true });
    expect(RollbackResultSchema.safeParse(result).success).toBe(true);
    expect(String(result.message)).toContain("dipulihkan otomatis");
    expect(result.safetyCheckpointId).toBeTruthy();
    // Jalur yang disentuh rollback pulih seperti sebelum rollback. Berkas penyusup (ditulis pihak lain) TIDAK ikut
    // terhapus oleh pemulihan: pemulihan hanya menyentuh jalur milik rollback.
    expect(snapshotFiles()).toEqual({ ...afterWork, "penyusup.txt": "muncul tepat sebelum rollback" });
    expect(restored).toEqual([]);
  });
});

describe("berkas yang diabaikan git tidak pernah ditimpa atau dihapus", () => {
  test("(a) berkas yang dulu belum dilacak kini terkena aturan ignore: ditolak, isinya utuh", async () => {
    initRepo();
    write("catatan.log", "isi penting\n"); // belum dilacak saat checkpoint
    const s = setup();
    const id = await makeCheckpoint(s);
    write("catatan.log", "isi penting yang BARU diubah\n");
    write(".gitignore", "rahasia.env\ncatatan.log\n"); // sekarang di-ignore
    const preview = await call(s, previewCmd(id));
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "ignored_conflict" });
    expect(String(result.message)).toContain("catatan.log");
    expect(read("catatan.log")).toBe("isi penting yang BARU diubah\n");
  });

  test("(b) checkpoint menyimpan sebuah BERKAS, sekarang jalur itu folder berisi berkas ter-ignore: ditolak, folder utuh", async () => {
    initRepo();
    write("data", "dulu berkas\n");
    const s = setup();
    const id = await makeCheckpoint(s);
    rmSync(join(dir, "data"));
    write("data/rahasia.env", "KUNCI=penting\n"); // ter-ignore (aturan ada di .gitignore)
    const preview = await call(s, previewCmd(id));
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "ignored_conflict" });
    expect(read("data/rahasia.env")).toBe("KUNCI=penting\n");
  });

  test("(c) berkas ter-ignore menempati jalur FOLDER induk yang mau dibuat lagi: ditolak, berkas utuh", async () => {
    initRepo();
    write("lib/dalam.txt", "isi di folder\n");
    const s = setup();
    const id = await makeCheckpoint(s);
    rmSync(join(dir, "lib"), { recursive: true });
    write("lib", "berkas ter-ignore menggantikan folder\n");
    write(".gitignore", "rahasia.env\nlib\n");
    const preview = await call(s, previewCmd(id));
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "ignored_conflict" });
    expect(read("lib")).toBe("berkas ter-ignore menggantikan folder\n");
  });

  test("berkas ter-ignore yang TIDAK menghalangi dibiarkan, dan rollback tetap jalan", async () => {
    initRepo();
    const s = setup();
    const id = await makeCheckpoint(s);
    write("rahasia.env", "KUNCI=1\n");
    write("a.txt", "diubah\n");
    const preview = await call(s, previewCmd(id));
    expect((await call(s, applyCmd(id, preview.previewHash as string))).outcome).toBe("applied");
    expect(read("rahasia.env")).toBe("KUNCI=1\n");
    expect(read("a.txt")).toBe("isi a\n");
  });
});

describe("celah dan urutan operasi", () => {
  test("berkas muncul di sela pembuatan checkpoint pengaman: ditolak (tidak ada yang tersimpan = tidak boleh dihapus)", async () => {
    initRepo();
    const real = setup();
    const id = await makeCheckpoint(real);
    messUp();
    const preview = await call(real, previewCmd(id));
    const racing = {
      lookup: real.checkpoints.lookup,
      create: async (cwd: string, extra: { sessionId?: string; timeoutMs?: number } = {}) => {
        const result = await real.checkpoints.create(cwd, extra);
        write("muncul-setelah-pengaman.txt", "tidak ada di pengaman\n"); // sesudah pengaman, sebelum hitung ulang
        return result;
      },
    };
    const s = setup({ checkpoints: racing });
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "preview_changed" });
    expect(read("muncul-setelah-pengaman.txt")).toBe("tidak ada di pengaman\n");
    expect(exists("baru.txt")).toBe(true); // tidak ada yang dihapus
  });

  test("isi berkas yang SUDAH ada di daftar berubah di sela pembuatan pengaman (sidik daftar tetap sama): ditolak lewat perbandingan pohon", async () => {
    initRepo();
    const real = setup();
    const id = await makeCheckpoint(real);
    messUp(); // a.txt sudah berbeda dari checkpoint, jadi masuk daftar sebagai 'overwrite'
    const preview = await call(real, previewCmd(id));
    const racing = {
      lookup: real.checkpoints.lookup,
      create: async (cwd: string, extra: { sessionId?: string; timeoutMs?: number } = {}) => {
        const result = await real.checkpoints.create(cwd, extra);
        write("a.txt", "ditulis lagi setelah pengaman dibuat\n"); // jalur sama, isi lain: sidik daftar tidak berubah
        return result;
      },
    };
    const s = setup({ checkpoints: racing });
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "preview_changed" });
    expect(read("a.txt")).toBe("ditulis lagi setelah pengaman dibuat\n");
  });

  test("target tidak ikut terpangkas oleh checkpoint pengaman: rollback ke checkpoint tertua tetap berhasil", async () => {
    initRepo();
    const s = setup({ keep: 2 });
    const oldest = await makeCheckpoint(s);
    write("a.txt", "versi kedua\n");
    await makeCheckpoint(s); // total 2 = batas; pengaman akan memangkas yang tertua
    write("a.txt", "versi ketiga\n");
    const preview = await call(s, previewCmd(oldest));
    const result = await call(s, applyCmd(oldest, preview.previewHash as string));
    expect(result.outcome).toBe("applied");
    expect(read("a.txt")).toBe("isi a\n");
  });

  test("penolakan sebelum pengaman (sidik salah) tidak memakan slot checkpoint", async () => {
    initRepo();
    const s = setup({ keep: 3 });
    const id = await makeCheckpoint(s);
    messUp();
    const before = git(["for-each-ref", "refs/agentmon/checkpoints/"]);
    for (let i = 0; i < 5; i++) await call(s, applyCmd(id, "sidik-salah"));
    expect(git(["for-each-ref", "refs/agentmon/checkpoints/"])).toBe(before);
  });

  test("agent mulai berjalan setelah pemeriksaan awal: diperiksa lagi tepat sebelum berkas diubah, dan ditolak", async () => {
    initRepo();
    let calls = 0;
    const s = setup({ isSessionRunning: () => ++calls > 1 }); // pemeriksaan pertama diam, berikutnya berjalan
    const id = await makeCheckpoint(s);
    messUp();
    const preview = await call(s, previewCmd(id)); // pratinjau memakai pemeriksaan pertama
    const before = snapshotFiles();
    const result = await call(s, applyCmd(id, preview.previewHash as string));
    expect(result).toMatchObject({ outcome: "refused", reason: "agent_running" });
    expect(snapshotFiles()).toEqual(before);
  });
});

describe("fungsi bantu", () => {
  test("parseDiffTree: A -> delete, D -> restore, M/T -> overwrite, terurut menurut jalur", () => {
    expect(parseDiffTree("M\0b.txt\0A\0a.txt\0D\0c d.txt\0T\0e.txt\0")).toEqual([
      { path: "a.txt", change: "delete" },
      { path: "b.txt", change: "overwrite" },
      { path: "c d.txt", change: "restore" },
      { path: "e.txt", change: "overwrite" },
    ]);
  });

  test("isSafePath menolak jalur mutlak, '..', kosong, dan isi .git", () => {
    const root = join(tmpdir(), "proyek");
    for (const good of ["a.txt", "lib/dalam.txt", "a b/c.txt"]) expect(isSafePath(root, good)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../luar.txt", "a/../../luar.txt", ".git/config", "lib/.GIT/x", "a//b", "a\0b"]) expect(isSafePath(root, bad)).toBe(false);
  });
});
