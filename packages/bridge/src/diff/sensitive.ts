// =====================================================================================
// FILE INI: menandai path berkas yang sensitif.
// =====================================================================================
//
// Sebagian berkas lebih berbahaya diubah daripada yang lain: kunci dan kata sandi, pengaturan
// yang membuat perintah berjalan sendiri, atau berkas di luar proyek. Fungsi di sini hanya
// MENANDAI path dan menyebut alasannya, supaya tampilan review bisa menyorotnya. Keputusan
// "seberapa berisiko" dan "boleh otomatis atau tidak" ada di penilai risiko dan policy engine
// (issue terpisah), yang memakai tanda ini sebagai salah satu bahan.
//
// Aturannya sengaja KONSERVATIF: lebih baik menandai berlebihan daripada melewatkan satu
// berkas rahasia. Hanya path yang diperiksa, tidak pernah isi berkasnya.
import type { SensitiveReason } from "@agentmon/shared";

export type ClassifyOptions = {
  // Folder proyek (biasanya cwd agent). Bila diisi, path di luarnya ditandai.
  projectRoot?: string;
};

// Ubah ke bentuk seragam: garis miring biasa, tanpa pengulangan, dan bagian "." serta ".."
// diselesaikan. Dengan begitu path gaya Windows (C:\proyek\.env) dan gaya Unix diperlakukan sama
// di sistem operasi mana pun, dan "/proyek/../etc/hosts" tidak bisa menyamar sebagai isi proyek.
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const drive = /^[a-zA-Z]:/.exec(slashed)?.[0] ?? ""; // huruf drive Windows, misalnya "C:"
  const rest = slashed.slice(drive.length);
  const absolute = rest.startsWith("/");

  const kept: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (kept.length > 0 && kept.at(-1) !== "..") kept.pop();
      else if (!absolute) kept.push(".."); // path relatif boleh naik di atas titik awalnya
      continue; // path absolut tidak bisa naik di atas akar
    }
    kept.push(segment);
  }
  return drive + (absolute ? "/" : "") + kept.join("/");
}

const reason = (code: string, message: string): SensitiveReason => ({ code, message });

const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults?)$/;
const PRIVATE_KEY_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk"];
const PRIVATE_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const CREDENTIAL_FILES = new Set([".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".dockercfg"]);
// ".agentmon" = data daemon sendiri: token kendali lokal, kredensial relay, dan aturan policy. Agent tidak boleh menyentuhnya.
const CREDENTIAL_FOLDERS = new Set([".ssh", ".aws", ".azure", ".kube", ".gnupg", ".docker", ".agentmon"]);
const SHELL_PROFILES = new Set([".bashrc", ".bash_profile", ".bash_login", ".zshrc", ".zprofile", ".zshenv", ".profile"]);
// Berkas yang menentukan perintah apa yang dijalankan proyek (skrip, build, hook). PRD §9
// menyebutnya sebagai "celah skrip": agent bisa mengubahnya lebih dulu, lalu perintah "aman"
// seperti `npm test` menjalankan kode yang sudah diubah.
const SCRIPT_CONFIG_FILES = new Set([
  "package.json", // Node
  "makefile",
  "justfile",
  "taskfile.yml",
  "pyproject.toml", // Python
  "setup.py",
  ".pre-commit-config.yaml",
  "cargo.toml", // Rust (build.rs di bawah menjalankan kode saat build)
  "build.rs",
  "pom.xml", // Java
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "composer.json", // PHP
  "gemfile", // Ruby
  "rakefile",
]);
// go.mod sengaja tidak masuk: isinya deklaratif (daftar dependensi), bukan skrip yang dijalankan.
const COMPOSE_FILES = new Set(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]);
const AGENT_FOLDERS = new Set([".claude", ".agentmon", ".codex"]);

/**
 * Mengembalikan alasan sebuah path dianggap sensitif. Daftar kosong = tidak ada yang ditandai.
 * Satu path bisa punya beberapa alasan.
 */
export function classifyPath(filePath: string, options: ClassifyOptions = {}): SensitiveReason[] {
  const path = normalize(filePath);
  const lower = path.toLowerCase();
  const segments = lower.split("/").filter((s) => s !== "");
  const base = segments.at(-1) ?? "";
  const folders = segments.slice(0, -1); // semua bagian kecuali nama berkasnya
  const reasons: SensitiveReason[] = [];

  if ((base === ".env" || base.startsWith(".env.")) && !ENV_TEMPLATE.test(base)) {
    reasons.push(reason("env_file", "Berkas .env biasanya berisi kata sandi dan kunci API."));
  }
  // .envrc (direnv) berisi kredensial DAN dijalankan sebagai skrip shell setiap kali folder dimasuki.
  if (base === ".envrc") {
    reasons.push(reason("env_file", "Berkas .envrc (direnv) berisi variabel lingkungan dan dijalankan otomatis sebagai skrip."));
  }

  if (PRIVATE_KEY_EXTENSIONS.some((ext) => base.endsWith(ext)) || PRIVATE_KEY_NAMES.has(base)) {
    reasons.push(reason("private_key", "Berkas ini kemungkinan kunci privat atau sertifikat."));
  }

  // Pencocokan nama berkas sengaja KASAR (substring): "secretary_notes.md" ikut tertandai, tetapi
  // pola yang lebih presisi akan melewatkan "mysecrets.yml". Melewatkan berkas rahasia lebih buruk
  // daripada menandai berlebihan, dan ini hanya penanda.
  if (
    CREDENTIAL_FILES.has(base) ||
    /credential|secret/.test(base) ||
    folders.some((f) => CREDENTIAL_FOLDERS.has(f))
  ) {
    reasons.push(reason("credentials", "Berkas ini kemungkinan berisi kredensial atau rahasia akses."));
  }

  // Folder .git sebagai bagian dari path (bukan berkas .gitignore): hook dan config di dalamnya
  // bisa membuat perintah berjalan sendiri.
  if (folders.includes(".git")) {
    reasons.push(reason("git_internals", "Berkas internal git (hook dan config) bisa menjalankan perintah sendiri."));
  }

  if (
    lower.includes(".github/workflows/") ||
    base === ".gitlab-ci.yml" ||
    base === "azure-pipelines.yml" ||
    base === "jenkinsfile"
  ) {
    reasons.push(reason("ci_workflow", "Berkas CI menjalankan perintah otomatis di server saat ada perubahan."));
  }

  if (folders.some((f) => AGENT_FOLDERS.has(f))) {
    reasons.push(reason("agent_config", "Berkas pengaturan agent atau AgentMon; mengubahnya bisa mematikan pengawasan."));
  }

  if (SHELL_PROFILES.has(base) || /profile\.ps1$/.test(base)) {
    reasons.push(reason("shell_profile", "Profil shell dijalankan setiap kali terminal dibuka."));
  }

  // Dockerfile menjalankan perintah saat membangun citra; Compose memuat variabel lingkungan,
  // rahasia, dan pemasangan folder dari laptop ke kontainer.
  if (base === "dockerfile" || base.startsWith("dockerfile.") || COMPOSE_FILES.has(base)) {
    reasons.push(reason("container_config", "Berkas Docker menentukan perintah build, variabel lingkungan, dan akses ke laptop."));
  }

  if (SCRIPT_CONFIG_FILES.has(base) || folders.includes(".husky")) {
    reasons.push(reason("script_config", "Berkas ini menentukan perintah yang dijalankan proyek (skrip dan build)."));
  }

  if (options.projectRoot !== undefined && !isInside(path, options.projectRoot)) {
    reasons.push(reason("outside_project", "Berkas ini berada di luar folder proyek."));
  }
  return reasons;
}

// Apakah `path` berada di dalam `root`? Dibandingkan sebagai teks setelah diseragamkan, supaya
// hasilnya sama di semua sistem operasi. Path gaya Windows (huruf drive) dibandingkan tanpa
// peduli huruf besar-kecil, seperti Windows sendiri.
function isInside(path: string, root: string): boolean {
  const windowsLike = /^[a-z]:/i.test(path) || /^[a-z]:/i.test(root);
  const fold = (p: string) => (windowsLike ? p.toLowerCase() : p);
  const target = fold(path);
  const base = fold(normalize(root)).replace(/\/$/, "");
  return target === base || target.startsWith(`${base}/`);
}
