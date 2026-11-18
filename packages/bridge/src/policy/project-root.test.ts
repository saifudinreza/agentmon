// FILE INI: TEST pencari akar proyek. Yang terpenting: repo git di folder rumah (umum) BUKAN proyek.
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { findProjectRoot } from "./project-root";

const HOME = resolve("/orang/dono");
const repoAt = (...dirs: string[]) => {
  const git = new Set(dirs.map((d) => join(resolve(d), ".git")));
  return { exists: (p: string) => git.has(p), home: HOME };
};

describe("findProjectRoot", () => {
  test("mengambil folder repo terdekat di atas cwd", () => {
    const options = repoAt("/orang/dono/kode/proyek");
    expect(findProjectRoot("/orang/dono/kode/proyek/src/app/komponen", options)).toBe(resolve("/orang/dono/kode/proyek"));
    expect(findProjectRoot("/orang/dono/kode/proyek", options)).toBe(resolve("/orang/dono/kode/proyek"));
  });

  test("repo bersarang: yang terdekat yang dipakai", () => {
    const options = repoAt("/orang/dono/kode/besar", "/orang/dono/kode/besar/paket/kecil");
    expect(findProjectRoot("/orang/dono/kode/besar/paket/kecil/src", options)).toBe(resolve("/orang/dono/kode/besar/paket/kecil"));
  });

  test("repo git di FOLDER RUMAH bukan proyek: dipakai cwd apa adanya (kalau tidak, seluruh isi home tampak 'di dalam proyek')", () => {
    const options = repoAt("/orang/dono");
    expect(findProjectRoot("/orang/dono/kode/proyek/src", options)).toBe(resolve("/orang/dono/kode/proyek/src"));
    expect(findProjectRoot("/orang/dono", options)).toBe(resolve("/orang/dono"));
  });

  test("repo git DI ATAS folder rumah juga bukan proyek", () => {
    expect(findProjectRoot("/orang/dono/kode", repoAt("/orang"))).toBe(resolve("/orang/dono/kode"));
    expect(findProjectRoot("/orang/dono/kode", repoAt("/"))).toBe(resolve("/orang/dono/kode"));
  });

  test("repo di folder SAUDARA home (bukan di atasnya) tetap proyek", () => {
    const options = { ...repoAt("/orang/lain/proyek"), home: HOME };
    expect(findProjectRoot("/orang/lain/proyek/src", options)).toBe(resolve("/orang/lain/proyek"));
  });

  test("tanpa repo: cwd apa adanya, dan tidak berputar tanpa akhir sampai akar sistem", () => {
    expect(findProjectRoot("/orang/dono/kode/tanpa-git", { exists: () => false, home: HOME })).toBe(resolve("/orang/dono/kode/tanpa-git"));
  });
});
