// =====================================================================================
// FILE INI: penghubung data relay ke React = "SAKLAR UTAMA" yang menyalakan semua sambungan.
// =====================================================================================
//
// Membaca laptop yang sudah dipasangkan dari penyimpanan perangkat, lalu membuat satu "meja redaksi"
// (relay-store.ts) untuk tiap relay. Sambungan dibuka saat komponen ini dipasang dan ditutup saat
// dilepas. Bila pairing berubah (pairing baru berhasil), daftar dibaca ulang dan sambungan dibuat ulang.
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { getE2e, setE2eMarkers } from "../e2e/runtime";
import { PAIRINGS_CHANGED_EVENT, PAIRINGS_STORAGE_KEY, e2eMachineIds, loadPairings, type StoredPairing } from "../pairing/storage";
import { createRelayApi } from "./api";
import { createRelayStore, type RelayState, type RelayStore } from "./relay-store";

export type RelayEntry = { pairing: StoredPairing; store: RelayStore };

export type RelayStoreFactory = (pairing: StoredPairing) => RelayStore;

// Gerbang E2E dipasang bila ada laptop E2E di brankas (runtime dihidupkan sebelum layar digambar, lihat main.tsx). Tanpa itu, tidak ada kode kripto yang dimuat.
const defaultFactory: RelayStoreFactory = (pairing) => {
  const e2e = getE2e();
  return createRelayStore({
    relayUrl: pairing.relayUrl,
    token: pairing.deviceToken,
    api: createRelayApi({ relayUrl: pairing.relayUrl, token: pairing.deviceToken }),
    ...(e2e ? { e2e: e2e.gate } : {}),
  });
};

const RelayContext = createContext<RelayEntry[] | undefined>(undefined);

function readPairings(): StoredPairing[] {
  try {
    return loadPairings(window.localStorage);
  } catch {
    return [];
  }
}

export function RelayProvider({ children, factory = defaultFactory }: { children: ReactNode; factory?: RelayStoreFactory }) {
  // Naik setiap kali pairing berubah, supaya daftar dan sambungan dibuat ulang.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    // Tab lain memasangkan laptop: pairing berubah di localStorage (peristiwa `storage` hanya datang dari tab LAIN). Brankas dibaca ulang dulu supaya
    // kunci laptop baru itu dikenal sebelum sambungan dibuat ulang.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== PAIRINGS_STORAGE_KEY) return;
      void (getE2e()?.keyring.reload() ?? Promise.resolve()).catch(() => undefined).finally(bump);
    };
    window.addEventListener(PAIRINGS_CHANGED_EVENT, bump);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PAIRINGS_CHANGED_EVENT, bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Store dibuat tanpa membuka jaringan (start dipanggil di efek), sehingga aman bagi React yang
  // menjalankan efek dua kali di mode pengembangan.
  const entries = useMemo(() => {
    const pairings = readPairings();
    setE2eMarkers(e2eMachineIds(pairings)); // sebelum toko dibuat: gerbang harus tahu laptop mana yang wajib terenkripsi
    return pairings.map((pairing) => ({ pairing, store: factory(pairing) }));
  }, [version, factory]);

  useEffect(() => {
    for (const entry of entries) entry.store.start();
    return () => {
      for (const entry of entries) entry.store.stop();
    };
  }, [entries]);

  return <RelayContext.Provider value={entries}>{children}</RelayContext.Provider>;
}

export function useRelayEntries(): RelayEntry[] {
  const value = useContext(RelayContext);
  if (!value) throw new Error("useRelayEntries harus dipakai di dalam RelayProvider");
  return value;
}

/** Keadaan sebuah relay; komponen digambar ulang hanya bila keadaannya berubah. */
export function useRelayState(store: RelayStore): RelayState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Mencari relay yang memiliki laptop ini (nomor laptop unik per relay; sangat jarang bertabrakan antar relay). */
export function findEntryForMachine(entries: RelayEntry[], machineId: string): RelayEntry | undefined {
  return entries.find((e) => e.pairing.machines.some((m) => m.id === machineId) || e.store.getState().machines.some((m) => m.id === machineId));
}
