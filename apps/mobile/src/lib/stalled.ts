import { isUnknown } from "@stubwise/shared";
import type { ProjectPulseSummary, Reader } from "@stubwise/shared";

type StalledItem = Reader<ProjectPulseSummary>["stalled"][number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Da quanti giorni è fermo un ticket. **Il conto lo fa il CLIENT**, qui, al
 * momento del rendering — e non è un dettaglio implementativo: il server manda
 * una DATA (`stalledSince`, l'ultimo movimento) apposta, perché un numero
 * calcolato a monte invecchia dentro una risposta in cache e direbbe «da 3
 * giorni» su una schermata aperta da una settimana.
 *
 * Vale 0 per una data nel futuro (orologi sfasati) e per una data
 * illeggibile: un numero negativo o un `NaN` in una riga che dice «fermo da»
 * sarebbe peggio di un modesto «0».
 */
export function stalledDays(stalledSince: string, now: Date): number {
  const since = new Date(stalledSince).getTime();
  if (Number.isNaN(since)) return 0;
  const ms = now.getTime() - since;
  if (ms <= 0) return 0;
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * Chiave i18n del MOTIVO per cui un ticket è fermo. `isUnknown` per lo stesso
 * motivo di `waitingKindKey` in `./pulse-line.ts`: un server più nuovo con un
 * quinto motivo arriva qui come ignoto (`readerSchema` apre l'enum), e la riga
 * deve degradare a un testo neutro — «fermo» — invece di mostrare un valore
 * grezzo o di sparire.
 */
export function stalledReasonKey(reason: StalledItem["reason"]): string {
  if (isUnknown(reason)) return "mobile.projects.detail.stalledReason.unknown";
  if (reason === "to_prepare") return "mobile.projects.detail.stalledReason.toPrepare";
  if (reason === "worked_then_stopped") return "mobile.projects.detail.stalledReason.workedThenStopped";
  if (reason === "interrupted") return "mobile.projects.detail.stalledReason.interrupted";
  if (reason === "declared_no_work") return "mobile.projects.detail.stalledReason.declaredNoWork";
  return "mobile.projects.detail.stalledReason.unknown";
}
