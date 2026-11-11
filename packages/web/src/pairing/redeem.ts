// =====================================================================================
// FILE INI: menukar kode QR menjadi kunci = "LOKET" dari sisi HP.
// =====================================================================================
//
// HP mengirim kode sekali pakai ke relay, dan relay membalas dengan kunci tetap (token perangkat)
// beserta nama laptop yang dipasangkan. Hasilnya disimpan di penyimpanan perangkat (storage.ts).
//
// HASILNYA SELALU SALAH SATU DARI BEBERAPA BENTUK yang ditangani layar dengan pesannya masing-masing;
// fungsi ini tidak pernah melempar galat ke pemanggilnya.
//
// KEAMANAN:
//   - Sambungan ke relay harus terenkripsi (https). Pengecualian hanya untuk komputer ini sendiri
//     (localhost), untuk pengembangan. Tanpa itu, token yang dikirim balik bisa dibaca orang di jaringan.
//   - HP yang sudah punya token di relay yang sama mengirimkannya, supaya laptop kedua dipasangkan
//     ke perangkat yang sama (bukan perangkat baru). Bila token lama itu sudah dicabut, relay menolak
//     TANPA menghanguskan kode; token basi dibuang dan penukaran diulang sekali sebagai perangkat baru.
//   - Kode dan token tidak pernah dicatat ke konsol atau dimasukkan ke pesan galat.
import { PairRedeemResponseSchema, type PairingLink } from "@agentmon/shared";
import { findPairing, loadPairings, normalizeRelayUrl, removePairing, savePairing, type PairedMachine, type StoredPairing } from "./storage";

export type RedeemOutcome =
  | { status: "success"; pairing: StoredPairing; machine: PairedMachine; newDevice: boolean }
  // Kode tidak dikenal, sudah terpakai, atau kedaluwarsa. Relay sengaja tidak membedakannya.
  | { status: "invalid-code" }
  | { status: "rate-limited" }
  // Alamat relay tidak terenkripsi (selain localhost).
  | { status: "insecure-relay" }
  // Relay tidak terjangkau: jaringan putus, batas waktu, atau alamat salah.
  | { status: "unreachable" }
  // Berhasil di relay tetapi gagal disimpan di perangkat ini (penyimpanan penuh atau diblokir).
  | { status: "not-saved"; machineName: string }
  // Hal lain yang tak terduga (jawaban aneh, galat server).
  | { status: "failed"; httpStatus?: number };

export type RedeemDeps = {
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** Alamat yang aman untuk berbicara dengan relay: https, atau http hanya ke komputer ini sendiri. */
export function isSecureRelayUrl(relayUrl: string): boolean {
  try {
    const url = new URL(relayUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export async function redeemPairing(link: PairingLink, name: string, deps: RedeemDeps): Promise<RedeemOutcome> {
  const relayUrl = normalizeRelayUrl(link.relayUrl);
  if (relayUrl === undefined) return { status: "failed" };
  if (!isSecureRelayUrl(relayUrl)) return { status: "insecure-relay" };

  const http = deps.fetch ?? fetch.bind(globalThis);
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Satu percobaan penukaran. `token` = token lama HP ini di relay itu (bila ada).
  const attempt = async (token: string | undefined): Promise<RedeemOutcome | { status: "stale-token" } | { status: "ok"; body: unknown }> => {
    let response: Response;
    try {
      response = await http(`${relayUrl}/pair/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ code: link.code, name }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { status: "unreachable" };
    }
    if (response.status === 200) {
      try {
        return { status: "ok", body: await response.json() };
      } catch {
        return { status: "failed", httpStatus: 200 };
      }
    }
    if (response.status === 400) return { status: "invalid-code" };
    if (response.status === 429) return { status: "rate-limited" };
    if (response.status === 401 && token !== undefined) return { status: "stale-token" };
    return { status: "failed", httpStatus: response.status };
  };

  const existing = findPairing(loadPairings(deps.storage), relayUrl);
  let result = await attempt(existing?.deviceToken);
  let usedExistingToken = existing !== undefined;

  // Token lama sudah tidak berlaku (perangkat dicabut): buang, lalu tukar ulang sebagai perangkat baru.
  // Kode belum hangus karena relay memeriksa token SEBELUM menghabiskan kode.
  if (result.status === "stale-token") {
    removePairing(deps.storage, relayUrl);
    usedExistingToken = false;
    result = await attempt(undefined);
  }

  if (result.status === "stale-token") return { status: "failed", httpStatus: 401 };
  if (result.status !== "ok") return result;

  const parsed = PairRedeemResponseSchema.safeParse(result.body);
  if (!parsed.success) return { status: "failed", httpStatus: 200 };
  const reply = parsed.data;

  // Perangkat baru wajib membawa token. Jawaban tanpa token padahal kita tidak mengirim token lama
  // berarti relay tidak konsisten; tidak ada yang bisa disimpan.
  if (reply.deviceToken === undefined && !usedExistingToken) return { status: "failed", httpStatus: 200 };

  const machine: PairedMachine = { id: reply.machineId, name: reply.machineName, pairedAt: now().toISOString() };
  const pairing = savePairing(deps.storage, {
    relayUrl,
    deviceId: reply.deviceId,
    ...(reply.deviceToken !== undefined ? { deviceToken: reply.deviceToken } : {}),
    machine,
  });
  if (!pairing) return { status: "not-saved", machineName: reply.machineName };
  return { status: "success", pairing, machine, newDevice: reply.deviceToken !== undefined };
}
