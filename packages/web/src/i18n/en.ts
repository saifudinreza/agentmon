// Terjemahan Inggris. `Record<MessageKey, string>` memaksa berkas ini punya SEMUA kunci dari id.ts,
// tidak kurang dan tidak lebih. Inggris menyusul sesuai PRD; berkas ini menjaga kerangkanya siap.
import type { MessageKey } from "./id";

export const en: Record<MessageKey, string> = {
  "app.name": "AgentMon",
  "app.tagline": "Monitor and approve your coding agent's actions from your phone.",

  "empty.title": "No laptop paired yet",
  "empty.body": "Run the pair command on your laptop, then scan the QR code it shows with this phone's camera.",

  "offline.banner": "You are offline. The latest data will load when the network is back.",

  "theme.label": "Theme: {mode}",
  "theme.toggle": "Change theme",
  "theme.system": "Automatic",
  "theme.light": "Light",
  "theme.dark": "Dark",
};
