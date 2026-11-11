// =====================================================================================
// FILE INI: kerangka tampilan aplikasi = "RANGKA RUMAH" yang nanti diisi layar-layar lain.
// =====================================================================================
//
// Isinya baru kerangka: bilah atas (nama aplikasi dan tombol tema), pita peringatan offline, dan
// satu layar kosong yang memandu pengguna memasangkan laptop. Layar pairing (issue berikutnya),
// daftar sesi, dan timeline diisi ke dalam <main> ini.
//
// Tata letak MOBILE-FIRST: dirancang untuk layar HP dulu (satu kolom, tombol minimal 44 piksel
// supaya nyaman disentuh satu tangan, jarak aman untuk notch iPhone), lalu dibatasi lebarnya
// supaya tetap rapi di layar besar.
import { useI18n } from "./i18n/react";
import { useOnline } from "./hooks/useOnline";
import { useTheme } from "./theme/useTheme";

export function App() {
  const { t } = useI18n();
  const online = useOnline();
  const { mode, cycle } = useTheme();
  // Teks yang terlihat di tombol, misalnya "Tema: Otomatis".
  const themeLabel = t("theme.label", { mode: t(`theme.${mode}`) });

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-xl items-center justify-between px-4">
          <h1 className="text-lg font-semibold tracking-tight">{t("app.name")}</h1>
          <button
            type="button"
            onClick={cycle}
            // Nama aksesibel (yang dibaca pembaca layar dan dicari kontrol suara) HARUS memuat teks yang
            // terlihat (WCAG 2.5.3). Kalau hanya "Ganti tema", pengguna tidak pernah mendengar tema
            // yang sedang aktif, dan ucapan "ketuk Tema Otomatis" tidak menemukan tombolnya.
            aria-label={`${t("theme.toggle")}. ${themeLabel}`}
            className="min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-muted active:opacity-70"
          >
            {themeLabel}
          </button>
        </div>
      </header>

      {!online && (
        <div role="status" className="border-b border-line bg-warn-bg px-4 py-2 text-center text-sm text-warn-fg">
          {t("offline.banner")}
        </div>
      )}

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-8 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <section className="rounded-2xl border border-line bg-surface p-6 text-center">
          <h2 className="text-xl font-semibold">{t("empty.title")}</h2>
          <p className="mt-2 text-muted">{t("empty.body")}</p>
          <p className="mt-6 text-sm text-muted">{t("app.tagline")}</p>
        </section>
      </main>
    </div>
  );
}
