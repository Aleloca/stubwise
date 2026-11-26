import type { ColleaguePrMode } from "./pr-state.js";

/**
 * PUÒ PARTIRE una correzione sulla PR di un collega? (area 8, F1, S8;
 * invariante «Le PR dei colleghi», `docs/invariants/pr-corrections.md`). La
 * regola in UN posto: la applicano `enqueueCorrection` (all'accodamento) e il
 * worker (prima del push: una correzione in volo si ferma se nel frattempo è
 * diventata non ammessa).
 *
 * - «spento» sul repository: mai;
 * - «Solo analisi» sulla singola PR: mai, nemmeno chiesta (si toglie per
 *   correggere);
 * - «solo analisi» sul repository: nessun giro AUTOMATICO (P-2 = a: nessuna
 *   correzione parte da sola) e nessun «Request changes» della piattaforma
 *   (lo può fare un revisore qualunque: (O) di 46, 13 nov 2026); solo
 *   «Chiedi modifiche» in Stubwise (`requested`, chi ha `prs.adopt`);
 * - «analisi e correzioni», o la PR adottata esplicitamente (le rotte di
 *   adozione dei client vecchi): anche il giro automatico.
 *
 * Le regole del ramo (fork, protetti, default, target, rilascio,
 * `stubwise/…`) NON sono qui: sono `colleaguePrBlock`, verificate dal
 * provider. Questa dice solo se l'impostazione la lascia partire.
 */
export function colleagueCorrectionAllowed(i: {
  mode: ColleaguePrMode;
  prAnalysisOnly: boolean;
  /** Adottata da una persona (rotta di adozione), non dal sistema. */
  explicitlyAdopted: boolean;
  /**
   * `automatic`: il giro dopo una review; `provider`: «Request changes» della
   * piattaforma; `requested`: «Chiedi modifiche» (o la ripresa) in Stubwise.
   */
  trigger: "automatic" | "provider" | "requested";
}): boolean {
  if (i.mode === "off" || i.prAnalysisOnly) return false;
  if (i.trigger === "requested") return true;
  return i.mode === "analyze_and_fix" || i.explicitlyAdopted;
}
