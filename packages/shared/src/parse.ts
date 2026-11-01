import type { z } from "zod";
import {
  CONTRACT_VERSION,
  EnvelopeSchema,
  EVENT_TYPES,
  EventSchema,
  type AgentMonEvent,
  type Envelope,
} from "./events";

export type ParseFailureReason =
  | "malformed_envelope"
  | "unsupported_version"
  | "invalid_payload";

export type ParseResult =
  | { status: "ok"; event: AgentMonEvent }
  // Amplop valid, tapi jenis event belum dikenal (misalnya dari versi lebih baru).
  // Pemanggil sebaiknya mencatat dan mengabaikannya, bukan crash.
  | { status: "unknown_type"; type: string; envelope: Envelope }
  | { status: "invalid"; reason: ParseFailureReason; message: string };

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".") || "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function isKnownEventType(type: string): boolean {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

function versionOf(input: unknown): unknown {
  return typeof input === "object" && input !== null
    ? (input as { v?: unknown }).v
    : undefined;
}

// Tidak pernah melempar error: semua masalah dikembalikan sebagai hasil.
export function parseEvent(input: unknown): ParseResult {
  const base = EnvelopeSchema.safeParse(input);
  if (!base.success) {
    const v = versionOf(input);
    if (typeof v === "number" && v !== CONTRACT_VERSION) {
      return {
        status: "invalid",
        reason: "unsupported_version",
        message: `versi kontrak ${v} tidak didukung (yang didukung: ${CONTRACT_VERSION})`,
      };
    }
    return {
      status: "invalid",
      reason: "malformed_envelope",
      message: formatIssues(base.error),
    };
  }

  if (!isKnownEventType(base.data.type)) {
    return { status: "unknown_type", type: base.data.type, envelope: base.data };
  }

  const parsed = EventSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: "invalid_payload",
      message: formatIssues(parsed.error),
    };
  }
  return { status: "ok", event: parsed.data };
}
