import type { ChatEventKind } from "../types";

// Costanti della Chat senza stato né seme: le leggono anche le superfici
// della build app (integrazione area 2, fetta 1). `writes.ts` le ri-esporta.

/** Tutti gli eventi di progetto, nell'ordine delle impostazioni del canale. */
export const CHAT_EVENT_KINDS: readonly ChatEventKind[] = [
  "release_page",
  "milestone_reached",
  "brief_ready",
  "pr_opened",
  "pr_merged",
  "request_new",
  "task_closed",
];

/** Le persone di un DM, compreso chi lo apre. */
export const DM_MAX_PEOPLE = 8;
