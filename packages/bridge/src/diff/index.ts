// Kalkulator diff: menghitung perubahan yang diusulkan agent, untuk ditampilkan dan direview
// per hunk. Penjelasan tiap bagian ada di masing-masing berkas:
//   text.ts       membandingkan dua teks menjadi hunk (algoritma Myers, dengan batas memori)
//   sensitive.ts  menandai path sensitif
//   tool.ts       menghitung diff untuk satu aksi agent (Write, Edit, MultiEdit)
export * from "./sensitive";
export * from "./text";
export * from "./tool";
