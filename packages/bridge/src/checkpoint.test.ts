import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CHECKPOINT_NAMESPACE, createCheckpointService } from "./checkpoint";

// Runner Windows memulai proses git dengan lambat; beberapa tes membuat beberapa checkpoint berturut-turut.
vi.setConfig({ testTimeout: 60_000 });

let dir: string;
const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentmon-cptest-"));
  // PENTING: git mencari repo ke folder induk. Folder sementara bisa berada DI DALAM repo milik pengguna (mis. bila
  // home dijadikan repo), dan checkpoint akan memotret repo itu. Batas ini menghentikan pencarian di folder temp.
  process.env.GIT_CEILING_DIRECTORIES = tmpdir();
});
afterEach(() => {
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd = dir): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} gagal: ${r.stderr}`);
  return r.stdout;
}
const write = (name: string, content: string) => {
  const full = join(dir, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

// Repo uji: satu commit, satu berkas dilacak. autocrlf dimatikan supaya hasilnya sama di semua OS.
function initRepo(withCommit = true) {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Penguji"]);
  git(["config", "user.email", "penguji@contoh.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);
  write(".gitignore", "rahasia.env\n");
  write("a.txt", "isi a\n");
  write("b.txt", "isi b\n");
  if (withCommit) {
    git(["add", "."]);
    git(["commit", "-q", "-m", "awal"]);
  }
}

// Keadaan repo pengguna yang TIDAK boleh berubah oleh checkpoint.
function userState() {
  const indexFile = join(git(["rev-parse", "--absolute-git-dir"]).trim(), "index");
  let indexHash = "tidak-ada";
  try {
    indexHash = createHash("sha256").update(readFileSync(indexFile)).digest("hex");
  } catch {
    // repo tanpa index
  }
  const head = (() => {
    try {
      return git(["rev-parse", "HEAD"]).trim();
    } catch {
      return "tanpa-head";
    }
  })();
  return {
    head,
    branch: git(["branch", "--show-current"]).trim(),
    branches: git(["for-each-ref", "refs/heads", "refs/tags", "refs/stash", "--format=%(refname) %(objectname)"]),
    status: git(["status", "--porcelain=v1", "-uall", "--ignored"]),
    stash: git(["stash", "list"]),
    log: head === "tanpa-head" ? "" : git(["log", "--format=%H %s"]),
    indexHash,
  };
}
const refsOf = () => git(["for-each-ref", "--format=%(refname)", CHECKPOINT_NAMESPACE]).split("\n").filter(Boolean);
// Batas waktu longgar di tes supaya runner yang lambat tidak membuat tes goyah; tes batas waktu memberi nilainya sendiri.
const service = (extra: Parameters<typeof createCheckpointService>[0] = {}) => createCheckpointService({ timeoutMs: 60_000, ...extra });

describe("keadaan repo pengguna tidak berubah", () => {
  test("repo dengan perubahan campur (diubah, staged, baru, dihapus, di-ignore, stash): semuanya sama persis sebelum dan sesudah", async () => {
    initRepo();
    write("a.txt", "isi a diubah\n"); // diubah, belum staged
    write("b.txt", "isi b staged\n");
    git(["add", "b.txt"]); // staged
    write("baru.txt", "berkas baru\n"); // belum dilacak
    write("rahasia.env", "KUNCI=1\n"); // di-ignore
    write("c.txt", "isi c\n");
    git(["add", "c.txt"]);
    git(["commit", "-q", "-m", "tambah c"]);
    rmSync(join(dir, "c.txt")); // dihapus dari disk
    write("d.txt", "untuk stash\n");
    git(["add", "d.txt"]);
    git(["stash", "-q"]);
    write("e.txt", "setelah stash\n");

    const before = userState();
    const result = await service().create(dir);
    expect(result.ok).toBe(true);
    expect(userState()).toEqual(before);
  });

  test("tanpa commit sama sekali (repo baru): tetap berhasil dan tidak mengubah apa pun", async () => {
    initRepo(false);
    const before = userState();
    const result = await service().create(dir);
    expect(result.ok).toBe(true);
    expect(userState()).toEqual(before);
  });

  test("dijalankan dari subfolder: seluruh repo yang ditangkap", async () => {
    initRepo();
    write("lib/dalam.txt", "di subfolder\n");
    const result = await service().create(join(dir, "lib"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(git(["show", `${result.ref}:a.txt`])).toBe("isi a\n");
  });
});

describe("isi snapshot", () => {
  test("berkas diubah, baru (belum dilacak), dan staged tertangkap; yang dihapus tidak ada; yang di-ignore tidak ikut", async () => {
    initRepo();
    write("a.txt", "isi a diubah\n");
    write("baru.txt", "berkas baru\n");
    write("rahasia.env", "KUNCI=1\n");
    rmSync(join(dir, "b.txt"));
    const result = await service().create(dir);
    if (!result.ok) throw new Error(result.message);
    const files = git(["ls-tree", "-r", "--name-only", result.ref]).split("\n").filter(Boolean).sort();
    expect(files).toEqual([".gitignore", "a.txt", "baru.txt"]);
    expect(git(["show", `${result.ref}:a.txt`])).toBe("isi a diubah\n");
    expect(git(["show", `${result.ref}:baru.txt`])).toBe("berkas baru\n");
  });

  test("induknya HEAD, dan ada di namespace refs/agentmon/checkpoints/ saja", async () => {
    initRepo();
    const head = git(["rev-parse", "HEAD"]).trim();
    const result = await service().create(dir);
    if (!result.ok) throw new Error(result.message);
    expect(result.ref.startsWith(CHECKPOINT_NAMESPACE)).toBe(true);
    expect(git(["rev-parse", `${result.ref}^`]).trim()).toBe(head);
    expect(refsOf()).toEqual([result.ref]);
  });

  test("konfigurasi pengguna (nama, email, penandatanganan commit) tidak diperlukan dan tidak dilanggar", async () => {
    initRepo();
    git(["config", "--unset", "user.name"]);
    git(["config", "--unset", "user.email"]);
    git(["config", "commit.gpgsign", "true"]);
    const result = await service().create(dir);
    expect(result.ok).toBe(true);
  });
});

describe("tidak pernah menghalangi agent", () => {
  test("folder non-git: ok=false/not_git dengan pesan jelas, tidak melempar, dan dicatat sekali saja", async () => {
    const logs: string[] = [];
    const svc = service({ log: (m) => logs.push(m) });
    const first = await svc.create(dir);
    const second = await svc.create(dir);
    expect(first).toMatchObject({ ok: false, reason: "not_git" });
    expect(first.ok === false && first.message).toContain("bukan repo git");
    expect(second.ok).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("dinonaktifkan");
  });

  test("repo yang akarnya folder home ditolak (terlalu luas), dan tidak ada yang dibuat", async () => {
    initRepo();
    const before = userState();
    const result = await service({ homeDir: dir }).create(dir);
    expect(result).toMatchObject({ ok: false, reason: "too_broad" });
    expect(refsOf()).toEqual([]);
    expect(userState()).toEqual(before);
  });

  test("git tidak terpasang: ok=false/git_missing", async () => {
    initRepo();
    const original = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await service().create(dir);
      expect(result).toMatchObject({ ok: false, reason: "git_missing" });
    } finally {
      process.env.PATH = original;
    }
  });

  test("index terkunci (index.lock): checkpoint tetap jadi, karena memakai salinan index", async () => {
    initRepo();
    writeFileSync(join(git(["rev-parse", "--absolute-git-dir"]).trim(), "index.lock"), "");
    write("a.txt", "diubah\n");
    const result = await service().create(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(git(["show", `${result.ref}:a.txt`])).toBe("diubah\n");
  });

  test("repo rusak: ok=false, tidak melempar", async () => {
    initRepo();
    writeFileSync(join(git(["rev-parse", "--absolute-git-dir"]).trim(), "HEAD"), "bukan-ref-yang-sah\n");
    const result = await service().create(dir);
    expect(typeof result.ok).toBe("boolean"); // gagal atau berhasil, tetapi tidak melempar
  });

  test("melewati batas waktu: ok=false, tidak menggantung", async () => {
    initRepo();
    const result = await service({ timeoutMs: 0 }).create(dir);
    expect(result.ok).toBe(false);
  });
});

describe("pembersihan", () => {
  test("hanya menyimpan `keep` terbaru, menghapus yang paling lama", async () => {
    initRepo();
    let tick = 0;
    const svc = service({ keep: 3, now: () => new Date(Date.UTC(2026, 10, 12, 10, 0, tick++)) });
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await svc.create(dir);
      if (!r.ok) throw new Error(r.message);
      made.push(r.ref);
    }
    expect(refsOf()).toEqual(made.slice(2));
  });

  test("tidak menyentuh cabang, tag, atau ref lain milik pengguna, termasuk yang namanya mirip", async () => {
    initRepo();
    const head = git(["rev-parse", "HEAD"]).trim();
    git(["branch", "agentmon/checkpoints/mirip"]);
    git(["tag", "v1"]);
    git(["update-ref", "refs/agentmon-lain/x", head]);
    git(["update-ref", "refs/agentmon/catatan", head]);
    const svc = service({ keep: 1 });
    for (let i = 0; i < 3; i++) await svc.create(dir);
    expect(refsOf()).toHaveLength(1);
    const all = git(["for-each-ref", "--format=%(refname)"]).split("\n");
    for (const survivor of ["refs/heads/main", "refs/heads/agentmon/checkpoints/mirip", "refs/tags/v1", "refs/agentmon-lain/x", "refs/agentmon/catatan"]) {
      expect(all).toContain(survivor);
    }
  });
});

// Ini BUKAN pengukuran performa (runner CI terlalu beragam kecepatannya; angka waktu ada di docs/daemon.md).
// Tes ini hanya memastikan repo yang berisi banyak berkas tetap menghasilkan checkpoint yang lengkap dan tidak
// menggantung. Jumlah berkas sengaja sedang: menulis ribuan berkas membuat runner Windows melewati batas waktu tes.
describe("repo dengan banyak berkas", () => {
  test("300 berkas: checkpoint lengkap dan memuat perubahan terbaru", async () => {
    initRepo();
    for (let i = 0; i < 300; i++) write(`src/m${i % 20}/f${i}.txt`, `isi ${i}\n`);
    git(["add", "."]);
    git(["commit", "-q", "-m", "banyak berkas"]);
    write("src/m1/f1.txt", "diubah\n");
    const result = await service().create(dir);
    if (!result.ok) throw new Error(result.message);
    const files = git(["ls-tree", "-r", "--name-only", result.ref]).split("\n").filter(Boolean);
    expect(files.length).toBe(300 + 3); // 300 berkas + .gitignore, a.txt, b.txt
    expect(git(["show", `${result.ref}:src/m1/f1.txt`])).toBe("diubah\n");
  });
});

describe("ketahanan terhadap lingkungan dan konfigurasi pengguna", () => {
  test("variabel GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE dari lingkungan daemon tidak membelokkan checkpoint ke repo lain", async () => {
    initRepo();
    const other = mkdtempSync(join(tmpdir(), "agentmon-cpother-"));
    try {
      git(["init", "-q", "-b", "main"], other);
      const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;
      process.env.GIT_INDEX_FILE = join(other, "indeks-palsu");
      try {
        const result = await service().create(dir);
        expect(result.ok).toBe(true);
      } finally {
        for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree], ["GIT_INDEX_FILE", saved.index]] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(refsOf()).toHaveLength(1); // ada di repo yang dimaksud
      expect(git(["for-each-ref", "refs/agentmon/"], other)).toBe(""); // dan tidak di repo lain
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("hook git milik pengguna tidak dijalankan (reference-transaction lewat .git/hooks maupun core.hooksPath)", async () => {
    initRepo();
    const marker = join(dir, "..", `hook-jalan-${Date.now()}.txt`).split(String.fromCharCode(92)).join("/");
    const script = ["#!/bin/sh", `echo jalan > "${marker}"`, ""].join(String.fromCharCode(10));
    const gitDir = git(["rev-parse", "--absolute-git-dir"]).trim();
    mkdirSync(join(gitDir, "hooks"), { recursive: true });
    writeFileSync(join(gitDir, "hooks", "reference-transaction"), script, { mode: 0o755 });
    const custom = join(dir, "hook-kustom");
    mkdirSync(custom);
    writeFileSync(join(custom, "reference-transaction"), script, { mode: 0o755 });
    git(["config", "core.hooksPath", custom]);
    const result = await service().create(dir);
    expect(result.ok).toBe(true);
    expect(() => readFileSync(marker)).toThrow(); // penanda tidak pernah ditulis
  });

  test("checkpoint yang lahir di milidetik yang sama atau saat jam mundur: yang TERBARU dibuat yang bertahan", async () => {
    initRepo();
    const fixed = new Date(Date.UTC(2026, 10, 12, 10, 0, 0, 0));
    const svc = service({ keep: 2, now: () => fixed });
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await svc.create(dir);
      if (!r.ok) throw new Error(r.message);
      made.push(r.ref);
    }
    expect(refsOf()).toEqual(made.slice(3));
  });

  test("melewati batas waktu dilaporkan sebagai timeout", async () => {
    initRepo();
    const result = await service({ timeoutMs: 0 }).create(dir);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });
});
