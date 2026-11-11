// Tautan pairing yang sedang "dititipkan" antar layar, hanya di memori.
//
// Dipakai saat pengguna menempelkan tautan di beranda lalu berpindah ke layar pairing. Menyimpannya di
// memori (bukan di alamat URL atau penyimpanan perangkat) menjaga kode sekali pakai itu tidak tertinggal
// di riwayat browser maupun di disk. Memuat ulang halaman menghapusnya, dan itu memang diinginkan.
import type { PairingLink } from "@agentmon/shared";

let pending: PairingLink | undefined;

export function setPendingLink(link: PairingLink): void {
  pending = link;
}

/** Melihat tanpa mengambil. Aman dipanggil berulang (React menjalankan inisialisasi dua kali di mode pengembangan). */
export function peekPendingLink(): PairingLink | undefined {
  return pending;
}

export function clearPendingLink(): void {
  pending = undefined;
}
