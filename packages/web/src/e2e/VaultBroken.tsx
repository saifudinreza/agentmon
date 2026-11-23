// Layar yang menggantikan aplikasi bila brankas kunci E2E rusak atau tidak bisa dibuka. Brankas TIDAK dikosongkan diam-diam: itu akan membuang kunci
// tanpa kabar dan membuat HP tampak "kosong". Pengguna diberi tahu apa yang terjadi dan apa yang bisa dilakukan.
import { useI18n } from "../i18n/react";

export function VaultBroken() {
  const { t } = useI18n();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-4 text-center">
      <h1 className="text-xl font-semibold">{t("e2e.vault.title")}</h1>
      <p role="alert" className="text-muted">
        {t("e2e.vault.body")}
      </p>
    </main>
  );
}
