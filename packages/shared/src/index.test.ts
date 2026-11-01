import { expect, test } from "vitest";
import { PROJECT_NAME } from "./index";

test("shared mengekspor nama proyek", () => {
  expect(PROJECT_NAME).toBe("AgentMon");
});
