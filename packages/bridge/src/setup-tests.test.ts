import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentmonHome } from "./home";
import { resolveRelayConfig } from "./relay-config";

describe("isolasi folder data di test", () => {
  test("AGENTMON_HOME menunjuk folder sementara yang kosong, bukan ~/.agentmon pengguna", () => {
    const home = agentmonHome();
    expect(home).not.toBe(join(homedir(), ".agentmon"));
    expect(home).toContain("agentmon-test-home-");
    expect(existsSync(home)).toBe(true);
    expect(readdirSync(home)).toEqual([]);
  });

  test("tanpa pengaturan di lingkungan, tidak ada relay yang terbaca walau laptop pengembang sudah terdaftar", () => {
    expect(resolveRelayConfig({}, agentmonHome())).toBeUndefined();
  });

  test("variabel relay dari lingkungan pengembang tidak bocor ke test", () => {
    for (const name of ["AGENTMON_RELAY_URL", "AGENTMON_RELAY_TOKEN", "AGENTMON_ADMIN_SECRET"]) expect(process.env[name]).toBeUndefined();
  });
});
