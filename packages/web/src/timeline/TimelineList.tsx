// =====================================================================================
// FILE INI: daftar event timeline = "GULUNGAN KERTAS" yang bisa memanjang tanpa membuat HP kewalahan.
// =====================================================================================
//
// Tiga hal yang dijaga:
//   1. JENDELA: yang digambar hanya event terbaru (150), sisanya dimuat bertahap lewat tombol. Sesi dengan
//      ribuan event tidak membuat ribuan elemen di layar. Event baru ditambahkan di bawah.
//   2. MENGIKUTI YANG BARU: bila pengguna sedang di bagian bawah, layar ikut turun mengikuti event baru
//      (seperti log langsung). Bila ia sedang membaca ke atas, layar TIDAK ditarik; muncul tombol
//      "N event baru" untuk kembali ke bawah.
//   3. POSISI BACA: memuat event yang lebih awal menambah isi di ATAS; posisi gulir disesuaikan supaya
//      yang sedang dibaca tidak melompat.
import type { Envelope } from "@agentmon/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/react";
import { EventRow } from "./EventRow";

export const WINDOW_SIZE = 150;
// Jarak (piksel) dari dasar halaman yang masih dianggap "sedang di bawah".
const BOTTOM_SLACK_PX = 80;

const scrollHeight = () => document.documentElement.scrollHeight;
const atBottom = () => window.innerHeight + window.scrollY >= scrollHeight() - BOTTOM_SLACK_PX;

export function TimelineList({ events }: { events: readonly Envelope[] }) {
  const { t } = useI18n();
  const [windowSize, setWindowSize] = useState(WINDOW_SIZE);
  const [unseen, setUnseen] = useState(0);
  const stick = useRef(true); // sedang di bawah, jadi ikuti event baru
  const seen = useRef(0); // jumlah event saat pengguna terakhir di bawah
  const heightBeforeExpand = useRef<number | undefined>(undefined);

  const shown = events.length > windowSize ? events.slice(events.length - windowSize) : events;
  const hidden = events.length - shown.length;

  useEffect(() => {
    const onScroll = () => {
      stick.current = atBottom();
      if (stick.current) {
        seen.current = eventsLength.current;
        setUnseen(0);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const eventsLength = useRef(events.length);
  eventsLength.current = events.length;

  // Event bertambah: ikuti bila sedang di bawah, bila tidak hitung yang belum dilihat.
  useLayoutEffect(() => {
    if (stick.current) {
      window.scrollTo(0, scrollHeight());
      seen.current = events.length;
      setUnseen(0);
    } else {
      setUnseen(Math.max(0, events.length - seen.current));
    }
  }, [events.length]);

  // Event yang lebih awal dimuat (isi bertambah di atas): jaga posisi baca.
  useLayoutEffect(() => {
    if (heightBeforeExpand.current === undefined) return;
    window.scrollBy(0, scrollHeight() - heightBeforeExpand.current);
    heightBeforeExpand.current = undefined;
  }, [windowSize]);

  return (
    <>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            heightBeforeExpand.current = scrollHeight();
            stick.current = false;
            setWindowSize((size) => size + WINDOW_SIZE);
          }}
          className="mb-2 min-h-11 w-full rounded-lg border border-line bg-surface px-4 text-sm"
        >
          {t("timeline.earlier", { count: Math.min(hidden, WINDOW_SIZE) })}
        </button>
      )}
      <ol aria-label={t("timeline.list")} className="flex flex-col gap-1.5">
        {shown.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </ol>
      {unseen > 0 && (
        <button
          type="button"
          onClick={() => {
            window.scrollTo({ top: scrollHeight(), behavior: "smooth" });
            stick.current = true;
            seen.current = events.length;
            setUnseen(0);
          }}
          className="fixed left-1/2 z-10 min-h-11 -translate-x-1/2 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent shadow-lg active:opacity-80"
          style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
        >
          {t("timeline.new", { count: unseen })}
        </button>
      )}
    </>
  );
}
