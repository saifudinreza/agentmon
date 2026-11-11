// Kolom untuk menempelkan tautan pairing. Dipakai di beranda dan di layar pairing, terutama untuk
// aplikasi iOS di layar utama: tautan dari QR selalu terbuka di Safari, jadi pengguna menyalinnya lalu
// menempelkannya di aplikasi yang sudah dipasang.
import { parsePairingUrl, type PairingLink } from "@agentmon/shared";
import { useState, type FormEvent } from "react";
import { useI18n } from "../i18n/react";

export function PasteLinkForm({ onLink }: { onLink: (link: PairingLink) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const link = parsePairingUrl(value.trim());
    if (!link) {
      setInvalid(true);
      return;
    }
    setValue(""); // tautan berisi kode sekali pakai: jangan dibiarkan di kolom
    setInvalid(false);
    onLink(link);
  };

  return (
    // noValidate + type="text": validasi bawaan browser untuk type="url" mencegat tautan yang salah dengan
    // gelembung berbahasa Inggris dan menghalangi pesan kita sendiri. Keyboard URL di HP tetap muncul
    // lewat inputMode. Tautannya diperiksa oleh parsePairingUrl.
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <label htmlFor="paste-link" className="text-sm font-medium">
        {t("paste.label")}
      </label>
      <input
        id="paste-link"
        type="text"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        placeholder={t("paste.placeholder")}
        aria-invalid={invalid}
        aria-describedby={invalid ? "paste-link-error" : undefined}
        className="min-h-11 w-full rounded-lg border border-line bg-bg px-3 text-base text-fg placeholder:text-muted"
      />
      {invalid && (
        <p id="paste-link-error" role="alert" className="text-sm text-danger">
          {t("paste.invalid")}
        </p>
      )}
      <button type="submit" className="min-h-11 rounded-lg bg-accent px-4 font-semibold text-on-accent active:opacity-80">
        {t("paste.submit")}
      </button>
    </form>
  );
}
