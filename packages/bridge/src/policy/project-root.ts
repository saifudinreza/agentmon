// =====================================================================================
// FILE INI: mencari "akar proyek" dari folder kerja agent (folder repo git terdekat di atasnya).
// =====================================================================================
//
// `cwd` pada hook Claude Code adalah folder kerja SAAT INI dan bisa berada di subfolder (agent pindah folder). Aturan seperti
// `migrations/**` atau `src/**` dan berkas aturan proyek (`.agentmon/policy.json`) harus dihitung dari AKAR proyek, bukan dari `cwd`.
//
// Pengaman: bila "repo" yang ditemukan adalah folder rumah pengguna atau di atasnya (repo git di folder home itu umum), itu BUKAN proyek:
// menjadikannya akar akan membuat seluruh isi home tampak "di dalam proyek". Dalam kasus itu dipakai `cwd` apa adanya.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const isSameOrInside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export type ProjectRootOptions = { home?: string; exists?: (path: string) => boolean };

export function findProjectRoot(cwd: string, options: ProjectRootOptions = {}): string {
  const exists = options.exists ?? existsSync;
  const home = resolve(options.home ?? homedir());
  const start = resolve(cwd);
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (exists(join(dir, ".git"))) return isSameOrInside(dir, home) ? start : dir; // dir adalah home atau di atas home: bukan proyek
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
