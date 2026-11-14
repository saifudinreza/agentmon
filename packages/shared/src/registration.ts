// =====================================================================================
// FILE INI: bentuk data PENDAFTARAN LAPTOP ke relay = "FORMULIR ANGGOTA BARU" yang hanya bisa diisi pemilik relay.
// =====================================================================================
//
// Pairing HP mengandaikan laptop sudah punya baris dan token di relay. Pendaftaran inilah yang membuatnya:
// laptop mengirim nomor dan namanya, relay membuat token acak, menyimpan HASH-nya saja, dan memberikan token
// itu SEKALI. Setelah itu token hanya ada di laptop.
//
// NOMOR LAPTOP = nomor yang dipakai daemon di setiap event (UUID dari berkas machine-id). Relay menolak event
// yang nomornya berbeda dari identitas koneksi, jadi pendaftaran harus memakai nomor yang sama.
import { z } from "zod";
import { CONTROL_CHARACTERS } from "./pairing";

// Bentuk UUID standar (8-4-4-4-12 karakter heksadesimal), sama dengan yang dibuat daemon untuk machine-id.
export const MACHINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Token laptop: 256 bit acak sebagai 64 karakter heksadesimal huruf kecil.
export const MACHINE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const MachineRegisterRequestSchema = z.object({
  id: z.string().regex(MACHINE_ID_PATTERN),
  // Nama yang tampil di daftar laptop di HP. Tanpa karakter kontrol: dicetak di terminal dan di layar HP.
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((name) => !CONTROL_CHARACTERS.test(name), "Nama tidak boleh memuat karakter kontrol"),
  // Mengganti token laptop yang SUDAH terdaftar (token hilang atau bocor). Tanpa ini, nomor yang sudah ada ditolak,
  // supaya mendaftar dua kali tidak diam-diam memutus laptop yang sedang berjalan.
  rotate: z.boolean().optional(),
});
export type MachineRegisterRequest = z.infer<typeof MachineRegisterRequestSchema>;

export const MachineRegisterResponseSchema = z.object({
  machineId: z.string().regex(MACHINE_ID_PATTERN),
  token: z.string().regex(MACHINE_TOKEN_PATTERN),
});
export type MachineRegisterResponse = z.infer<typeof MachineRegisterResponseSchema>;
