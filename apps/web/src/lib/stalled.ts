import type { ProjectPulseSummary } from "@stubwise/shared";

type StalledItem = ProjectPulseSummary["stalled"][number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Da quanti giorni è fermo un ticket. **Il conto lo fa il CLIENT**, qui, al
 * momento del rendering: il server manda una DATA (`stalledSince`, l'ultimo
 * movimento) apposta, perché un numero calcolato a monte invecchia dentro una
 * risposta in cache e direbbe «da 3 giorni» su una pagina aperta da una
 * settimana.
 *
 * Gemella di `apps/mobile/src/lib/stalled.ts`, duplicata e non condivisa per
 * la stessa ragione di `pulse-line.ts` accanto (là il tipo passa da
 * `Reader<>`, qui no).
 *
 * Vale 0 per una data nel futuro (orologi sfasati) e per una data illeggibile:
 * un numero negativo o un `NaN` in una riga che dice «fermo da» sarebbe
 * peggio di un modesto «0».
 */
export function stalledDays(stalledSince: string, now: Date): number {
  const since = new Date(stalledSince).getTime();
  if (Number.isNaN(since)) return 0;
  const ms = now.getTime() - since;
  if (ms <= 0) return 0;
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * Chiave i18n del MOTIVO per cui un ticket è fermo. A differenza del gemello
 * mobile non c'è il caso `UNKNOWN` — server e web si deployano insieme —, ma
 * il `default` resta: un motivo che questo bundle non conosce degrada al
 * testo neutro invece di lasciare la riga muta.
 */
export function stalledReasonKey(reason: StalledItem["reason"]): string {
  switch (reason) {
    case "to_prepare":
      return "projects:stalled.reason.toPrepare";
    case "worked_then_stopped":
      return "projects:stalled.reason.workedThenStopped";
    case "interrupted":
      return "projects:stalled.reason.interrupted";
    case "declared_no_work":
      return "projects:stalled.reason.declaredNoWork";
    default:
      return "projects:stalled.reason.unknown";
  }
}
