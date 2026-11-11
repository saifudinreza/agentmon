import { navigate } from "../router";
import type { MouseEvent, ReactNode } from "react";

/**
 * Tautan antar-layar. Berupa <a> sungguhan (bisa dibuka di tab baru, dikenali pembaca layar sebagai
 * tautan), tetapi klik biasa berpindah layar tanpa memuat ulang halaman.
 */
export function Link({ to, children, className = "", ...rest }: { to: string; children: ReactNode; className?: string; "aria-label"?: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Klik dengan Ctrl/Cmd/Shift, atau bukan klik kiri: biarkan browser menanganinya (tab baru, dan seterusnya).
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className} {...rest}>
      {children}
    </a>
  );
}
