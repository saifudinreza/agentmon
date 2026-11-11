// =====================================================================================
// FILE INI: bentuk jawaban API baca untuk HP = "DAFTAR ISI" riwayat di relay.
// =====================================================================================
//
// HP tidak hanya menerima event secara langsung (WebSocket); ia juga perlu MEMBACA riwayat:
//   - saat aplikasi pertama dibuka (belum ada apa pun di layar),
//   - saat koneksi putus lalu pulih, atau HP dikunci lalu dibuka lagi (mengambil yang terlewat).
// API ini menjawab pertanyaan itu: laptop mana yang terpasang, sesi apa saja, dan event sesi tertentu
// mulai dari nomor urut tertentu. Hanya HP yang dipasangkan dengan sebuah laptop yang boleh membaca
// riwayatnya.
import { z } from "zod";
import { AgentSchema, EnvelopeSchema } from "./events";

const isoDate = z.iso.datetime({ offset: true });

export const DeviceMachineSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Laptop sedang tersambung ke relay saat ini. */
  online: z.boolean(),
});
export type DeviceMachine = z.infer<typeof DeviceMachineSchema>;
export const MachinesResponseSchema = z.object({ machines: z.array(DeviceMachineSchema) });

export const SessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  agent: AgentSchema,
  status: z.enum(["active", "ended"]),
  startedAt: isoDate,
  lastEventAt: isoDate,
  endedAt: isoDate.nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionsResponseSchema = z.object({ sessions: z.array(SessionSummarySchema) });

export const EventsResponseSchema = z.object({
  events: z.array(EnvelopeSchema),
  /** Masih ada event berikutnya setelah halaman ini: ambil lagi dengan `afterSeq` terbesar yang diterima. */
  hasMore: z.boolean(),
});
export type EventsResponse = z.infer<typeof EventsResponseSchema>;
