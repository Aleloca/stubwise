import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import type { AutomationSearchResult } from "@stubwise/shared";
import { isIntegrated } from "../../integration";
import { createAutomationRefs, inPrototypeWords } from "./automationRefs";
import { createRealAutomations, type AutomationsApi } from "./automations";
import { SimulationConfigError } from "../../../domain/automations/simCore";
import { createRealSimulation } from "./automationSimulate";
import { appClient, session } from "./client";
import { citableSearch } from "./globalSearch";
import { myAccounts } from "./google";
import { now } from "./runtime";

// Le Automations della build app sul client vero (area 7, F1): gli
// adattatori di `automations.ts`, `automationDecisions.ts` e
// `automationSimulate.ts` sopra `client.automations`, con un registro dei
// riferimenti per sessione. La destinazione è accesa nella build app (R8).

// Il client copre l'interfaccia: se una firma diverge, qui non compila.
const fromClient: (c: StubwiseClient["automations"]) => AutomationsApi = (c) => c;

/** Il client si prende a ogni chiamata (`appClient()` è pigro e i test lo cambiano). */
const liveApi = new Proxy({} as AutomationsApi, {
  get(_target, key: string) {
    const c = fromClient(appClient().automations) as unknown as Record<string, unknown>;
    const fn = c[key];
    return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).bind(c) : fn;
  },
});

const refs = createAutomationRefs();

const simulation = createRealSimulation({
  me: () => session.personId ?? "",
  now: () => now(),
  examples: (automationId, version) =>
    inPrototypeWords(() =>
      appClient().automations.examples(refs.automation(automationId).code, version),
    ),
  async markTested(automationId, body) {
    try {
      await appClient().automations.markTested(refs.automation(automationId).code, body);
    } catch (error) {
      // La bozza è cambiata mentre si provava: la prova resta valida a schermo, ma non segna quella rev.
      if (error instanceof ApiError && error.status === 409 && error.code === "stale") return;
      throw error;
    }
  },
});

const { reset: resetSimulations, forgetContext, ...simulationFunctions } = simulation;

/**
 * ⌘K: il gruppo `automations` di `GET /api/search` (filtrato dal server). A
 * destinazione spenta non si cerca: un risultato porterebbe a «in arrivo».
 */
async function searchAutomations(q: string): Promise<AutomationSearchResult[]> {
  const needle = q.trim();
  if (!needle || !isIntegrated({ kind: "destination", name: "automations" })) return [];
  // La stessa risposta delle task di ⌘K (`globalSearch.ts`): una ricerca per tasto.
  const results = await inPrototypeWords(() => citableSearch(needle));
  // `readerSchema` apre gli enum: un tipo che questo client non conosce non si mostra.
  return (results.automations?.items ?? []).filter(
    (h): h is AutomationSearchResult => h.kind === "automation" || h.kind === "run",
  );
}

const real = createRealAutomations(liveApi, refs, undefined, () => myAccounts());
const { saveDraft: saveDraftOnly, ...realFunctions } = real;

/** Salvare la bozza cambia il flusso: la prova dopo rilegge il contesto. */
const saveDraft: typeof saveDraftOnly = async (id, ...rest) => {
  const saved = await saveDraftOnly(id, ...rest);
  forgetContext(id);
  return saved;
};

export const liveAutomations = {
  searchAutomations,
  // Le esecuzioni le muove il worker, e il client non riceve eventi: nessun
  // avviso da qui (le pagine rileggono quando si rimontano o dopo una
  // scrittura). Dopo una scrittura, «idle» aspetta che il worker abbia
  // applicato gli input in coda (`automationSettle.ts`), al più 10 s.
  onAutomationsSettled: (fn: () => void): (() => void) => {
    void fn;
    return () => {};
  },
  SimulationConfigError,
  ...realFunctions,
  saveDraft,
  ...simulationFunctions,
};

/** Al cambio di sessione: codici, revisioni e prove erano della persona di prima. */
export function forgetAutomationRefs(): void {
  refs.clear();
  real.forgetQueuedInputs();
  resetSimulations();
}
