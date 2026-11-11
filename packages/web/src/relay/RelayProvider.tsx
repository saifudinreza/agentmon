// =====================================================================================
// FILE INI: penghubung data relay ke React = "SAKLAR UTAMA" yang menyalakan semua sambungan.
// =====================================================================================
//
// Membaca laptop yang sudah dipasangkan dari penyimpanan perangkat, lalu membuat satu "meja redaksi"
// (relay-store.ts) untuk tiap relay. Sambungan dibuka saat komponen ini dipasang dan ditutup saat
// dilepas. Bila pairing berubah (pairing baru berhasil), daftar dibaca ulang dan sambungan dibuat ulang.
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { PAIRINGS_CHANGED_EVENT, loadPairings, type StoredPairing } from "../pairing/storage";
import { createRelayApi } from "./api";
import { createRelayStore, type RelayState, type RelayStore } from "./relay-store";

export type RelayEntry = { pairing: StoredPairing; store: RelayStore };

export type RelayStoreFactory = (pairing: StoredPairing) => RelayStore;

const defaultFactory: RelayStoreFactory = (pairing) =>
  createRelayStore({ relayUrl: pairing.relayUrl, token: pairing.deviceToken, api: createRelayApi({ relayUrl: pairing.relayUrl, token: pairing.deviceToken }) });

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
    window.addEventListener(PAIRINGS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(PAIRINGS_CHANGED_EVENT, bump);
  }, []);

  // Store dibuat tanpa membuka jaringan (start dipanggil di efek), sehingga aman bagi React yang
  // menjalankan efek dua kali di mode pengembangan.
  const entries = useMemo(() => readPairings().map((pairing) => ({ pairing, store: factory(pairing) })), [version, factory]);

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
