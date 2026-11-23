// =====================================================================================
// FILE INI: kunci E2E di HP = "BRANKAS KUNCI" PWA (issue #033; desain di docs/security-e2e.md bagian 4.1 dan 7).
// =====================================================================================
//
// Yang disimpan: identitas HP (kunci tanda tangan Ed25519 dan pertukaran X25519, SATU untuk semua laptop), dan per laptop yang dipasangkan
// secara E2E: kunci publik laptop (dari QR, bukan dari relay), kunci data per `kid`, dan nomor HP ini di relay.
//
// Penyimpanan: satu blob JSON yang dibungkus AES-GCM dengan kunci WebCrypto yang TIDAK DAPAT DIEKSPOR (disimpan di IndexedDB). Itu
// mencegah kunci disalin dari cadangan atau dump penyimpanan; ia TIDAK mencegah pemakaian langsung oleh skrip yang berjalan di halaman
// ini (XSS), karena itu CSP ketat dan tanpa skrip pihak ketiga adalah bagian dari desain (bagian 7).
//
// Semua pembacaan sinkron dari memori (event masuk tidak boleh menunggu disk); penulisan disimpan ke backend lalu baru dianggap berhasil.
// Blob yang rusak TIDAK dianggap kosong dan ditimpa diam-diam: itu akan membuang kunci tanpa kabar. Galatnya jelas (KeyringError).
import { fromB64, phoneSessionKeys, toB64, type Sodium } from "@agentmon/shared/crypto";
import { generateKxKeyPair, generateSignKeyPair } from "@agentmon/shared/crypto";
import { z } from "zod";

const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(512);
const keyPair = z.strictObject({ publicKey: b64, privateKey: b64 });
const MachineSchema = z.strictObject({
  relayUrl: z.string().min(1),
  /** Nomor HP ini di relay itu (dari jawaban pairing yang DITANDATANGANI laptop). */
  deviceId: z.string().min(1),
  laptopSignPublicKey: b64,
  laptopKxPublicKey: b64,
  /** Kunci data terbaru yang dikenal. Event baru dengan kid lebih rendah ditolak. */
  kid: z.int().min(1),
  dataKeys: z.record(z.string().regex(/^[1-9][0-9]*$/), b64),
});
const StoredSchema = z.strictObject({
  v: z.literal(1),
  phone: z.strictObject({ sign: keyPair, kx: keyPair }).optional(),
  machines: z.record(z.string().min(1).max(200), MachineSchema),
});
type Stored = z.infer<typeof StoredSchema>;

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

export type KeyBackend = {
  /** Isi yang tersimpan (teks JSON), atau undefined bila belum ada. */
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
};

export type PhoneKeys = { sign: { publicKey: Uint8Array; privateKey: Uint8Array }; kx: { publicKey: Uint8Array; privateKey: Uint8Array } };

export type MachineKeys = {
  machineId: string;
  relayUrl: string;
  deviceId: string;
  laptopSignPublicKey: Uint8Array;
  laptopKxPublicKey: Uint8Array;
  kid: number;
  dataKeys: Map<number, Uint8Array>;
  /** Kunci pasangan: `rx` = laptop ke HP (membuka balasan), `tx` = HP ke laptop (menutup perintah). Diturunkan, tidak disimpan. */
  rx: Uint8Array;
  tx: Uint8Array;
};

export type Keyring = {
  phone(): PhoneKeys | undefined;
  /** Identitas HP; dibuat sekali bila belum ada. */
  ensurePhone(): Promise<PhoneKeys>;
  machine(machineId: string): MachineKeys | undefined;
  /** True bila laptop ini dipasangkan secara E2E: event polos darinya DITOLAK (penurunan versi tidak boleh). */
  secured(machineId: string): boolean;
  anySecured(): boolean;
  /** Menyimpan (atau memperbarui) laptop yang baru dipasangkan. */
  saveMachine(input: { machineId: string; relayUrl: string; deviceId: string; laptopSignPublicKey: Uint8Array; laptopKxPublicKey: Uint8Array; kid: number; dataKey: Uint8Array }): Promise<MachineKeys>;
  /** Menambah kunci data baru (rotasi) untuk laptop yang sudah dipasangkan. kid harus lebih tinggi dari yang terakhir. */
  addDataKey(machineId: string, kid: number, dataKey: Uint8Array): Promise<boolean>;
  removeMachine(machineId: string): Promise<void>;
};

/** Membuka brankas dari backend. Melempar `KeyringError` bila isinya rusak (tidak pernah mengosongkannya diam-diam). */
export async function openKeyring(s: Sodium, backend: KeyBackend): Promise<Keyring> {
  let stored: Stored = { v: 1, machines: {} };
  const raw = await backend.read();
  if (raw !== undefined) {
    let parsed: z.ZodSafeParseResult<Stored>;
    try {
      parsed = StoredSchema.safeParse(JSON.parse(raw));
    } catch {
      throw new KeyringError("Brankas kunci rusak.");
    }
    if (!parsed.success) throw new KeyringError("Brankas kunci tidak dikenali.");
    stored = parsed.data;
  }

  let phone: PhoneKeys | undefined;
  const machines = new Map<string, MachineKeys>();

  const decodePhone = (p: NonNullable<Stored["phone"]>): PhoneKeys => ({
    sign: { publicKey: fromB64(s, p.sign.publicKey), privateKey: fromB64(s, p.sign.privateKey) },
    kx: { publicKey: fromB64(s, p.kx.publicKey), privateKey: fromB64(s, p.kx.privateKey) },
  });
  const build = (machineId: string, m: Stored["machines"][string], keys: PhoneKeys): MachineKeys => {
    const dataKeys = new Map<number, Uint8Array>(Object.entries(m.dataKeys).map(([kid, key]) => [Number(kid), fromB64(s, key)]));
    if (!dataKeys.has(m.kid)) throw new KeyringError("Brankas kunci tidak lengkap.");
    const laptopKx = fromB64(s, m.laptopKxPublicKey);
    const session = phoneSessionKeys(s, keys.kx, laptopKx);
    return { machineId, relayUrl: m.relayUrl, deviceId: m.deviceId, laptopSignPublicKey: fromB64(s, m.laptopSignPublicKey), laptopKxPublicKey: laptopKx, kid: m.kid, dataKeys, rx: session.rx, tx: session.tx };
  };

  try {
    if (stored.phone) phone = decodePhone(stored.phone);
    if (Object.keys(stored.machines).length > 0 && !phone) throw new KeyringError("Brankas kunci tidak lengkap.");
    for (const [id, m] of Object.entries(stored.machines)) machines.set(id, build(id, m, phone!));
  } catch (error) {
    if (error instanceof KeyringError) throw error;
    throw new KeyringError("Brankas kunci rusak.");
  }

  const persist = async () => {
    const out: Stored = {
      v: 1,
      ...(phone ? { phone: { sign: { publicKey: toB64(s, phone.sign.publicKey), privateKey: toB64(s, phone.sign.privateKey) }, kx: { publicKey: toB64(s, phone.kx.publicKey), privateKey: toB64(s, phone.kx.privateKey) } } } : {}),
      machines: Object.fromEntries(
        [...machines.entries()].map(([id, m]) => [
          id,
          {
            relayUrl: m.relayUrl,
            deviceId: m.deviceId,
            laptopSignPublicKey: toB64(s, m.laptopSignPublicKey),
            laptopKxPublicKey: toB64(s, m.laptopKxPublicKey),
            kid: m.kid,
            dataKeys: Object.fromEntries([...m.dataKeys.entries()].map(([kid, key]) => [String(kid), toB64(s, key)])),
          },
        ]),
      ),
    };
    await backend.write(JSON.stringify(StoredSchema.parse(out)));
  };

  return {
    phone: () => phone,
    async ensurePhone() {
      if (phone) return phone;
      const created: PhoneKeys = { sign: generateSignKeyPair(s), kx: generateKxKeyPair(s) };
      phone = created;
      try {
        await persist();
      } catch (error) {
        phone = undefined; // tidak tersimpan = tidak ada: jangan memakai identitas yang hilang saat aplikasi ditutup
        throw error;
      }
      return created;
    },
    machine: (machineId) => machines.get(machineId),
    secured: (machineId) => machines.has(machineId),
    anySecured: () => machines.size > 0,
    async saveMachine(input) {
      if (!phone) throw new KeyringError("Identitas HP belum dibuat.");
      const session = phoneSessionKeys(s, phone.kx, input.laptopKxPublicKey);
      const previous = machines.get(input.machineId);
      const record: MachineKeys = {
        machineId: input.machineId,
        relayUrl: input.relayUrl,
        deviceId: input.deviceId,
        laptopSignPublicKey: input.laptopSignPublicKey,
        laptopKxPublicKey: input.laptopKxPublicKey,
        kid: input.kid,
        // Memasangkan ulang laptop yang sama dengan kunci laptop BERBEDA berarti riwayat lama tidak relevan; kunci yang sama mempertahankan yang lama.
        dataKeys: new Map([...(previous && toB64(s, previous.laptopSignPublicKey) === toB64(s, input.laptopSignPublicKey) ? previous.dataKeys.entries() : []), [input.kid, input.dataKey]]),
        rx: session.rx,
        tx: session.tx,
      };
      machines.set(input.machineId, record);
      try {
        await persist();
      } catch (error) {
        if (previous) machines.set(input.machineId, previous);
        else machines.delete(input.machineId);
        throw error;
      }
      return record;
    },
    async addDataKey(machineId, kid, dataKey) {
      const m = machines.get(machineId);
      if (!m || !Number.isSafeInteger(kid) || kid <= m.kid) return false;
      const updated: MachineKeys = { ...m, kid, dataKeys: new Map([...m.dataKeys.entries(), [kid, dataKey]]) };
      machines.set(machineId, updated);
      try {
        await persist();
      } catch (error) {
        machines.set(machineId, m);
        throw error;
      }
      return true;
    },
    async removeMachine(machineId) {
      const previous = machines.get(machineId);
      if (!previous) return;
      machines.delete(machineId);
      try {
        await persist();
      } catch (error) {
        machines.set(machineId, previous);
        throw error;
      }
    },
  };
}

// ---- Backend ----
/** Untuk tes: menyimpan di memori. */
export function memoryBackend(initial?: string): KeyBackend & { value(): string | undefined } {
  let value = initial;
  return {
    read: async () => value,
    write: async (text) => {
      value = text;
    },
    value: () => value,
  };
}

const DB_NAME = "agentmon-e2e";
const STORE = "kv";
const WRAP_KEY = "wrap-key";
const BLOB = "blob";

type Wrapped = { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> };

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB gagal"));
  });
}

/**
 * Backend nyata: IndexedDB, isinya dibungkus AES-GCM dengan kunci WebCrypto yang tidak dapat diekspor. Kunci pembungkus dibuat sekali.
 * `factory` hanya untuk tes (fake-indexeddb).
 */
export function indexedDbBackend(factory: IDBFactory = indexedDB, subtle: SubtleCrypto = crypto.subtle): KeyBackend {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB gagal dibuka"));
    });
  const store = (db: IDBDatabase, mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);

  async function wrapKey(db: IDBDatabase, create: boolean): Promise<CryptoKey | undefined> {
    const existing = (await request(store(db, "readonly").get(WRAP_KEY))) as CryptoKey | undefined;
    if (existing || !create) return existing;
    const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await request(store(db, "readwrite").put(key, WRAP_KEY));
    return key;
  }

  return {
    async read() {
      const db = await open();
      try {
        const wrapped = (await request(store(db, "readonly").get(BLOB))) as Wrapped | undefined;
        if (wrapped === undefined) return undefined;
        const key = await wrapKey(db, false);
        if (!key) throw new KeyringError("Kunci pembungkus brankas hilang.");
        try {
          return new TextDecoder().decode(await subtle.decrypt({ name: "AES-GCM", iv: wrapped.iv }, key, wrapped.ct));
        } catch {
          throw new KeyringError("Brankas kunci tidak bisa dibuka.");
        }
      } finally {
        db.close();
      }
    },
    async write(text) {
      const db = await open();
      try {
        const key = (await wrapKey(db, true))!;
        const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
        const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
        await request(store(db, "readwrite").put({ iv, ct } satisfies Wrapped, BLOB));
      } finally {
        db.close();
      }
    },
  };
}
