import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "./cli";
import { startDaemon, type RunningDaemon } from "./daemon";

let home: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentmon-cli-"));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

const NEW = { sessionId: "s1", toolName: "Write", toolInput: { file_path: "a.txt" } };

async function startDaemonForCli() {
  daemon = await startDaemon({ home, port: 0, holdEnabled: true });
  return daemon;
}

// Menjalankan CLI terhadap daemon yang sedang berjalan, lalu mengumpulkan keluarannya.
async function cli(argv: string[], port: number | string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { AGENTMON_HOME: home, AGENTMON_PORT: String(port) },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("status, pause, resume", () => {
  test("status menjelaskan keadaan dan menyebut izin yang menunggu", async () => {
    const d = await startDaemonForCli();
    expect((await cli(["status"], d.port)).out).toContain("Aktif. Tidak ada permintaan");

    const ticket = d.approvals.request(NEW);
    const waiting = await cli(["status"], d.port);
    expect(waiting.code).toBe(0);
    expect(waiting.out).toContain("menunggu keputusan dari HP untuk 1 permintaan");
    expect(waiting.out).toContain(ticket.approvalId.slice(0, 8));
    expect(waiting.out).toContain("alat=Write");
    d.approvals.cancelAll();
  });

  test("pause menjeda dan melepas izin yang menunggu; resume melanjutkan", async () => {
    const d = await startDaemonForCli();
    const ticket = d.approvals.request(NEW);

    const paused = await cli(["pause"], d.port);
    expect(paused.code).toBe(0);
    expect(paused.out).toContain("Dijeda");
    expect(paused.out).toContain("1 permintaan yang menunggu dilepas");
    expect(await ticket.outcome).toEqual({ status: "cancelled" });
    expect(d.control.isPaused()).toBe(true);

    const resumed = await cli(["resume"], d.port);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain("Aktif");
    expect(d.control.isPaused()).toBe(false);
  });
});

describe("approve dan deny", () => {
  test("tanpa id: dipakai untuk satu-satunya izin yang menunggu", async () => {
    const d = await startDaemonForCli();
    const ticket = d.approvals.request(NEW);
    const result = await cli(["approve"], d.port);
    expect(result).toMatchObject({ code: 0 });
    expect(result.out).toContain("Disetujui: Write");
    expect(await ticket.outcome).toEqual({ status: "approved" });
  });

  test("deny dengan awalan id dan komentar yang terdiri dari beberapa kata", async () => {
    const d = await startDaemonForCli();
    const first = d.approvals.request(NEW);
    const second = d.approvals.request({ ...NEW, toolName: "Edit" });

    const result = await cli(["deny", second.approvalId.slice(0, 12), "jangan", "ubah", "berkas", "ini"], d.port);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Ditolak: Edit");
    expect(await second.outcome).toEqual({ status: "denied", comment: "jangan ubah berkas ini" });
    expect(d.approvals.get(first.approvalId)?.status).toBe("pending"); // yang lain tidak tersentuh
    d.approvals.cancelAll();
  });

  test("beberapa izin menunggu dan id tidak disebut: diminta menyebut id", async () => {
    const d = await startDaemonForCli();
    d.approvals.request(NEW);
    d.approvals.request(NEW);
    const result = await cli(["approve"], d.port);
    expect(result.code).toBe(1);
    expect(result.err).toContain("sebutkan id");
    expect(d.approvals.listPending()).toHaveLength(2); // tidak ada yang disetujui diam-diam
    d.approvals.cancelAll();
  });

  test("tidak ada izin yang menunggu", async () => {
    const d = await startDaemonForCli();
    const result = await cli(["approve"], d.port);
    expect(result).toMatchObject({ code: 1 });
    expect(result.err).toContain("Tidak ada permintaan yang sedang menunggu");
  });

  test("id yang cocok dengan beberapa izin ditolak sebagai ambigu", async () => {
    const d = await startDaemonForCli();
    d.approvals.request(NEW);
    d.approvals.request(NEW);
    const result = await cli(["approve", ""], d.port); // awalan kosong cocok dengan semuanya
    expect(result.code).toBe(1);
    expect(d.approvals.listPending()).toHaveLength(2);
    d.approvals.cancelAll();
  });
});

describe("daemon tidak berjalan atau perintah salah", () => {
  test("daemon mati -> pesan yang menjelaskan cara menjalankannya", async () => {
    const d = await startDaemonForCli();
    const port = d.port;
    await d.stop();
    daemon = undefined;
    // Token masih ada di folder data, tetapi tidak ada yang mendengarkan di port itu.
    const result = await cli(["status"], port);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Daemon tidak berjalan");
    expect(result.err).toContain("pnpm --filter @agentmon/bridge daemon");
  });

  test("daemon belum pernah dijalankan -> berkas token tidak ada", async () => {
    const result = await cli(["status"], 47999);
    expect(result.code).toBe(1);
    expect(result.err).toContain("belum pernah dijalankan");
  });

  test("perintah asing menampilkan cara pakai dengan kode 2; tanpa perintah juga menampilkannya", async () => {
    expect(await cli(["terbang"], 1)).toMatchObject({ code: 2 });
    expect((await cli(["terbang"], 1)).err).toContain("Pemakaian");
    const none = await cli([], 1);
    expect(none.code).toBe(0);
    expect(none.err).toContain("Pemakaian");
  });

  test("AGENTMON_PORT yang tidak valid dilaporkan", async () => {
    const result = await cli(["status"], "bukan-angka");
    expect(result.code).toBe(1);
    expect(result.err).toContain("AGENTMON_PORT tidak valid");
  });
});
