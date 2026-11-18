// =====================================================================================
// FILE INI: perintah `uninstall` = "TUKANG COPOT" yang mengembalikan komputer ke keadaan sebelum AgentMon (PRD FR-57).
// =====================================================================================
//
// Urutan (tiap langkah dicoba walau langkah sebelumnya gagal; kode keluar 1 bila ada yang gagal):
//   1. Hook: HANYA entri milik AgentMon yang dibuang dari pengaturan Claude Code (`removeAgentmonHooks`). Pengaturan dan hook milik
//      pengguna, termasuk yang ditambahkan SESUDAH setup, tidak disentuh. TIDAK memulihkan cadangan: pengguna bisa saja sudah
//      mengubah pengaturannya sejak setup, dan memulihkan cadangan akan menghapus perubahan itu.
//   2. Autostart dicopot dan daemon yang dinyalakannya dihentikan; daemon yang masih menjawab (dijalankan manual) diminta berhenti.
//   3. Laptop ini dicabut dari relay (HP yang terpasang kehilangan hubungannya).
//   4. Data lokal dan checkpoint DITAWARKAN, tidak dihapus tanpa diminta (`--purge-data`, `--purge-checkpoints`). Aturan otomatis
//      (policy.json) milik pengguna dipertahankan kecuali `--purge-policy`.
//
// KEAMANAN: penghapusan berkas memakai DAFTAR NAMA yang dikenal (bukan menghapus folder secara rekursif), karena folder data bisa
// diarahkan ke mana saja lewat AGENTMON_HOME. Checkpoint hanya menyentuh ref di bawah refs/agentmon/checkpoints/. Token tidak pernah dicetak.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { autostartStatus, removeAutostart, WINDOWS_VBS_NAME, type AutostartOptions } from "./autostart";
import { CHECKPOINT_NAMESPACE } from "./checkpoint";
import { DEFAULT_PORT } from "./daemon";
import { paths } from "./home";
import { toWebSocketUrl } from "./relay-client";
import { resolveRelayConfig } from "./relay-config";
import { deleteSettings, detectFormat, isPortOpen, listSettingsBackups, removeAgentmonHooks, resolveClaudeDir, serialize, SettingsWriteError, stampOf, writeSettings } from "./setup";

type Status = "ok" | "nothing" | "skipped" | "manual" | "failed";

export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export type UninstallOptions = {
  home: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  claudeDir?: string;
  port?: number;
  /** Hanya melaporkan apa yang akan dilakukan; tidak mengubah, menghentikan, atau menghubungi apa pun. */
  dryRun?: boolean;
  /** Menghapus data lokal (token, nomor laptop, log, daftar checkpoint, catatan sesi, cadangan pengaturan). */
  purgeData?: boolean;
  /** Ikut menghapus aturan otomatis milik pengguna (policy.json). Tanpa ini, aturan dipertahankan walau --purge-data. */
  purgePolicy?: boolean;
  /** Menghapus checkpoint AgentMon (refs/agentmon/checkpoints/*) di repo yang tercatat. */
  purgeCheckpoints?: boolean;
  /** Tidak mencabut laptop dari relay. */
  skipRelay?: boolean;
  now?: () => Date;
  /** Hanya untuk test. */
  fetch?: typeof fetch;
  autostart?: Partial<Pick<AutostartOptions, "platform" | "exec" | "portOpen" | "spawnDetached" | "homeDir" | "launch" | "startWaitMs">>;
  portOpen?: (port: number) => Promise<boolean>;
  stopDaemon?: (port: number, token: string) => Promise<boolean>;
  git?: GitRunner;
  waitMs?: number;
};

const defaultGit: GitRunner = (args, cwd) =>
  new Promise((done) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 20_000, encoding: "utf8" }, (error, stdout) => {
      const raw = (error as { code?: unknown } | null)?.code;
      done({ code: error ? (typeof raw === "number" ? raw : 1) : 0, stdout: String(stdout ?? "") });
    });
  });

/** Meminta daemon berhenti lewat API lokalnya (token daemon). true bila diterima. */
export const defaultStopDaemon = (port: number, token: string): Promise<boolean> =>
  new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path: "/stop", method: "POST", headers: { authorization: `Bearer ${token}`, "content-length": "0" }, timeout: 4000 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(false));
    req.end();
  });

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitUntilClosed(probe: (port: number) => Promise<boolean>, port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (!(await probe(port))) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(250, Math.max(10, ms / 20)));
  }
}

/** Nama berkas yang dikenal di folder data. Hanya ini yang boleh dihapus oleh --purge-data. */
const DATA_FILES = ["token", "machine-id", "daemon.json", "daemon.log", "daemon.log.1", "checkpoints.json", "session-flags.json", "claude-hooks.json"];

export async function runUninstall(options: UninstallOptions): Promise<number> {
  const { out, err, env, home } = options;
  const dry = options.dryRun === true;
  const port = options.port ?? DEFAULT_PORT;
  const probe = options.portOpen ?? isPortOpen;
  const results: Array<{ step: string; status: Status; note: string }> = [];
  const record = (step: string, status: Status, note: string) => {
    results.push({ step, status, note });
    (status === "failed" ? err : out)(`${status === "ok" ? "OK     " : status === "failed" ? "GAGAL  " : status === "manual" ? "MANUAL " : "       "}${step}: ${note}`);
  };
  out(dry ? "AgentMon uninstall (--dry-run: tidak ada yang diubah)" : "AgentMon uninstall");

  // ---- 1. Hook di pengaturan Claude Code ----
  const dir = resolveClaudeDir(env, options.claudeDir);
  let settingsFile: string | undefined;
  if (!dir.ok) record("Hook Claude Code", "failed", `${dir.message} Pakai --claude-dir <folder absolut>.`);
  else {
    settingsFile = join(dir.dir, "settings.json");
    const file = settingsFile;
    if (!existsSync(file)) record("Hook Claude Code", "nothing", "tidak ada settings.json, jadi tidak ada hook AgentMon");
    else {
      let text = "";
      let existing: unknown;
      let ok = true;
      try {
        text = readFileSync(file, "utf8");
        const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        existing = body.trim() === "" ? undefined : JSON.parse(body);
      } catch {
        ok = false;
        record("Hook Claude Code", "failed", `pengaturan Claude Code tidak terbaca atau bukan JSON yang sah (${file}); tidak diubah`);
      }
      if (ok) {
        const removed = removeAgentmonHooks(existing);
        if (!removed.ok) record("Hook Claude Code", "failed", `pengaturan tidak dikenali (${removed.reason}); tidak diubah`);
        else if (!removed.changed || removed.replaced === 0) record("Hook Claude Code", "nothing", "tidak ada hook AgentMon di pengaturan Anda");
        else if (dry) record("Hook Claude Code", "ok", `AKAN membuang ${removed.replaced} hook AgentMon dari ${file} (hook dan pengaturan Anda yang lain tidak disentuh)`);
        else {
          try {
            const stamp = stampOf((options.now ?? (() => new Date()))());
            if (Object.keys(removed.settings).length === 0 && lstatSync(file).isSymbolicLink()) {
              // Tautan simbolik (mis. dari repo dotfiles) tidak dihapus: hanya isinya yang dikosongkan.
              const outcome = writeSettings(file, serialize({}, detectFormat(text)), stamp, text);
              record("Hook Claude Code", "ok", `${removed.replaced} hook AgentMon dibuang; isi ${outcome.target} kini kosong (tautan simbolik tidak dihapus)${outcome.backup ? ` (cadangan: ${outcome.backup})` : ""}`);
            } else if (Object.keys(removed.settings).length === 0) {
              // Setelah hook AgentMon dibuang tidak ada apa-apa lagi: berkas itu dibuat oleh setup. Dicadangkan lalu dihapus.
              const { backup } = deleteSettings(file, stamp, text);
              record("Hook Claude Code", "ok", `${removed.replaced} hook AgentMon dibuang; settings.json tidak berisi apa pun lagi, jadi dihapus (cadangan: ${backup})`);
            } else {
              const outcome = writeSettings(file, serialize(removed.settings, detectFormat(text)), stamp, text);
              record("Hook Claude Code", "ok", `${removed.replaced} hook AgentMon dibuang dari ${outcome.target}; yang lain tidak disentuh${outcome.backup ? ` (cadangan: ${outcome.backup})` : ""}`);
            }
          } catch (error) {
            record("Hook Claude Code", "failed", error instanceof SettingsWriteError ? error.message : `gagal menulis pengaturan: ${error instanceof Error ? error.message.replace(/[0-9a-f]{64}/gi, "***") : "galat"}`);
          }
        }
      }
    }
  }

  // ---- 2. Autostart dan daemon ----
  const base = { env, out: () => undefined, err: () => undefined, dataDir: resolve(home), ...(options.autostart ?? {}) };
  let tokenFile: string | undefined;
  try {
    tokenFile = readFileSync(paths(home).token, "utf8").trim();
  } catch {
    tokenFile = undefined;
  }
  const auto = await autostartStatus(base);
  if (dry) record("Autostart", auto.enabled ? "ok" : "nothing", auto.enabled ? `AKAN dicopot (${auto.mechanism}) dan daemon yang dinyalakannya dihentikan` : "tidak terpasang");
  else if (auto.enabled || auto.supported) {
    const lines: string[] = [];
    const code = await removeAutostart({ ...base, out: (t) => lines.push(t), err: (t) => lines.push(t) });
    if (code !== 0) record("Autostart", "failed", lines.filter((l) => !/tidak disentuh/.test(l)).join(" ") || "gagal dicopot");
    else record("Autostart", auto.enabled ? "ok" : "nothing", auto.enabled ? `dicopot (${auto.mechanism})` : "tidak terpasang");
  } else record("Autostart", "nothing", auto.mechanism);

  if (await probe(port)) {
    if (dry) record("Daemon", "ok", `AKAN diminta berhenti (masih menjawab di 127.0.0.1:${port})`);
    else if (!tokenFile) record("Daemon", "manual", `masih berjalan di 127.0.0.1:${port} tetapi tokennya tidak terbaca; hentikan di terminalnya (Ctrl+C)`);
    else {
      const accepted = await (options.stopDaemon ?? defaultStopDaemon)(port, tokenFile);
      const closed = accepted && (await waitUntilClosed(probe, port, options.waitMs ?? 6000));
      if (closed) record("Daemon", "ok", "daemon yang masih berjalan sudah berhenti");
      else record("Daemon", "manual", `daemon di 127.0.0.1:${port} tidak berhenti (versi lama tanpa perintah berhenti?); hentikan di terminalnya (Ctrl+C) atau matikan prosesnya`);
    }
  } else record("Daemon", "nothing", "tidak sedang berjalan");

  // ---- 3. Relay ----
  let relayKeepNote = false;
  let relayDone = true; // true = aman menghapus relay.json (sudah dicabut, atau memang tidak terdaftar)
  if (options.skipRelay) {
    relayDone = false;
    record("Relay", "skipped", "dilewati (--skip-relay); laptop ini masih terdaftar di relay dan relay.json dipertahankan");
  } else {
    let relay: ReturnType<typeof resolveRelayConfig>;
    try {
      relay = resolveRelayConfig(env, home);
    } catch (error) {
      relay = undefined;
      relayDone = false;
      record("Relay", "failed", `pengaturan relay rusak, tidak bisa dicabut otomatis: ${error instanceof Error ? error.message : "galat"}`);
    }
    if (relay) {
      // relay.json hanya aman dihapus bila memang itu yang dicabut; bila lingkungan menimpa (URL/token beda), berkas itu milik relay lain.
      try {
        const file = JSON.parse(readFileSync(join(home, "relay.json"), "utf8")) as { relayUrl?: unknown; token?: unknown };
        if (file.relayUrl !== relay.relayUrl || file.token !== relay.token) relayKeepNote = true;
      } catch {
        /* tidak ada berkas: tidak ada yang perlu dijaga */
      }
      const host = (() => {
        try {
          return new URL(relay.relayUrl).host;
        } catch {
          return "relay";
        }
      })();
      if (dry) {
        relayDone = false;
        record("Relay", "ok", `AKAN mencabut laptop ini dari ${host} (HP yang terpasang kehilangan hubungannya)`);
      } else {
        let insecure = false;
        try {
          toWebSocketUrl(relay.relayUrl, env.AGENTMON_RELAY_INSECURE === "1");
        } catch {
          insecure = true;
        }
        if (insecure) {
          relayDone = false;
          record("Relay", "failed", `alamat relay (${host}) tidak terenkripsi; token tidak dikirim. Pakai https, atau izinkan dengan AGENTMON_RELAY_INSECURE=1`);
        } else {
          try {
            const response = await (options.fetch ?? fetch)(`${relay.relayUrl.replace(/\/+$/, "")}/machine`, { method: "DELETE", headers: { authorization: `Bearer ${relay.token}` }, signal: AbortSignal.timeout(10_000) });
            if (response.status === 200) record("Relay", "ok", `laptop ini dicabut dari ${host}`);
            else if (response.status === 401) record("Relay", "nothing", `${host} tidak mengenal token ini lagi (sudah dicabut atau diganti)`);
            else if (response.status === 404 || response.status === 405) {
              relayDone = false;
              record("Relay", "manual", `${host} belum mendukung pencabutan mandiri (versi relay lama). Minta pemilik relay menghapus laptop ini; relay.json dipertahankan`);
            } else if (response.status === 429) {
              relayDone = false;
              record("Relay", "failed", `${host} menolak sementara (terlalu banyak permintaan); ulangi sebentar lagi. relay.json dipertahankan`);
            } else {
              relayDone = false;
              record("Relay", "failed", `${host} menjawab ${response.status}; relay.json dipertahankan supaya bisa diulang`);
            }
          } catch {
            relayDone = false;
            record("Relay", "failed", `${host} tidak terjangkau; relay.json dipertahankan supaya bisa diulang (uninstall lagi saat ada koneksi)`);
          }
        }
      }
    } else if (relayDone) record("Relay", "nothing", "laptop ini tidak terdaftar ke relay");
  }

  // ---- 4. Data lokal dan checkpoint: ditawarkan; dihapus hanya bila diminta ----
  const repoRoots = (() => {
    try {
      const raw = JSON.parse(readFileSync(join(home, "checkpoints.json"), "utf8")) as Record<string, { root?: unknown }>;
      const roots = Object.values(raw).flatMap((e) => (typeof e?.root === "string" ? [e.root] : []));
      return { total: roots.length, unique: [...new Set(roots)] };
    } catch {
      return { total: 0, unique: [] as string[] };
    }
  })();
  const git = options.git ?? defaultGit;
  if (options.purgeCheckpoints) {
    let deleted = 0;
    let failed = 0;
    let repos = 0;
    for (const root of repoRoots.unique) {
      if (!existsSync(root)) continue;
      const listed = await git(["for-each-ref", "--format=%(refname)", CHECKPOINT_NAMESPACE], root);
      if (listed.code !== 0) {
        failed += 1;
        continue;
      }
      const refs = listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter((r) => r.startsWith(CHECKPOINT_NAMESPACE)); // hanya ref milik AgentMon
      if (refs.length > 0) repos += 1;
      for (const ref of refs) {
        if (dry) {
          deleted += 1;
          continue;
        }
        const result = await git(["update-ref", "-d", ref], root);
        if (result.code === 0) deleted += 1;
        else failed += 1;
      }
    }
    if (failed > 0) record("Checkpoint", "failed", `${deleted} checkpoint ${dry ? "AKAN " : ""}dihapus di ${repos} repo, ${failed} gagal`);
    else if (deleted === 0) record("Checkpoint", "nothing", "tidak ada checkpoint AgentMon di repo yang tercatat");
    else record("Checkpoint", "ok", `${deleted} checkpoint ${dry ? "AKAN " : ""}dihapus di ${repos} repo (ruang disk baru kembali setelah \`git gc\`)`);
  } else if (repoRoots.total > 0) {
    record("Checkpoint", "skipped", `${repoRoots.total} checkpoint di ${repoRoots.unique.length} repo masih ada. Hapus dengan: uninstall --purge-checkpoints`);
  } else record("Checkpoint", "nothing", "tidak ada yang tercatat");

  if (relayKeepNote) relayDone = false;
  const daemonStuck = results.some((r) => r.step === "Daemon" && r.status === "manual");
  // checkpoints.json adalah satu-satunya daftar repo: dipertahankan selama checkpoint belum dibersihkan. token dipertahankan selama daemon belum berhenti.
  const checkpointsPending = repoRoots.total > 0 && !(options.purgeCheckpoints && !results.some((r) => r.step === "Checkpoint" && r.status === "failed"));
  const removable = [...DATA_FILES, ...(relayDone ? ["relay.json"] : [])]
    .filter((name) => !(name === "checkpoints.json" && checkpointsPending) && !(name === "token" && daemonStuck))
    .filter((name) => existsSync(join(home, name)));
  const policyFile = join(home, "policy.json");
  const backups = settingsFile ? listSettingsBackups(settingsFile) : [];
  if (options.purgeData) {
    if (dry) {
      record("Data lokal", "ok", `AKAN menghapus ${removable.length} berkas di ${home}${backups.length ? ` dan ${backups.length} cadangan pengaturan Claude Code` : ""}${options.purgePolicy ? " beserta policy.json" : " (policy.json dipertahankan)"}`);
    } else {
      let count = 0;
      const failedNames: string[] = [];
      const remove = (path: string) => {
        try {
          if (lstatSync(path).isDirectory()) return;
          unlinkSync(path);
          count += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedNames.push(path);
        }
      };
      for (const name of removable) remove(join(home, name));
      remove(join(home, "autostart", WINDOWS_VBS_NAME));
      try {
        rmdirSync(join(home, "autostart")); // hanya bila sudah kosong
      } catch {
        /* masih ada isinya atau tidak ada */
      }
      for (const backup of backups) remove(backup);
      if (options.purgePolicy) remove(policyFile);
      try {
        if (readdirSync(home).length === 0) rmdirSync(home); // folder data dihapus hanya bila sudah kosong
      } catch {
        /* ada isinya (mis. policy.json) atau sudah tidak ada */
      }
      if (failedNames.length > 0) record("Data lokal", "failed", `${count} berkas dihapus, ${failedNames.length} gagal (${failedNames.map((n) => n.split(/[\\/]/).pop()).join(", ")})`);
      else record("Data lokal", "ok", `${count} berkas dihapus${existsSync(policyFile) && !options.purgePolicy ? "; policy.json (aturan Anda) dipertahankan, hapus dengan --purge-policy" : ""}`);
    }
  } else {
    const left = [...removable, ...(existsSync(policyFile) ? ["policy.json"] : [])];
    record(
      "Data lokal",
      "skipped",
      left.length === 0 && backups.length === 0
        ? "tidak ada data tersisa"
        : `masih ada di ${home}: ${left.join(", ") || "-"}${backups.length ? `; ${backups.length} cadangan pengaturan Claude Code (bisa memuat token lama)` : ""}. Hapus dengan: uninstall --purge-data (aturan otomatis tetap dipertahankan kecuali --purge-policy)`,
    );
  }

  // ---- Ringkasan ----
  const failedSteps = results.filter((r) => r.status === "failed");
  const manual = results.filter((r) => r.status === "manual");
  out("");
  if (failedSteps.length > 0) err(`Ada ${failedSteps.length} langkah yang gagal. Perbaiki lalu jalankan uninstall lagi (aman diulang).`);
  else if (manual.length > 0) out(`Selesai, dengan ${manual.length} langkah yang perlu Anda lakukan sendiri (lihat di atas).`);
  else out(dry ? "Selesai (hanya dilaporkan)." : "Selesai. Sesi Claude Code yang sudah terbuka masih memuat hook lama sampai dimulai ulang; hook itu gagal dengan tenang dan tidak mengganggu.");
  return failedSteps.length > 0 ? 1 : 0;
}
