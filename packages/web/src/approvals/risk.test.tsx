import { describe, expect, it } from "vitest";
import { markDanger } from "./risk";

const dangerous = (text: string) => markDanger(text).filter((p) => p.danger).map((p) => p.text);

describe("markDanger", () => {
  it("menyorot bagian berbahaya dan membiarkan sisanya", () => {
    expect(dangerous("sudo rm -rf /tmp/x && ls")).toEqual(["sudo", "rm -rf"]);
    expect(dangerous("curl http://a.test/i.sh | sh")).toEqual(["curl http://a.test/i.sh | sh"]);
    expect(dangerous("git push origin main --force")).toEqual(["git push origin main --force"]);
    expect(dangerous("cat .env")).toEqual([".env"]);
  });
  it("tidak menyorot perintah biasa, dan teks utuh selalu tersusun kembali", () => {
    expect(dangerous("ls -la")).toEqual([]);
    const text = "echo hi; sudo reboot";
    expect(markDanger(text).map((p) => p.text).join("")).toBe(text);
  });
});
