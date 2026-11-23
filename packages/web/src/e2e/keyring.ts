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
// Semua pembacaan sinkron dari memori (event masuk tidak boleh menunggu disk). SETIAP perubahan adalah baca-ubah-tulis DI DALAM kunci antar-tab
// (Web Locks): isi terbaru dibaca dari penyimpanan, diubah, ditulis, dan baru setelah berhasil ditulis memori diperbarui. Dua tab tidak saling
// menimpa (tab lama tidak menghapus laptop yang baru dipasangkan tab lain atau mengganti identitas HP), dan gagal menulis tidak meninggalkan
// kunci yang hanya ada di memori. Blob yang rusak TIDAK dianggap kosong dan ditimpa diam-diam: itu akan membuang kunci tanpa kabar (KeyringError).
import { fromB64, generateKxKeyPair, generateSignKeyPair, phoneSessionKeys, toB64, type Sodium } from "@agentmon/shared/crypto";
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
  /** Identitas HP; dibuat sekali bila belum ada (di dalam kunci: bila tab lain sudah membuatnya, identitas itulah yang dipakai). */
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
  /** Membaca ulang dari penyimpanan (mis. tab lain baru memasangkan laptop). */
  reload(): Promise<void>;
};

/** Menjalankan `fn` dengan kunci antar-tab. Tanpa Web Locks (peramban lama, tes), langsung dijalankan. */
export type LockRunner = <T>(fn: () => Promise<T>) => Promise<T>;

const webLocks: LockRunner = (fn) => {
  const locks = (globalThis as { navigator?: { locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> } } }).navigator?.locks;
  return locks ? locks.request("agentmon-e2e-keyring", fn) : fn();
};

/** Membuka brankas dari backend. Melempar `KeyringError` bila isinya rusak (tidak pernah mengosongkannya diam-diam). */
export async function openKeyring(s: Sodium, backend: KeyBackend, runLocked: LockRunner = webLocks): Promise<Keyring> {
  let phone: PhoneKeys | undefined;
  const machines = new Map<string, MachineKeys>();

  async function readStored(): Promise<Stored> {
    const raw = await backend.read();
    if (raw === undefined) return { v: 1, machines: {} };
    let parsed: z.ZodSafeParseResult<Stored>;
    try {
      parsed = StoredSchema.safeParse(JSON.parse(raw));
    } catch {
      throw new KeyringError("Brankas kunci rusak.");
    }
    if (!parsed.success) throw new KeyringError("Brankas kunci tidak dikenali.");
    return parsed.data;
  }

  // Membangun keadaan dari isi tersimpan TANPA menyentuh memori. Melempar KeyringError bila isinya tidak bisa dipakai.
  function build(stored: Stored): { phone: PhoneKeys | undefined; machines: Map<string, MachineKeys> } {
    try {
      const nextPhone: PhoneKeys | undefined = stored.phone
        ? {
            sign: { publicKey: fromB64(s, stored.phone.sign.publicKey), privateKey: fromB64(s, stored.phone.sign.privateKey) },
            kx: { publicKey: fromB64(s, stored.phone.kx.publicKey), privateKey: fromB64(s, stored.phone.kx.privateKey) },
          }
        : undefined;
      if (Object.keys(stored.machines).length > 0 && !nextPhone) throw new KeyringError("Brankas kunci tidak lengkap.");
      const next = new Map<string, MachineKeys>();
      for (const [id, m] of Object.entries(stored.machines)) {
        const dataKeys = new Map<number, Uint8Array>(Object.entries(m.dataKeys).map(([kid, key]) => [Number(kid), fromB64(s, key)]));
        if (!dataKeys.has(m.kid)) throw new KeyringError("Brankas kunci tidak lengkap.");
        const laptopKx = fromB64(s, m.laptopKxPublicKey);
        const session = phoneSessionKeys(s, nextPhone!.kx, laptopKx);
        next.set(id, { machineId: id, relayUrl: m.relayUrl, deviceId: m.deviceId, laptopSignPublicKey: fromB64(s, m.laptopSignPublicKey), laptopKxPublicKey: laptopKx, kid: m.kid, dataKeys, rx: session.rx, tx: session.tx });
      }
      return { phone: nextPhone, machines: next };
    } catch (error) {
      if (error instanceof KeyringError) throw error;
      throw new KeyringError("Brankas kunci rusak.");
    }
  }

  // Memori baru dipakai HANYA setelah penyimpanannya berhasil (atau saat membaca).
  function apply(built: { phone: PhoneKeys | undefined; machines: Map<string, MachineKeys> }): void {
    phone = built.phone;
    machines.clear();
    for (const [id, m] of built.machines) machines.set(id, m);
  }

  /** Baca-ubah-tulis di dalam kunci; memori baru diperbarui SETELAH penulisan berhasil. */
  async function commit(mutate: (latest: Stored) => Stored): Promise<void> {
    await runLocked(async () => {
      const next = StoredSchema.parse(mutate(await readStored()));
      const built = build(next); // isi yang tidak bisa dipakai = tidak ada yang ditulis
      await backend.write(JSON.stringify(next));
      apply(built); // memori berubah hanya bila penulisan berhasil
    });
  }

  apply(build(await readStored()));

  const encode = (keys: PhoneKeys): NonNullable<Stored["phone"]> => ({
    sign: { publicKey: toB64(s, keys.sign.publicKey), privateKey: toB64(s, keys.sign.privateKey) },
    kx: { publicKey: toB64(s, keys.kx.publicKey), privateKey: toB64(s, keys.kx.privateKey) },
  });

  return {
    phone: () => phone,
    async ensurePhone() {
      if (phone) return phone;
      const created: PhoneKeys = { sign: generateSignKeyPair(s), kx: generateKxKeyPair(s) };
      await commit((latest) => (latest.phone ? latest : { ...latest, phone: encode(created) }));
      return phone!;
    },
    machine: (machineId) => machines.get(machineId),
    secured: (machineId) => machines.has(machineId),
    anySecured: () => machines.size > 0,
    async saveMachine(input) {
      await commit((latest) => {
        if (!latest.phone) throw new KeyringError("Identitas HP belum dibuat.");
        const previous = latest.machines[input.machineId];
        // Memasangkan ulang laptop yang sama (kunci tanda tangan sama) mempertahankan kunci lama; kunci laptop berbeda berarti riwayat lama tidak relevan.
        const keep = previous && previous.laptopSignPublicKey === toB64(s, input.laptopSignPublicKey) ? previous.dataKeys : {};
        return {
          ...latest,
          machines: {
            ...latest.machines,
            [input.machineId]: {
              relayUrl: input.relayUrl,
              deviceId: input.deviceId,
              laptopSignPublicKey: toB64(s, input.laptopSignPublicKey),
              laptopKxPublicKey: toB64(s, input.laptopKxPublicKey),
              kid: input.kid,
              dataKeys: { ...keep, [String(input.kid)]: toB64(s, input.dataKey) },
            },
          },
        };
      });
      return machines.get(input.machineId)!;
    },
    async addDataKey(machineId, kid, dataKey) {
      let added = false;
      await commit((latest) => {
        const m = latest.machines[machineId];
        if (!m || !Number.isSafeInteger(kid) || kid <= m.kid) return latest;
        added = true;
        return { ...latest, machines: { ...latest.machines, [machineId]: { ...m, kid, dataKeys: { ...m.dataKeys, [String(kid)]: toB64(s, dataKey) } } } };
      });
      return added;
    },
    async removeMachine(machineId) {
      await commit((latest) => {
        if (!(machineId in latest.machines)) return latest;
        const rest = { ...latest.machines };
        delete rest[machineId];
        return { ...latest, machines: rest };
      });
    },
    async reload() {
      apply(build(await readStored()));
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
 * `factory` hanya untuk tes (fake-indexeddb). IndexedDB baru dicari saat dipakai (bukan saat backend dibuat), jadi lingkungan tanpa IndexedDB
 * tidak membuat pembuatannya gagal.
 */
export function indexedDbBackend(factory?: IDBFactory, subtle?: SubtleCrypto): KeyBackend {
  const idb = () => factory ?? indexedDB;
  const crypt = () => subtle ?? crypto.subtle;
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = idb().open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB gagal dibuka"));
    });
  const store = (db: IDBDatabase, mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);

  async function wrapKey(db: IDBDatabase, create: boolean): Promise<CryptoKey | undefined> {
    const existing = (await request(store(db, "readonly").get(WRAP_KEY))) as CryptoKey | undefined;
    if (existing || !create) return existing;
    const key = await crypt().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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
          return new TextDecoder().decode(await crypt().decrypt({ name: "AES-GCM", iv: wrapped.iv }, key, wrapped.ct));
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
        const ct = new Uint8Array(await crypt().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
        await request(store(db, "readwrite").put({ iv, ct } satisfies Wrapped, BLOB));
      } finally {
        db.close();
      }
    },
  };
}
