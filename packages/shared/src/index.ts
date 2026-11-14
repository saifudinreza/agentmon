// FILE INI: "pintu depan" paket shared. Paket lain (bridge, server, web) cukup menulis
//   import { parseEvent } from "@agentmon/shared";
// tanpa perlu tahu isi di dalamnya terbagi ke file mana saja. Kalau suatu hari file
// di dalamnya dipecah atau dipindah, paket lain tidak perlu ikut diubah.
//
// Hubungannya dengan package.json paket ini: bagian "exports" menunjuk ke file ini.

// Nama proyek. Dipakai test di bridge/server/web untuk membuktikan bahwa ketiganya
// benar-benar bisa mengambil kode dari paket shared.
export const PROJECT_NAME = "AgentMon";

// "export * from" = teruskan SEMUA yang di-export file itu lewat pintu ini.
export * from "./approval"; // status dan keputusan approval
export * from "./commands"; // perintah keputusan dari HP dan balasannya
export * from "./device-api"; // jawaban API baca riwayat untuk HP
export * from "./diff"; // bentuk perubahan sebuah berkas (diff, hunk)
export * from "./events"; // amplop dan jenis event
export * from "./pairing"; // bentuk data dan alamat QR untuk pairing
export * from "./parse"; // parseEvent() dan hasilnya
export * from "./push"; // langganan dan isi notifikasi Web Push
export * from "./relay"; // bingkai pesan antara klien dan relay
export * from "./risk"; // level risiko dan hasil policy
export * from "./rollback"; // perintah dan balasan rollback (kembali ke checkpoint)
export * from "./summary"; // ringkasan perubahan yang disusun daemon
