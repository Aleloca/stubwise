import type { StubwiseClient } from "@stubwise/api-client";
import { createAutomationRefs } from "./automationRefs";
import { createRealAutomations, type AutomationsApi } from "./automations";
import { appClient } from "./client";
import { notIntegrated } from "./notIntegrated";

// Le Automations della build app sul client vero (area 7, F1): gli
// adattatori di `automations.ts` e `automationDecisions.ts` sopra
// `client.automations`, un registro dei riferimenti per sessione.
//
// Le rotte che il server non ha ancora (la sezione del progetto, la riga
// d'origine) rifiutano come «non integrate»; la prova aspetta
// `GET …/examples` e resta fuori.

/** Le rotte che `client.automations` non ha ancora. */
type Pending = "projectAutomations" | "origin";

// Il client copre il resto dell'interfaccia: se una firma diverge, qui non compila.
const fromClient: (c: StubwiseClient["automations"]) => Omit<AutomationsApi, Pending> = (c) => c;

const pending: Pick<AutomationsApi, Pending> = {
  projectAutomations: notIntegrated("automations.getProjectAutomations"),
  origin: notIntegrated("automations.automationOrigin"),
};

/** Il client si prende a ogni chiamata (`appClient()` è pigro e i test lo cambiano). */
const liveApi = new Proxy({} as AutomationsApi, {
  get(_target, key: string) {
    if (key in pending) return pending[key as Pending];
    const c = fromClient(appClient().automations) as unknown as Record<string, unknown>;
    const fn = c[key];
    return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).bind(c) : fn;
  },
});

const refs = createAutomationRefs();

export const liveAutomations = createRealAutomations(liveApi, refs);

/** Al cambio di sessione: codici e revisioni letti erano della persona di prima. */
export function forgetAutomationRefs(): void {
  refs.clear();
}
