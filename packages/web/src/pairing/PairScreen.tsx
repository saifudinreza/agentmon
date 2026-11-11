// =====================================================================================
// FILE INI: layar pairing = "MEJA RESEPSIONIS" tempat HP berkenalan dengan laptop.
// =====================================================================================
//
// Pengguna tiba di sini dengan memindai QR dari laptop. Alurnya:
//
//   1. Alamat dibaca: kode dan alamat relay ada di FRAGMEN alamat (/pair#c=...&r=...).
//      Fragmen LANGSUNG dihapus dari alamat browser, dan tautannya hanya hidup di memori. Jadi
//      kode tidak tertinggal di bilah alamat, di riwayat tab, atau di tangkapan layar berikutnya.
//   2. Layar konfirmasi menampilkan relay yang akan dipakai dan meminta nama perangkat. Pairing
//      TIDAK berjalan otomatis: tautan buatan orang lain tidak boleh memasangkan HP ini diam-diam.
//   3. Kode ditukar dengan kunci (redeem.ts) dan disimpan di perangkat (storage.ts).
//   4. Hasilnya ditampilkan: berhasil, kode tidak berlaku, terlalu banyak percobaan, relay tidak
//      terjangkau, tidak bisa disimpan, atau gagal.
//
// KHUSUS iOS (lihat platform.ts): di tab Safari, pairing DITUNDA. Aplikasi di layar utama menyimpan
// data terpisah dari Safari, jadi pairing yang dibuat di tab akan "hilang" saat aplikasi dibuka. Pengguna
// dipandu memasang ke layar utama dulu, menyalin tautan, lalu menempelkannya di aplikasi itu. Ada jalan
// pintas "pasangkan di browser saja" dengan peringatan yang jelas.
import { buildPairingUrl, PairRedeemRequestSchema, parsePairingUrl, type PairingLink } from "@agentmon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import { Heading } from "../ui/Heading";
import type { MessageKey } from "../i18n/id";
import { navigate } from "../router";
import { clearPendingLink, peekPendingLink } from "./pending";
import { PasteLinkForm } from "./PasteLinkForm";
import { currentPlatform, defaultDeviceName } from "./platform";
import { redeemPairing, type RedeemOutcome } from "./redeem";

type Phase =
  | { name: "confirm" }
  | { name: "working" }
  | { name: "success"; machineName: string }
  | { name: "error"; outcome: Exclude<RedeemOutcome, { status: "success" }> };

const ERROR_KEY: Record<Exclude<RedeemOutcome, { status: "success" }>["status"], MessageKey> = {
  "invalid-code": "pair.error.invalid",
  "rate-limited": "pair.error.rate",
  "insecure-relay": "pair.error.insecure",
  unreachable: "pair.error.unreachable",
  "not-saved": "pair.error.notSaved",
  failed: "pair.error.failed",
};

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function PairScreen({ focusHeading = false }: { focusHeading?: boolean }) {
  const { t } = useI18n();
  const platform = useMemo(currentPlatform, []);

  // Tautan dibaca TANPA efek samping (React menjalankan inisialisasi dua kali di mode pengembangan);
  // penghapusan dari alamat dilakukan di efek di bawah.
  const [link, setLink] = useState<PairingLink | undefined>(() => peekPendingLink() ?? parsePairingUrl(window.location.href));
  const [phase, setPhase] = useState<Phase>({ name: "confirm" });
  const [name, setName] = useState(() => defaultDeviceName(navigator as Navigator));
  const [nameTouched, setNameTouched] = useState(false);
  const [browserOnly, setBrowserOnly] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const inFlight = useRef(false);
  // Fokus dipindahkan ke judul layar baru hanya setelah ada perpindahan (bukan saat halaman pertama dibuka).
  const announce = useRef(focusHeading);

  // Hapus kode dari alamat dan dari titipan di memori, secepat mungkin setelah dibaca.
  useEffect(() => {
    const stripFragment = () => {
      if (window.location.hash !== "") {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      }
    };
    stripFragment();
    clearPendingLink();

    // Pengguna memindai QR lain saat layar ini SUDAH terbuka (misalnya aplikasi terpasang di Android yang
    // membuka tautan di jendela yang sama, atau QR laptop kedua setelah yang pertama berhasil). Browser hanya
    // mengganti fragmen alamat tanpa memuat ulang halaman, sehingga tanpa ini layar lama tetap tampil dan
    // kode baru tertinggal di alamat. Tautan baru yang sah memulai ulang alurnya.
    const onHashChange = () => {
      const next = parsePairingUrl(window.location.href);
      stripFragment();
      if (!next) return;
      announce.current = true;
      setLink(next);
      setPhase({ name: "confirm" });
      setCopy("idle");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const nameCheck = PairRedeemRequestSchema.shape.name.safeParse(name);
  const nameValid = nameCheck.success;

  const needsInstallGuide = platform.isIos && !platform.isStandalone && !browserOnly;

  async function pair() {
    if (!link || !nameValid || inFlight.current) return;
    inFlight.current = true;
    announce.current = true;
    setPhase({ name: "working" });
    try {
      const outcome = await redeemPairing(link, nameCheck.data ?? name, { storage: safeLocalStorage() });
      if (outcome.status === "success") {
        // Minta browser menjaga data ini dari pembersihan otomatis. Boleh ditolak; hanya membantu.
        void navigator.storage?.persist?.().catch(() => undefined);
        setLink(undefined); // kode sudah terpakai; tidak perlu disimpan lagi
        setPhase({ name: "success", machineName: outcome.machine.name });
      } else {
        setPhase({ name: "error", outcome });
      }
    } finally {
      inFlight.current = false;
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(buildPairingUrl(window.location.origin, link));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  // ---- Tidak ada tautan (alamat dibuka tanpa kode, atau halaman dimuat ulang setelah kode dihapus) ----
  if (!link && phase.name !== "success" && phase.name !== "error") {
    return (
      <Card>
        <Heading key="missing" focus={announce.current} className="text-xl font-semibold">
          {t("pair.missing.title")}
        </Heading>
        <p className="mt-2 text-muted">{t("pair.missing.body")}</p>
        <div className="mt-4 text-left">
          <PasteLinkForm
            onLink={(next) => {
              announce.current = true;
              setLink(next);
              setPhase({ name: "confirm" });
            }}
          />
        </div>
        <BackButton />
      </Card>
    );
  }

  if (phase.name === "success") {
    return (
      <Card>
        <Heading key="success" focus={announce.current} className="text-xl font-semibold">
          {t("pair.success.title", { name: phase.machineName })}
        </Heading>
        <p className="mt-2 text-muted">{t("pair.success.body")}</p>
        <button
          type="button"
          onClick={() => navigate("/", { replace: true })}
          className="mt-6 min-h-11 w-full rounded-lg bg-accent px-4 font-semibold text-on-accent active:opacity-80"
        >
          {t("pair.success.done")}
        </button>
      </Card>
    );
  }

  if (phase.name === "error") {
    const retryable = phase.outcome.status === "unreachable" || phase.outcome.status === "rate-limited";
    return (
      <Card>
        <Heading key="error" focus={announce.current} className="text-xl font-semibold">
          {t("pair.error.title")}
        </Heading>
        <p role="alert" className="mt-2 text-muted">
          {t(ERROR_KEY[phase.outcome.status], phase.outcome.status === "not-saved" ? { name: phase.outcome.machineName } : undefined)}
        </p>
        {retryable && link && (
          <button
            type="button"
            onClick={() => {
              announce.current = true;
              setPhase({ name: "confirm" });
            }}
            className="mt-6 min-h-11 w-full rounded-lg bg-accent px-4 font-semibold text-on-accent active:opacity-80"
          >
            {t("pair.retry")}
          </button>
        )}
        <BackButton />
      </Card>
    );
  }

  // ---- iOS di tab Safari: pasang ke layar utama dulu ----
  if (needsInstallGuide && link) {
    const shareable = buildPairingUrl(window.location.origin, link);
    return (
      <Card>
        <Heading key="ios" focus={announce.current} className="text-xl font-semibold">
          {t("pair.ios.title")}
        </Heading>
        <p className="mt-2 text-muted">{t("pair.ios.body")}</p>
        <ol className="mt-4 list-decimal space-y-1 pl-5 text-left text-sm">
          <li>{t("pair.ios.step1")}</li>
          <li>{t("pair.ios.step2")}</li>
          <li>{t("pair.ios.step3")}</li>
        </ol>
        <button
          type="button"
          onClick={() => void copyLink()}
          className="mt-4 min-h-11 w-full rounded-lg bg-accent px-4 font-semibold text-on-accent active:opacity-80"
        >
          {t("pair.ios.copy")}
        </button>
        {copy === "copied" && (
          <p role="status" className="mt-2 text-sm text-muted">
            {t("pair.ios.copied")}
          </p>
        )}
        {copy === "failed" && (
          <>
            <p role="status" className="mt-2 text-sm text-muted">
              {t("pair.ios.copyFailed")}
            </p>
            <textarea readOnly value={shareable} rows={4} className="mt-2 w-full rounded-lg border border-line bg-bg p-2 text-xs" aria-label={t("pair.ios.copy")} />
          </>
        )}
        <button
          type="button"
          onClick={() => {
            announce.current = true;
            setBrowserOnly(true);
          }} className="mt-4 min-h-11 w-full rounded-lg border border-line bg-surface px-4 text-sm">
          {t("pair.ios.browserOnly")}
        </button>
        <p className="mt-1 text-xs text-muted">{t("pair.ios.browserOnlyWarning")}</p>
      </Card>
    );
  }

  // ---- Konfirmasi ----
  const host = (() => {
    try {
      return new URL((link as PairingLink).relayUrl).host;
    } catch {
      return "";
    }
  })();
  const working = phase.name === "working";

  return (
    <Card>
      <Heading key="confirm" focus={announce.current} className="text-xl font-semibold">
        {t("pair.title")}
      </Heading>
      <p className="mt-2 text-muted">{t("pair.relay", { host })}</p>
      <p className="mt-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn-fg">{t("pair.warning")}</p>

      <form
        className="mt-4 flex flex-col gap-2 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          void pair();
        }}
      >
        <label htmlFor="device-name" className="text-sm font-medium">
          {t("pair.name.label")}
        </label>
        <input
          id="device-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setNameTouched(true)}
          disabled={working}
          autoComplete="off"
          aria-invalid={nameTouched && !nameValid}
          aria-describedby="device-name-hint"
          className="min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-base text-fg"
        />
        <p id="device-name-hint" className={`text-sm ${nameTouched && !nameValid ? "text-danger" : "text-muted"}`}>
          {nameTouched && !nameValid ? t("pair.name.invalid") : t("pair.name.hint")}
        </p>
        <button
          type="submit"
          disabled={working || !nameValid}
          className="mt-2 min-h-11 rounded-lg bg-accent px-4 font-semibold text-on-accent active:opacity-80 disabled:opacity-50"
        >
          {working ? t("pair.working") : t("pair.submit")}
        </button>
      </form>
      <BackButton />
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-2xl border border-line bg-surface p-6 text-center">{children}</section>;
}

function BackButton() {
  const { t } = useI18n();
  return (
    <button type="button" onClick={() => navigate("/", { replace: true })} className="mt-4 min-h-11 text-sm text-muted underline">
      {t("pair.back")}
    </button>
  );
}
