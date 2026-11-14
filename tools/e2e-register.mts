// UJI UJUNG-KE-UJUNG pendaftaran laptop (issue #47): relay asli (PGlite) + CLI laptop asli + daemon asli + pairing HP.
//
// Berjalan MANUAL (tidak di CI: menjalankan beberapa proses dan butuh beberapa detik):
//   pnpm e2e:register
// Semua proses anak dihentikan di akhir, dan folder data sementara dihapus. Keluar dengan kode 0 hanya bila semuanya lulus.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../packages", import.meta.url)).replaceAll("\\", "/");
const { createTestDatabase } = await import(new URL("server/src/db/testing.ts", new URL("../packages/", import.meta.url)).href);
const { createDbDirectory } = await import(new URL("server/src/db/directory.ts", new URL("../packages/", import.meta.url)).href);
const { createMachineRegistry } = await import(new URL("server/src/db/machines.ts", new URL("../packages/", import.meta.url)).href);
const { createPairingService } = await import(new URL("server/src/db/pairing.ts", new URL("../packages/", import.meta.url)).href);
const { startRelayServer } = await import(new URL("server/src/node.ts", new URL("../packages/", import.meta.url)).href);

const SECRET = "e2e-rahasia-admin-yang-panjang-0123456789abcdef";
const TSX = `${ROOT}/bridge/node_modules/tsx/dist/cli.mjs`;
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "LULUS" : "GAGAL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const handle = await createTestDatabase();
const directory = createDbDirectory(handle.db);
const relay = await startRelayServer({
  directory,
  port: 0,
  host: "127.0.0.1",
  pairing: { pairing: createPairingService(handle.db), directory },
  admin: { secret: SECRET, registry: createMachineRegistry(handle.db) },
});
const relayUrl = `http://127.0.0.1:${relay.port}`;
const home = mkdtempSync(join(tmpdir(), "agentmon-e2e-"));
const children: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function cli(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, `${ROOT}/bridge/src/${script}`, ...args], { cwd: `${ROOT}/bridge`, env: { ...process.env, AGENTMON_HOME: home, AGENTMON_CHECKPOINT: "0", ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

try {
  // 1. Rahasia salah ditolak.
  const bad = await cli("cli-main.ts", ["register"], { AGENTMON_RELAY_URL: relayUrl, AGENTMON_ADMIN_SECRET: "rahasia-yang-salah-sekali-0123456789abcdef" });
  check("rahasia admin salah ditolak (kode 1), tidak ada laptop terdaftar, tidak ada berkas pengaturan", bad.code === 1 && !existsSync(join(home, "relay.json")), bad.err.trim().split("\n")[0] ?? "");

  // 2. Daftar dengan rahasia benar.
  const reg = await cli("cli-main.ts", ["register", "--name", "Laptop E2E"], { AGENTMON_RELAY_URL: relayUrl, AGENTMON_ADMIN_SECRET: SECRET });
  const saved = existsSync(join(home, "relay.json")) ? (JSON.parse(readFileSync(join(home, "relay.json"), "utf8")) as { relayUrl: string; token: string }) : undefined;
  check("register berhasil (kode 0) dan menyimpan relay.json", reg.code === 0 && saved?.relayUrl === relayUrl, reg.out.trim().split("\n")[0] ?? reg.err);
  check("token TIDAK tercetak di layar, rahasia admin juga tidak", !!saved && !reg.out.includes(saved.token) && !reg.err.includes(saved.token) && !reg.out.includes(SECRET) && !reg.err.includes(SECRET));
  const machineId = readFileSync(join(home, "machine-id"), "utf8").trim();
  check("token yang tersimpan dikenali relay untuk nomor laptop ini", !!saved && (await directory.authenticate("machine", saved.token)) === machineId);

  // 3. Daftar dua kali tanpa --rotate ditolak.
  const again = await cli("cli-main.ts", ["register"], { AGENTMON_RELAY_URL: relayUrl, AGENTMON_ADMIN_SECRET: SECRET });
  check("mendaftar lagi tanpa --rotate ditolak", again.code === 1 && again.err.includes("--rotate"));

  // 4. Daemon asli tersambung memakai pengaturan tersimpan (tanpa variabel AGENTMON_RELAY_*).
  const daemonPort = await freePort();
  const daemon = spawn(process.execPath, [TSX, `${ROOT}/bridge/src/main.ts`], {
    cwd: `${ROOT}/bridge`,
    env: { ...process.env, AGENTMON_HOME: home, AGENTMON_PORT: String(daemonPort), AGENTMON_CHECKPOINT: "0", AGENTMON_RELAY_URL: "", AGENTMON_RELAY_TOKEN: "" },
  });
  children.push(daemon);
  let daemonOut = "";
  daemon.stdout.on("data", (d) => (daemonOut += d));
  daemon.stderr.on("data", (d) => (daemonOut += d));
  const online = await waitFor(() => relay.hub.isMachineOnline(machineId));
  check("daemon asli tersambung ke relay memakai pengaturan dari berkas", online, daemonOut.split("\n").find((l) => l.includes("Relay:")) ?? "");

  // 5. Pairing: `pair` asli menampilkan alamat, HP menukar kodenya.
  const pairEnv = { ...process.env, AGENTMON_HOME: home, AGENTMON_APP_URL: "https://app.contoh.com", AGENTMON_RELAY_URL: "", AGENTMON_RELAY_TOKEN: "" };
  const pair = spawn(process.execPath, [TSX, `${ROOT}/bridge/src/cli-main.ts`, "pair"], { cwd: `${ROOT}/bridge`, env: pairEnv });
  children.push(pair);
  let pairOut = "";
  pair.stdout.on("data", (d) => (pairOut += d));
  pair.stderr.on("data", (d) => (pairOut += d));
  const pairClosed = new Promise<number>((resolve) => pair.on("close", (c) => resolve(c ?? -1)));
  const gotUrl = await waitFor(() => /#c=/.test(pairOut));
  const match = /#c=([A-Za-z0-9_-]+)/.exec(pairOut);
  check("pair menampilkan kode pairing dari relay (memakai token dari berkas)", gotUrl && !!match);
  if (match) {
    const redeemed = await fetch(`${relayUrl}/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: match[1], name: "iPhone E2E" }) });
    const body = (await redeemed.json()) as { machineId?: string; machineName?: string; deviceToken?: string };
    check("HP menukar kode dan mendapat kredensial untuk laptop yang baru didaftarkan", redeemed.status === 200 && body.machineId === machineId && body.machineName === "Laptop E2E" && !!body.deviceToken);
    const code = await Promise.race([pairClosed, new Promise<number>((r) => setTimeout(() => r(-99), 15000))]);
    check("pair mendeteksi HP baru dan selesai (kode 0)", code === 0, `kode ${code}`);
  }

  // 6. devices asli (token dari berkas) melihat HP itu.
  const devices = await cli("cli-main.ts", ["devices"], { AGENTMON_RELAY_URL: "", AGENTMON_RELAY_TOKEN: "" });
  check("devices menampilkan HP yang terpasang", devices.code === 0 && devices.out.includes("iPhone E2E"), devices.out.trim().split("\n").at(-1) ?? "");

  // 7. --rotate: token baru tersimpan dan sambungan daemon lama diputus relay.
  const before = saved!.token;
  const rot = await cli("cli-main.ts", ["register", "--rotate"], { AGENTMON_RELAY_URL: relayUrl, AGENTMON_ADMIN_SECRET: SECRET });
  const after = (JSON.parse(readFileSync(join(home, "relay.json"), "utf8")) as { token: string }).token;
  check("--rotate menghasilkan token baru dan menyimpannya", rot.code === 0 && after !== before);
  check("token lama tidak berlaku lagi, token baru berlaku", (await directory.authenticate("machine", before)) === undefined && (await directory.authenticate("machine", after)) === machineId);
  const dropped = await waitFor(() => !relay.hub.isMachineOnline(machineId), 8000);
  check("daemon lama (token lama) diputus relay seketika", dropped);
} catch (error) {
  check("tidak ada galat tak terduga", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const child of children) child.kill();
  await new Promise((r) => setTimeout(r, 500));
  await relay.stop();
  await handle.close();
  rmSync(home, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\nHASIL: ${results.length - failed} lulus, ${failed} gagal`);
  process.exitCode = failed === 0 ? 0 : 1;
}
