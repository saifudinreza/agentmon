import { PROJECT_NAME } from "@agentmon/shared";

export const name = `${PROJECT_NAME}`;

export * from "./adapters/claude-code";
export * from "./approvals";
export * from "./cli";
export * from "./control";
export * from "./adapters/claude-code-handler";
export * from "./daemon";
export * from "./diff";
export * from "./hook-config";
export * from "./server";
