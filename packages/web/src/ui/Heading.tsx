import { useEffect, useRef, type ReactNode } from "react";

/**
 * Judul layar yang bisa menerima fokus saat muncul.
 *
 * Aplikasi satu halaman mengganti isi layar tanpa memuat halaman baru, sehingga elemen yang sedang
 * fokus (misalnya tombol yang baru diketuk) ikut hilang dan fokus jatuh ke awal dokumen. Pembaca layar
 * lalu tidak mengumumkan apa pun, dan pengguna keyboard harus menelusuri ulang dari atas (WCAG 2.4.3
 * dan 4.1.3). Memindahkan fokus ke judul layar baru membuat pembaca layar membacakannya.
 *
 * `focus` HANYA dipakai untuk perpindahan setelah halaman terbuka: pada kemunculan pertama halaman,
 * fokus tidak direbut. Pasang `key` yang berbeda untuk tiap layar supaya React membuat judul baru
 * (dan efek fokus berjalan) alih-alih memakai ulang yang lama.
 */
export function Heading({ children, focus = false, className = "" }: { children: ReactNode; focus?: boolean; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
    // Hanya saat dipasang (daftar kosong): perubahan `focus` sesudahnya tidak boleh memindahkan fokus lagi.
  }, []);
  // tabIndex -1: bisa difokuskan lewat kode, tetapi tidak menjadi perhentian tombol Tab.
  return (
    <h2 ref={ref} tabIndex={-1} className={`${className} outline-none`}>
      {children}
    </h2>
  );
}
