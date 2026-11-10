import { describe, expect, test } from "vitest";
import { classifyPath } from "./sensitive";

const codes = (path: string, projectRoot?: string) =>
  classifyPath(path, projectRoot === undefined ? {} : { projectRoot }).map((r) => r.code);

describe("classifyPath: berkas rahasia", () => {
  test.each([
    ["C:\\proyek\\.env", "env_file"],
    ["/home/u/proyek/.env", "env_file"],
    ["/home/u/proyek/.env.local", "env_file"],
    ["/home/u/proyek/.env.production", "env_file"],
    ["/home/u/proyek/.envrc", "env_file"], // direnv: kredensial sekaligus skrip yang dijalankan otomatis
    ["/home/u/proyek/.ENV", "env_file"], // huruf besar (Windows tidak peduli)
    ["/home/u/.ssh/id_rsa", "private_key"],
    ["/home/u/proyek/server.pem", "private_key"],
    ["C:\\proyek\\certs\\app.key", "private_key"],
    ["/proyek/keystore.jks", "private_key"],
    ["/proyek/secrets.yml", "credentials"],
    ["/proyek/config/credentials.json", "credentials"],
    ["/proyek/client_secret.json", "credentials"],
    ["/home/u/.npmrc", "credentials"],
    ["/home/u/.aws/config", "credentials"],
    ["C:\\Users\\u\\.ssh\\config", "credentials"],
    ["/home/u/.git-credentials", "credentials"],
  ])("%s ditandai %s", (path, code) => {
    expect(codes(path)).toContain(code);
  });

  test.each([".env.example", ".env.sample", ".env.template", ".env.dist"])("templat %s tidak ditandai sebagai berkas .env", (name) => {
    expect(codes(`/proyek/${name}`)).not.toContain("env_file");
  });

  test.each(["/proyek/src/app.ts", "/proyek/README.md", "/proyek/src/environment.ts", "/proyek/.gitignore", "/proyek/src/keyboard.ts"])(
    "berkas biasa %s tidak ditandai",
    (path) => {
      expect(codes(path, "/proyek")).toEqual([]);
    },
  );

  test("pencocokan 'credential' dan 'secret' sengaja kasar: nama yang mengandungnya ikut tertandai", () => {
    expect(codes("/proyek/mysecrets.yml")).toContain("credentials"); // tidak boleh terlewat
    expect(codes("/proyek/secretary_notes.md")).toContain("credentials"); // salah tandai yang dapat diterima
  });

  test("kunci publik (.pub) tidak dianggap kunci privat", () => {
    expect(codes("/home/u/proyek/id_rsa.pub")).not.toContain("private_key");
  });
});

describe("classifyPath: berkas yang membuat perintah berjalan sendiri", () => {
  test.each([
    ["/proyek/.git/hooks/pre-commit", "git_internals"],
    ["C:\\proyek\\.git\\config", "git_internals"],
    ["/proyek/.github/workflows/ci.yml", "ci_workflow"],
    ["/proyek/.gitlab-ci.yml", "ci_workflow"],
    ["/proyek/.claude/settings.json", "agent_config"],
    ["/home/u/.agentmon/token", "agent_config"],
    ["/home/u/.bashrc", "shell_profile"],
    ["C:\\Users\\u\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1", "shell_profile"],
    ["/proyek/package.json", "script_config"],
    ["/proyek/Makefile", "script_config"],
    ["/proyek/.husky/pre-push", "script_config"],
    ["/proyek/pyproject.toml", "script_config"],
    ["/proyek/Cargo.toml", "script_config"],
    ["/proyek/build.rs", "script_config"],
    ["/proyek/pom.xml", "script_config"],
    ["/proyek/build.gradle.kts", "script_config"],
    ["/proyek/composer.json", "script_config"],
    ["/proyek/Gemfile", "script_config"],
    ["/proyek/Rakefile", "script_config"],
    ["/proyek/Dockerfile", "container_config"],
    ["/proyek/Dockerfile.dev", "container_config"],
    ["/proyek/docker-compose.yml", "container_config"],
    ["C:\\proyek\\compose.yaml", "container_config"],
  ])("%s ditandai %s", (path, code) => {
    expect(codes(path)).toContain(code);
  });

  test("go.mod tidak ditandai: isinya deklaratif (daftar dependensi), bukan skrip", () => {
    expect(codes("/proyek/go.mod", "/proyek")).toEqual([]);
  });

  test("package.json di dalam folder bersarang tetap ditandai", () => {
    expect(codes("/proyek/packages/web/package.json")).toContain("script_config");
  });
});

describe("classifyPath: di luar folder proyek", () => {
  test.each([
    ["/proyek/src/a.ts", "/proyek", false],
    ["/proyek", "/proyek", false],
    ["/proyek/", "/proyek/", false],
    ["/proyek-lain/a.ts", "/proyek", true], // awalan yang sama bukan berarti di dalam
    ["/etc/hosts", "/proyek", true],
    ["/proyek/../etc/hosts", "/proyek", true],
    ["C:\\work\\project\\app.ts", "C:\\work\\project", false],
    ["c:\\WORK\\Project\\app.ts", "C:\\work\\project", false], // Windows tidak peduli huruf besar-kecil
    ["D:\\lain\\app.ts", "C:\\work\\project", true],
    ["C:\\work\\project-lain\\app.ts", "C:\\work\\project", true],
  ])("%s dengan akar %s -> di luar: %s", (path, root, outside) => {
    expect(codes(path, root).includes("outside_project")).toBe(outside);
  });

  test("tanpa folder proyek, tidak ada tanda 'di luar proyek'", () => {
    expect(codes("/mana/saja/a.ts")).toEqual([]);
  });
});

describe("classifyPath: alasan", () => {
  test("satu path bisa punya beberapa alasan, masing-masing berpesan bahasa Indonesia", () => {
    const reasons = classifyPath("/luar/.ssh/id_rsa", { projectRoot: "/proyek" });
    expect(reasons.map((r) => r.code).sort()).toEqual(["credentials", "outside_project", "private_key"]);
    for (const r of reasons) expect(r.message.length).toBeGreaterThan(10);
  });

  test("hanya path yang diperiksa: tidak membaca berkas apa pun", () => {
    // Path yang tidak ada di disk tetap diklasifikasi tanpa error.
    expect(() => classifyPath("Z:\\tidak\\ada\\.env")).not.toThrow();
  });
});
