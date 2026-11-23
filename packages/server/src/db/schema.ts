// =====================================================================================
// FILE INI: skema database = "DENAH LEMARI ARSIP" relay.
// =====================================================================================
//
// Tujuh tabel sesuai PRD §12. Relay hanya menyimpan yang perlu disimpan permanen: siapa saja
// laptop dan HP yang terdaftar, siapa dipasangkan dengan siapa, sesi, dan riwayat event.
// Aturan dan checkpoint TIDAK ada di sini: keduanya hanya di laptop.
//
// Ditulis dengan Drizzle (pustaka yang menerjemahkan kode TypeScript menjadi SQL). Migrasi SQL
// dihasilkan dari file ini oleh `drizzle-kit` dan disimpan di folder `drizzle/`; jangan mengubah
// skema tanpa menghasilkan migrasinya (ada test yang menjaga keduanya tetap sama).
//
// JAMINAN YANG DIJAGA OLEH DATABASE SENDIRI (bukan hanya oleh kode), supaya tetap berlaku walau
// ada bug di kode yang menulisnya:
//   - Token tidak pernah disimpan apa adanya. Kolom token hanya menerima hash SHA-256 (64 karakter
//     heksadesimal); batasan CHECK menolak yang lain, termasuk token mentah yang tak sengaja masuk.
//   - Event unik per laptop: kunci utamanya (laptop, nomor event). Event yang sama tidak tersimpan dua kali.
//   - Menghapus laptop menghapus semua turunannya (pasangan, sesi, event) lewat kunci asing.
import { sql } from "drizzle-orm";
import { bigserial, boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

// Kolom waktu berzona (timestamptz): tidak bergantung pada zona waktu server.
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => time("created_at").notNull().defaultNow();

// Ekspresi SQL: nilai harus berupa hash SHA-256 heksadesimal huruf kecil.
const isHash = (column: AnyPgColumn) => sql`${column} ~ '^[0-9a-f]{64}$'`;

// ---- Laptop (daemon) -------------------------------------------------------------------
export const machines = pgTable(
  "machines",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Hash token, BUKAN token. Token asli hanya diketahui laptop itu sendiri.
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: time("last_seen_at"),
  },
  (t) => [check("machines_token_hash_is_sha256", isHash(t.tokenHash))],
);

// ---- HP (PWA) --------------------------------------------------------------------------
export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    // Kunci publik untuk tanda tangan keputusan (tahap 4). Kosong sampai saat itu.
    publicKey: text("public_key"),
    createdAt: createdAt(),
    // Perangkat yang dicabut tidak dihapus (jejaknya tetap ada), tetapi tidak bisa lagi tersambung.
    revokedAt: time("revoked_at"),
  },
  (t) => [check("devices_token_hash_is_sha256", isHash(t.tokenHash))],
);

// ---- Pemasangan laptop dan HP ----------------------------------------------------------
export const pairings = pgTable(
  "pairings",
  {
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    // Hash kode yang terakhir dipakai untuk memasangkan (atau memasangkan ulang) HP ini ke laptop ini. Laptop memakainya untuk hanya
    // memproses HP dari kode miliknya sendiri.
    codeHash: text("code_hash"),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.deviceId] }), index("pairings_device_idx").on(t.deviceId)],
);

// ---- Bahan pairing E2E dari HP ----------------------------------------------------------
// Kunci publik HP dan bukti rahasia QR (issue #033). Relay hanya MENYIMPAN dan meneruskan ke laptop; ia tidak memercayainya
// (laptop memverifikasi bukti dengan rahasia yang hanya ia dan HP ketahui).
export const deviceE2e = pgTable(
  "device_e2e",
  {
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // Nama yang dipakai HP untuk membuat bukti, per laptop. Bukti dihitung atas nama ini; `devices.name` bisa lebih lama (HP yang sama
    // memasangkan laptop kedua dengan nama baru).
    deviceName: text("device_name").notNull(),
    kxPublicKey: text("kx_public_key").notNull(),
    signPublicKey: text("sign_public_key").notNull(),
    proof: text("proof").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.deviceId] })],
);

// ---- Kotak surat laptop ke HP -----------------------------------------------------------
// Tantangan sidik jari, jawaban pairing, dan kunci data baru (rotasi). Semuanya bertanda tangan laptop dan terikat ke HP penerimanya;
// relay hanya menyimpan dan menyerahkan, sehingga relay yang menahan atau mengganti pesan hanya bisa menimbulkan gangguan.
export const e2eMessages = pgTable(
  "e2e_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // Teks JSON apa adanya (relay tidak mengkueri isinya).
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("e2e_messages_kind_known", sql`${t.kind} in ('challenge', 'response', 'keys')`), index("e2e_messages_device_idx").on(t.machineId, t.deviceId, t.id)],
);

// ---- Kode pairing sekali pakai ---------------------------------------------------------
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    // Yang disimpan hash kodenya, karena kode itu sendiri adalah rahasia sampai dipakai.
    codeHash: text("code_hash").primaryKey(),
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    expiresAt: time("expires_at").notNull(),
    usedAt: time("used_at"),
    createdAt: createdAt(),
  },
  (t) => [check("pairing_codes_code_hash_is_sha256", isHash(t.codeHash)), index("pairing_codes_expires_idx").on(t.expiresAt)],
);

// ---- Sesi agent ------------------------------------------------------------------------
export const sessions = pgTable(
  "sessions",
  {
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    // Nomor sesi dari agent. Hanya unik per laptop, jadi kunci utamanya gabungan.
    sessionId: text("session_id").notNull(),
    agent: text("agent").notNull(),
    status: text("status").notNull().default("active"),
    startedAt: time("started_at").notNull(),
    lastEventAt: time("last_event_at").notNull(),
    endedAt: time("ended_at"),
  },
  (t) => [
    primaryKey({ columns: [t.machineId, t.sessionId] }),
    check("sessions_status_known", sql`${t.status} in ('active', 'ended')`),
    check("sessions_agent_known", sql`${t.agent} in ('claude-code', 'codex')`),
    index("sessions_last_event_idx").on(t.machineId, t.lastEventAt),
  ],
);

// ---- Riwayat event ---------------------------------------------------------------------
export const events = pgTable(
  "events",
  {
    machineId: text("machine_id").notNull(),
    // Nomor unik event dari amplop (UUID). Bersama machineId menjadi kunci utama, sehingga event
    // yang dikirim ulang tidak tersimpan dua kali.
    id: uuid("id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    // Waktu menurut pengirim (bisa saja keliru atau dipalsukan). Retensi memakai `receivedAt`.
    ts: time("ts").notNull(),
    agent: text("agent").notNull(),
    type: text("type").notNull(),
    // Isi event sebagai TEKS JSON, apa adanya. Sampai tahap 3 berupa objek, sejak tahap 4 teks
    // terenkripsi. Sengaja bukan jsonb: relay tidak pernah mengkueri isinya, dan jsonb menolak karakter
    // NUL (\u0000) yang bisa saja ada di isi berkas atau perintah dari agent. Teks JSON menuliskannya
    // sebagai urutan "\u0000" biasa, jadi tersimpan dan terbaca persis sama.
    payload: text("payload").notNull(),
    // Hanya event izin: nomor acak dan tenggat izin di AMPLOP (bukan rahasia), supaya relay bisa menghitung izin yang menunggu dan memberi
    // notifikasi tanpa membuka isi yang terenkripsi.
    approvalId: text("approval_id"),
    expiresAt: time("expires_at"),
    // Waktu relay menerimanya (jam relay, dapat dipercaya). Dasar penghapusan otomatis.
    receivedAt: time("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.machineId, t.id] }),
    foreignKey({ columns: [t.machineId, t.sessionId], foreignColumns: [sessions.machineId, sessions.sessionId] }).onDelete("cascade"),
    check("events_seq_not_negative", sql`${t.seq} >= 0`),
    index("events_session_seq_idx").on(t.machineId, t.sessionId, t.seq),
    index("events_received_idx").on(t.receivedAt),
  ],
);

// ---- Langganan Web Push ----------------------------------------------------------------
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    // Jenis notifikasi yang diinginkan HP ini (FR-33). Bawaan: semua nyala.
    notifyApprovals: boolean("notify_approvals").notNull().default(true),
    notifyDone: boolean("notify_done").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscriptions_device_idx").on(t.deviceId)],
);
