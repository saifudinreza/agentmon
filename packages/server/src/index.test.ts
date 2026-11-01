import { expect, test } from "vitest";
import { name } from "./index";

test("bisa memakai kode dari shared", () => {
  expect(name).toBe("AgentMon");
});
