import { ApiError, type StubwiseClient } from "@stubwise/api-client";
import { createAutomationRefs, inPrototypeWords } from "./automationRefs";
import { createRealAutomations, type AutomationsApi } from "./automations";
import { createRealSimulation } from "./automationSimulate";
import { appClient, session } from "./client";
import { now } from "./runtime";

// Le Automations della build app sul client vero (area 7, F1): gli
// adattatori di `automations.ts`, `automationDecisions.ts` e
// `automationSimulate.ts` sopra `client.automations`, con un registro dei
// riferimenti per sessione. La destinazione resta spenta finché c'è il flag.

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

const { reset: resetSimulations, ...simulationFunctions } = simulation;

export const liveAutomations = {
  ...createRealAutomations(liveApi, refs),
  ...simulationFunctions,
};

/** Al cambio di sessione: codici, revisioni e prove erano della persona di prima. */
export function forgetAutomationRefs(): void {
  refs.clear();
  resetSimulations();
}
