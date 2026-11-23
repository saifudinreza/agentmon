// =====================================================================================
// FILE INI: bentuk data pairing E2E di jalur laptop, relay, dan HP (issue #033; desain di docs/security-e2e.md bagian 4.2).
// =====================================================================================
//
// Di sini hanya BENTUK (zod), tanpa kripto: relay memakai file ini untuk menyimpan dan meneruskan, laptop dan HP memakai
// pustaka `@agentmon/shared/crypto` untuk mengisi dan memeriksanya. Semua byte dibawa sebagai base64 aman-URL tanpa padding.
// Relay tidak pernah memercayai isinya; keaslian dijaga tanda tangan laptop dan bukti rahasia QR.
import { z } from "zod";

// Base64 aman-URL tanpa padding. Panjang dibatasi supaya kiriman raksasa ditolak sebelum diproses.
const b64 = (max: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(max);

/** Bahan pairing dari HP: dua kunci publik dan bukti bahwa HP memegang rahasia QR. */
export const E2ePairingMaterialSchema = z.strictObject({
  /** Kunci publik X25519 HP (32 byte). */
  kx: b64(64),
  /** Kunci publik Ed25519 HP (32 byte). */
  sign: b64(64),
  /** Bukti `crypto_auth` (32 byte) atas permintaan pairing. */
  proof: b64(64),
});
export type E2ePairingMaterial = z.infer<typeof E2ePairingMaterialSchema>;

/** Pesan dari laptop ke HP yang dititipkan di relay (kotak surat). */
export const E2E_MESSAGE_KINDS = ["challenge", "response", "keys"] as const;
export const E2eMessageKindSchema = z.enum(E2E_MESSAGE_KINDS);
export type E2eMessageKind = z.infer<typeof E2eMessageKindSchema>;

/** Tantangan acak laptop untuk sidik jari, bertanda tangan laptop dan terikat ke permintaan HP. */
export const E2eChallengeBodySchema = z.strictObject({ r: b64(64), sig: b64(128) });
export type E2eChallengeBody = z.infer<typeof E2eChallengeBodySchema>;

const wrappedKey = z.strictObject({ n: b64(64), c: b64(256) });

/** Jawaban laptop atas pairing: kunci data terbungkus untuk HP itu, bertanda tangan laptop. */
export const E2eResponseBodySchema = z.strictObject({
  deviceId: z.string().min(1).max(200),
  machineName: z.string().max(200),
  /** Kunci publik X25519 laptop. */
  laptopKx: b64(64),
  kid: z.int().min(1),
  wrapped: wrappedKey,
  sig: b64(128),
});
export type E2eResponseBody = z.infer<typeof E2eResponseBodySchema>;

/** Kunci data baru (rotasi) untuk satu HP, bertanda tangan laptop. Dipakai saat ada perangkat dicabut. */
export const E2eKeysBodySchema = z.strictObject({
  kid: z.int().min(1),
  wrapped: wrappedKey,
  sig: b64(128),
});
export type E2eKeysBody = z.infer<typeof E2eKeysBodySchema>;

/** Laptop menitipkan satu pesan untuk satu HP. */
export const PostE2eMessageSchema = z.strictObject({
  deviceId: z.string().min(1).max(200),
  kind: E2eMessageKindSchema,
  body: z.record(z.string(), z.unknown()),
});
export type PostE2eMessage = z.infer<typeof PostE2eMessageSchema>;

/** Pesan yang dibaca HP. `id` naik terus: HP meminta yang lebih baru dari `id` terakhir yang ia lihat. */
export const E2eMessageSchema = z.object({ id: z.int().min(1), kind: E2eMessageKindSchema, body: z.record(z.string(), z.unknown()) });
export type E2eMessage = z.infer<typeof E2eMessageSchema>;
export const E2eMessagesResponseSchema = z.object({ messages: z.array(E2eMessageSchema) });
export type E2eMessagesResponse = z.infer<typeof E2eMessagesResponseSchema>;
