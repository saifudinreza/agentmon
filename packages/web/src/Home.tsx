// Beranda: daftar laptop yang sudah terpasang, dan cara memasangkan laptop baru.
// Daftar sesi dan timeline masuk ke sini di issue berikutnya.
import { useState } from "react";
import { useI18n } from "./i18n/react";
import type { PairingLink } from "@agentmon/shared";
import { PairScreen } from "./pairing/PairScreen";
import { setPendingLink } from "./pairing/pending";
import { PasteLinkForm } from "./pairing/PasteLinkForm";
import { loadPairings } from "./pairing/storage";
import { navigate, usePath } from "./router";

// Menitipkan tautan hasil tempel (hanya di memori), lalu pindah ke layar pairing.
function startPairing(link: PairingLink) {
  setPendingLink(link);
  navigate("/pair");
}

function readPairings() {
  try {
    return loadPairings(window.localStorage);
  } catch {
    return [];
  }
}

export function Home() {
  const { t } = useI18n();
  // Dibaca sekali saat layar dibuka. Layar pairing mengarahkan kembali ke sini setelah berhasil,
  // yang membuat komponen ini dibuat ulang dengan data terbaru.
  const [pairings] = useState(readPairings);
  const machines = pairings.flatMap((p) => p.machines.map((m) => ({ ...m, host: safeHost(p.relayUrl) })));

  return (
    <div className="flex flex-col gap-4">
      {machines.length > 0 ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-semibold">{t("home.machines.title")}</h2>
          <ul className="mt-3 divide-y divide-line">
            {machines.map((machine) => (
              <li key={`${machine.host}/${machine.id}`} className="py-3">
                <p className="font-medium">{machine.name || machine.id}</p>
                <p className="text-sm text-muted">{t("home.machine.via", { host: machine.host })}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="rounded-2xl border border-line bg-surface p-6 text-center">
          <h2 className="text-xl font-semibold">{t("empty.title")}</h2>
          <p className="mt-2 text-muted">{t("empty.body")}</p>
        </section>
      )}

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-semibold">{t("home.pair.title")}</h2>
        <p className="mt-1 mb-4 text-sm text-muted">{t("home.pair.body")}</p>
        <PasteLinkForm onLink={startPairing} />
      </section>
    </div>
  );
}

function safeHost(relayUrl: string): string {
  try {
    return new URL(relayUrl).host;
  } catch {
    return relayUrl;
  }
}

/** Memilih layar menurut alamat. */
export function Routes() {
  const path = usePath();
  return path === "/pair" ? <PairScreen /> : <Home />;
}
