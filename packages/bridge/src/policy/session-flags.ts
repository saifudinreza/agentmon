// =====================================================================================
// FILE INI: catatan "sesi ini sudah mengubah proyek" = dasar `scriptsChanged` di policy (PRD §9 aturan 4).
// =====================================================================================
//
// Tujuannya: agent tidak boleh mengedit berkas tes lalu menjalankannya (`npm test`) tanpa pengguna tahu. Karena itu catatan ini
// HARUS tahan terhadap hal-hal yang membuat ingatan biasa hilang:
//   - daemon dimulai ulang (crash lalu dinyalakan lagi oleh autostart, atau laptop dihidupkan ulang),
//   - sesi yang sama dilanjutkan setelah SessionEnd (resume),
//   - banyak sesi lain yang mendepak catatan.
// Maka disimpan di disk (batasan jumlah dan umur), dan GAGAL TERTUTUP: bila berkasnya ada tetapi rusak atau tidak terbaca, semua sesi
// dianggap SUDAH mengubah proyek (lebih banyak pertanyaan, tidak pernah kurang). Id sesi yang bentuknya aneh juga dianggap sudah mengubah.
//
// Yang TIDAK tercakup (dinyatakan terang di docs/policy.md): perubahan yang sudah ada di working tree sebelum sesi ini mulai
// (mis. dibuat sesi sebelumnya yang disetujui pengguna), dan perubahan yang terjadi saat daemon mati.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SessionFlags = {
  isMutated(sessionId: string): boolean;
  markMutated(sessionId: string): void;
};

const VALID_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/** Dalam memori saja (bawaan di test). Pembatasan jumlah: yang paling lama dilupakan DIANGGAP BELUM mengubah, jadi untuk produksi pakai versi disk. */
export function createMemorySessionFlags(max = 5000): SessionFlags {
  const flags = new Set<string>();
  return {
    isMutated: (id) => !VALID_ID.test(id) || flags.has(id),
    markMutated(id) {
      if (!VALID_ID.test(id)) return;
      flags.delete(id);
      flags.add(id);
      if (flags.size > max) {
        const oldest = flags.values().next().value;
        if (oldest !== undefined) flags.delete(oldest);
      }
    },
  };
}

export type FileSessionFlagsOptions = {
  file: string;
  now?: () => number;
  /** Berapa sesi yang diingat (paling baru). */
  max?: number;
  /** Umur catatan (milidetik). Bawaan 14 hari. */
  ttlMs?: number;
  logger?: { error(message: string): void };
};

export const DEFAULT_FLAG_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Disimpan di disk: `{ v: 1, mutated: { [sessionId]: waktuTerakhir } }`. */
export function createFileSessionFlags(options: FileSessionFlagsOptions): SessionFlags {
  const now = options.now ?? Date.now;
  const max = options.max ?? 2000;
  const ttlMs = options.ttlMs ?? DEFAULT_FLAG_TTL_MS;
  let state: Map<string, number> | undefined;
  let unreliable = false;

  const load = (): Map<string, number> => {
    if (state) return state;
    state = new Map();
    if (!existsSync(options.file)) return state;
    try {
      const parsed = JSON.parse(readFileSync(options.file, "utf8")) as { v?: unknown; mutated?: unknown };
      if (parsed.v !== 1 || typeof parsed.mutated !== "object" || parsed.mutated === null || Array.isArray(parsed.mutated)) throw new Error("bentuk tidak dikenal");
      for (const [id, at] of Object.entries(parsed.mutated)) if (VALID_ID.test(id) && typeof at === "number" && Number.isFinite(at)) state.set(id, at);
    } catch (error) {
      // Berkas ada tetapi tidak bisa dipercaya: kehilangan catatan berarti `npm test` bisa lolos padahal berkas sudah diubah.
      unreliable = true;
      options.logger?.error(`catatan sesi (${options.file}) rusak atau tidak terbaca, semua sesi dianggap sudah mengubah proyek: ${error instanceof Error ? error.message : String(error)}`);
    }
    return state;
  };

  const save = (map: Map<string, number>) => {
    const entries = [...map.entries()].filter(([, at]) => now() - at <= ttlMs).sort((a, b) => a[1] - b[1]).slice(-max);
    map.clear();
    for (const [id, at] of entries) map.set(id, at);
    const temp = `${options.file}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify({ v: 1, mutated: Object.fromEntries(entries) }), { mode: 0o600 });
      try {
        chmodSync(temp, 0o600);
      } catch {
        /* Windows */
      }
      renameSync(temp, options.file);
      unreliable = false; // berkas baru yang sah menggantikan yang rusak
    } catch (error) {
      options.logger?.error(`catatan sesi tidak bisa disimpan: ${error instanceof Error ? error.message : String(error)}`);
      try {
        unlinkSync(temp);
      } catch {
        /* tidak ada */
      }
    }
  };

  return {
    isMutated(id) {
      if (!VALID_ID.test(id)) return true;
      const map = load();
      if (unreliable) return true;
      const at = map.get(id);
      return at !== undefined && now() - at <= ttlMs;
    },
    markMutated(id) {
      if (!VALID_ID.test(id)) return;
      const map = load();
      const had = map.get(id);
      // Tidak menulis ulang disk untuk setiap hook: cukup bila belum tercatat, atau catatannya sudah lebih dari sehari.
      if (had !== undefined && now() - had < 24 * 60 * 60 * 1000 && !unreliable) return;
      map.set(id, now());
      save(map);
    },
  };
}
