import { useEffect, useState } from "react";

/** Waktu sekarang (milidetik) yang diperbarui tiap `intervalMs`, untuk hitung mundur. Berhenti saat dilepas. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    // Saat halaman terlihat lagi (HP dibuka dari kunci), segarkan segera: pewaktu bisa tertahan selama terkunci.
    const onVisible = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return now;
}
