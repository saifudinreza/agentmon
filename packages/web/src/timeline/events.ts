// =====================================================================================
// FILE INI: menyusun event timeline = "PENJILID" yang merapikan lembaran yang datang acak-acakan.
// =====================================================================================
//
// Event untuk satu sesi bisa tiba dari dua jalur sekaligus (dorongan langsung dan pengambilan riwayat),
// berulang, atau tidak berurutan (jaringan, sambung ulang, HP dikunci lalu dibuka). Penjilid memastikan
// daftar akhirnya: tanpa ganda (menurut `id`), berurutan menurut `seq`, dan lengkap.
//
// `mergeEvents` mengembalikan array YANG SAMA bila tidak ada yang baru, supaya tampilan tidak digambar
// ulang tanpa alasan. Kasus umum (event baru tiba berurutan di ujung) dikerjakan tanpa mengurutkan ulang
// seluruh daftar, supaya sesi dengan ribuan event tetap ringan.
import type { Envelope, SessionSummary } from "@agentmon/shared";

// Urutan utama: nomor urut dari laptop. Bila sama (seharusnya tidak terjadi), cap waktu lalu id, supaya
// hasilnya selalu pasti.
function compare(a: Envelope, b: Envelope): number {
  return a.seq - b.seq || a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id);
}

export function mergeEvents(existing: readonly Envelope[], incoming: readonly Envelope[]): readonly Envelope[] {
  if (incoming.length === 0) return existing;

  const known = new Set(existing.map((e) => e.id));
  const fresh: Envelope[] = [];
  for (const event of incoming) {
    if (known.has(event.id)) continue;
    known.add(event.id); // duplikat di dalam `incoming` sendiri juga dibuang
    fresh.push(event);
  }
  if (fresh.length === 0) return existing;

  fresh.sort(compare);
  const last = existing[existing.length - 1];
  // Jalur cepat: semuanya datang SETELAH yang terakhir, cukup ditempel.
  if (!last || compare(last, fresh[0] as Envelope) < 0) return [...existing, ...fresh];

  // Jalur umum: ada yang menyelip di tengah (datang terlambat). Gabung dua daftar yang sudah terurut.
  const merged: Envelope[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < fresh.length) {
    merged.push(compare(existing[i] as Envelope, fresh[j] as Envelope) <= 0 ? (existing[i++] as Envelope) : (fresh[j++] as Envelope));
  }
  while (i < existing.length) merged.push(existing[i++] as Envelope);
  while (j < fresh.length) merged.push(fresh[j++] as Envelope);
  return merged;
}

/** Nomor urut terbesar yang sudah dimiliki; -1 bila belum ada (mengambil dari awal). */
export function lastSeq(events: readonly Envelope[]): number {
  return events.reduce((max, e) => Math.max(max, e.seq), -1);
}

/**
 * Memperbarui ringkasan sesi berdasarkan satu event, tanpa menunggu daftar sesi diambil ulang:
 * sesi baru muncul di daftar, waktu terakhir maju, dan rekap menandai sesi selesai. Mengembalikan array
 * baru, diurutkan dari yang paling baru aktif.
 */
export function applyEventToSessions(sessions: readonly SessionSummary[], event: Envelope): readonly SessionSummary[] {
  const index = sessions.findIndex((s) => s.sessionId === event.sessionId);
  const current = index >= 0 ? (sessions[index] as SessionSummary) : undefined;
  const isRecap = event.type === "session.recap";

  const next: SessionSummary = current
    ? {
        ...current,
        startedAt: event.ts < current.startedAt ? event.ts : current.startedAt,
        lastEventAt: event.ts > current.lastEventAt ? event.ts : current.lastEventAt,
        ...(isRecap ? { status: "ended" as const, endedAt: event.ts } : {}),
      }
    : {
        sessionId: event.sessionId,
        agent: event.agent,
        status: isRecap ? "ended" : "active",
        startedAt: event.ts,
        lastEventAt: event.ts,
        endedAt: isRecap ? event.ts : null,
      };

  if (current && JSON.stringify(current) === JSON.stringify(next)) return sessions;
  const others = sessions.filter((s) => s.sessionId !== event.sessionId);
  return [...others, next].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt));
}
