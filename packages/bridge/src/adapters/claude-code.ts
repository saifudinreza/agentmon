// Adapter Claude Code: mengubah input hook MENTAH dari Claude Code menjadi bahasa baku
// AgentMon (kontrak di paket shared).
//
// Kenapa perlu: Claude Code punya istilah sendiri (PreToolUse, tool_input, session_id,
// dan seterusnya). Kalau inti daemon memakai istilah itu langsung, nanti Codex yang punya
// istilah lain tidak bisa ikut tanpa membongkar inti. Dengan adapter, hanya file di folder
// ini yang tahu soal Claude Code; sisanya cukup memahami event baku. Adapter Codex nanti
// dibuat dengan pola yang sama.
//
// File ini FUNGSI MURNI: tidak membaca berkas, tidak memakai jaringan, tidak memegang
// keadaan. Identitas event (id, urutan, waktu) diberikan dari luar, jadi hasilnya mudah
// dites dengan fixture.
import { CONTRACT_VERSION, eventPayloads, parseEvent, type AgentMonEvent, type EventType } from "@agentmon/shared";
import type { HookInput } from "../server";

// Identitas yang menempel pada setiap event: nomor unik, urutan dalam sesi, dan waktu.
export type Stamp = {
  machineId: string;
  id: string;
  seq: number;
  ts: string;
};

// Permintaan izin dari event PermissionRequest, dalam bentuk netral. Ini BUKAN event
// kontrak, karena `approval.requested` butuh nomor persetujuan dan batas waktu yang baru
// dibuat oleh approval engine (issue 007).
export type PermissionRequestInfo = {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
  permissionMode?: string;
};

// Hasil pemetaan: tepat salah satu dari enam bentuk, dibedakan oleh kolom `status`.
export type ClaudeMapResult =
  // Event kontrak yang siap dikirim, lengkap dengan amplop.
  | { status: "event"; event: AgentMonEvent }
  // Agent meminta izin. Diteruskan ke approval engine, belum menjadi event.
  | { status: "permission_request"; request: PermissionRequestInfo }
  // Sesi selesai. Kontrak tidak punya event "sesi berakhir" sendiri; rekap (`session.recap`)
  // dihitung dari catatan sesi di issue lain, jadi di sini hanya penanda.
  | { status: "session_ended"; sessionId: string; reason: string }
  // Event dikenal tetapi sengaja tidak dipakai (UserPromptSubmit berisi teks perintahmu).
  | { status: "ignored"; hookEvent: string }
  // Nama event tidak dikenal (misalnya Claude Code versi baru). Dicatat, bukan error.
  | { status: "unknown"; hookEvent: string }
  // Event dikenal tetapi isinya tidak lengkap atau bentuknya salah.
  | { status: "invalid"; hookEvent: string; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Teks tidak kosong, atau undefined.
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// Kolom yang nilainya kosong tidak ikut ditulis, supaya payload bersih.
function compact<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

type Built = { type: EventType; payload: Record<string, unknown> } | { problem: string };

// Menyusun type dan payload untuk event yang menjadi event kontrak.
function buildEvent(name: string, input: HookInput): Built | undefined {
  switch (name) {
    case "SessionStart": {
      const cwd = text(input.cwd);
      if (!cwd) return { problem: "cwd kosong" };
      return { type: "session.started", payload: compact({ cwd, permissionMode: text(input.permission_mode) }) };
    }
    case "PreToolUse": {
      const toolName = text(input.tool_name);
      if (!toolName) return { problem: "tool_name kosong" };
      // Alat tanpa argumen bisa datang tanpa tool_input sama sekali: dianggap objek kosong.
      const toolInput = input.tool_input === undefined ? {} : input.tool_input;
      if (!isRecord(toolInput)) return { problem: "tool_input bukan objek" };
      return { type: "tool.requested", payload: compact({ toolName, toolInput, toolUseId: text(input.tool_use_id) }) };
    }
    case "PostToolUse": {
      const toolName = text(input.tool_name);
      if (!toolName) return { problem: "tool_name kosong" };
      // PostToolUse hanya muncul bila alat berhasil dijalankan (kegagalan alat adalah event
      // lain yang belum kita pasang). Satu-satunya tanda gagal di sini adalah perintah
      // yang dihentikan di tengah jalan (`interrupted`).
      const response = isRecord(input.tool_response) ? input.tool_response : {};
      const ok = response.interrupted !== true;
      return { type: "tool.completed", payload: compact({ toolName, toolUseId: text(input.tool_use_id), ok }) };
    }
    case "Notification": {
      const message = text(input.message);
      if (!message) return { problem: "message kosong" };
      return { type: "agent.notification", payload: compact({ message, title: text(input.title) }) };
    }
    case "Stop":
      return { type: "agent.stopped", payload: compact({ lastMessage: text(input.last_assistant_message) }) };
    default:
      return undefined;
  }
}

/**
 * Memetakan satu input hook Claude Code.
 *
 * `stampFor` dipanggil HANYA bila hasilnya event, dan hanya setelah isinya terbukti sah.
 * Dengan begitu nomor urut sesi tidak terpakai sia-sia oleh data yang ditolak, dan relay
 * tidak mengira ada pesan yang hilang.
 *
 * Tidak pernah melempar error: data aneh dikembalikan sebagai "invalid".
 */
export function mapClaudeCodeHook(input: HookInput, stampFor: (sessionId: string) => Stamp): ClaudeMapResult {
  const hookEvent = input.hook_event_name;

  // Sengaja tidak dipakai: isinya teks perintah pengguna dan tidak ada event kontrak
  // yang membutuhkannya (lihat hook-config.ts).
  if (hookEvent === "UserPromptSubmit") return { status: "ignored", hookEvent };

  const known = ["SessionStart", "PreToolUse", "PostToolUse", "Notification", "Stop", "PermissionRequest", "SessionEnd"];
  if (!known.includes(hookEvent)) return { status: "unknown", hookEvent };

  const sessionId = text(input.session_id);
  if (!sessionId) return { status: "invalid", hookEvent, message: "session_id kosong" };

  if (hookEvent === "SessionEnd") {
    return { status: "session_ended", sessionId, reason: text(input.reason) ?? "unknown" };
  }

  if (hookEvent === "PermissionRequest") {
    const toolName = text(input.tool_name);
    if (!toolName) return { status: "invalid", hookEvent, message: "tool_name kosong" };
    const toolInput = input.tool_input === undefined ? {} : input.tool_input;
    if (!isRecord(toolInput)) return { status: "invalid", hookEvent, message: "tool_input bukan objek" };
    return {
      status: "permission_request",
      request: compact({
        sessionId,
        toolName,
        toolInput,
        cwd: text(input.cwd),
        permissionMode: text(input.permission_mode),
      }),
    };
  }

  const built = buildEvent(hookEvent, input);
  if (!built) return { status: "unknown", hookEvent };
  if ("problem" in built) return { status: "invalid", hookEvent, message: built.problem };

  // Periksa isi lebih dulu (tanpa memakai nomor urut), baru beri identitas.
  const payloadCheck = eventPayloads[built.type].safeParse(built.payload);
  if (!payloadCheck.success) {
    return { status: "invalid", hookEvent, message: `isi tidak sesuai kontrak untuk ${built.type}` };
  }

  const stamp = stampFor(sessionId);
  const parsed = parseEvent({
    v: CONTRACT_VERSION,
    id: stamp.id,
    machineId: stamp.machineId,
    sessionId,
    seq: stamp.seq,
    ts: stamp.ts,
    agent: "claude-code",
    type: built.type,
    payload: built.payload,
  });
  if (parsed.status !== "ok") {
    return { status: "invalid", hookEvent, message: `event ditolak kontrak: ${parsed.status}` };
  }
  return { status: "event", event: parsed.event };
}
