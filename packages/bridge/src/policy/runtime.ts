// =====================================================================================
// FILE INI: runtime policy = "PENYAMBUNG" antara penangan hook dan policy engine.
// =====================================================================================
//
// Penangan hook (adapters/claude-code-handler.ts) hanya tahu satu pertanyaan: "ada keputusan otomatis untuk aksi ini?".
// Runtime ini menjawabnya dengan memuat aturan dari disk, memanggil `evaluatePolicy`, dan menyiapkan alasan untuk agent bila ditolak.
//
// Prinsip:
//   - Aturan dibaca ULANG di setiap permintaan (dua berkas kecil), jadi mengubah ~/.agentmon/policy.json langsung berlaku tanpa
//     memulai ulang daemon. Aturan di dalam proyek (cwd) dibaca juga, tetapi hanya boleh memperketat (lihat config.ts).
//   - Masalah berkas aturan (rusak, aturan allow dari proyek diabaikan) dicatat di log SEKALI per masalah, dan tampil di `status`.
//   - GAGAL BERARTI TIDAK ADA KEPUTUSAN: galat apa pun mengembalikan `undefined`, sehingga alur izin normal yang jalan.
//     Tidak pernah berubah menjadi "izinkan".
import type { Risk } from "@agentmon/shared";
import { loadPolicy, plainText, repoPolicyPath, userPolicyPath, type PolicyLoad } from "./config";
import { evaluatePolicy, type PolicyDecision } from "./evaluate";

/** Keputusan yang diserahkan ke penangan hook. */
export type AutoPolicyDecision = {
  action: "allow" | "ask" | "deny";
  ruleId: string | null;
  matched: string[];
  risk: Risk;
  why: string;
  /** Alasan untuk agent, hanya ada bila `deny`. */
  reason?: string;
};

export type PolicyInputForHook = { toolName: string; toolInput: Record<string, unknown>; cwd?: string };

/** Yang diminta penangan hook dari policy. */
export type PolicyHook = {
  /** `undefined` = tidak ada pendapat (alur izin normal). Tidak pernah melempar galat. */
  decide(input: PolicyInputForHook, state: { scriptsChanged: boolean }): AutoPolicyDecision | undefined;
};

export type PolicyRuntimeStatus = { rules: number; allow: number; problems: string[] };

export type PolicyRuntime = PolicyHook & { status(): PolicyRuntimeStatus };

type Logger = { info(message: string): void; error(message: string): void };

export type PolicyRuntimeOptions = {
  /** Folder data AgentMon (tempat policy.json pengguna). */
  home: string;
  logger: Logger;
  /** Hanya untuk test. */
  load?: typeof loadPolicy;
  evaluate?: typeof evaluatePolicy;
};

const MAX_SEEN_PROBLEMS = 100;

/** Alasan yang dibaca agent saat aksinya ditolak otomatis: menyebut aturan penyebabnya dan catatan pengguna, tanpa isi dari berkas lain. */
export function denyReason(ruleId: string | null, note: string | undefined): string {
  const who = ruleId ? `aturan "${plainText(ruleId, 80)}"` : "aturan otomatis";
  const extra = note?.trim() ? ` Catatan: ${plainText(note, 300)}` : "";
  return `Ditolak otomatis oleh ${who} di AgentMon (policy milik pengguna).${extra} Jangan coba menyiasati dengan perintah lain yang setara; tanyakan ke pengguna bila aksi ini memang perlu.`;
}

export function createPolicyRuntime(options: PolicyRuntimeOptions): PolicyRuntime {
  const { logger } = options;
  const load = options.load ?? loadPolicy;
  const evaluate = options.evaluate ?? evaluatePolicy;
  const seen = new Set<string>();

  const loadFor = (cwd: string | undefined): PolicyLoad => {
    const loaded = load({ userPath: userPolicyPath(options.home), ...(cwd ? { repoPath: repoPolicyPath(cwd) } : {}) });
    for (const problem of loaded.problems) {
      if (seen.has(problem)) continue;
      if (seen.size >= MAX_SEEN_PROBLEMS) seen.clear();
      seen.add(problem);
      logger.error(`aturan otomatis: ${problem}`);
    }
    return loaded;
  };

  return {
    decide(input, state) {
      try {
        const loaded = loadFor(input.cwd);
        const result: PolicyDecision = evaluate({ toolName: input.toolName, toolInput: input.toolInput, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) }, loaded, { scriptsChanged: state.scriptsChanged });
        const decision: AutoPolicyDecision = { action: result.action, ruleId: result.ruleId, matched: result.matched, risk: result.risk, why: result.why };
        if (result.action === "deny") {
          const rule = loaded.rules.find((r) => r.id === result.ruleId);
          decision.reason = denyReason(result.ruleId, rule?.note);
        }
        return decision;
      } catch (error) {
        // Policy rusak = tidak ada keputusan otomatis. Alur izin normal yang berjalan.
        logger.error(`policy gagal, memakai alur izin normal: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },

    status() {
      try {
        const loaded = loadFor(undefined);
        return { rules: loaded.rules.length, allow: loaded.rules.filter((r) => r.action === "allow").length, problems: loaded.problems };
      } catch (error) {
        return { rules: 0, allow: 0, problems: [`aturan tidak bisa dibaca: ${error instanceof Error ? plainText(error.message) : "galat"}`] };
      }
    },
  };
}
