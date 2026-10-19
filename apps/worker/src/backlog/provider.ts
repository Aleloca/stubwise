import type { AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import {
  isQuotaWait,
  limitTextOfRun,
  runWithProviders,
  selectProviders,
  type EmptyReason,
  type SelectDeps,
} from "../providers/select.js";

/**
 * Scelta dell'account per i run del backlog (intake, stima, turno di
 * refinement): un involucro su `runWithProviders`
 * (providers/select.ts, la stessa scelta di ogni run `claude` del worker), in
 * un modulo a sé per NON creare un ciclo di import a livello di valore fra
 * poller.ts (importa runIntake/runEstimate) e i moduli che eseguono i run.
 *
 * Tutti questi run sono `interactive` (design 2026-10-15 §2.9). Il provider
 * del progetto è PREFERITO (con «solo questo» è l'unico); un run finito al
 * limite marca l'account e si riprova col successivo, nello stesso turno.
 *
 * Gli esiti che non sono un run riuscito diventano ECCEZIONI, perché i
 * chiamanti già trattano un'eccezione come «questo run non c'è stato»:
 * - nessun account disponibile per QUOTA → {@link NoAccountAvailableError}:
 *   il chiamante decide (stima/intake tornano in coda restituendo il
 *   tentativo; il refinement lo dice nella sessione);
 * - motivo di CONFIGURAZIONE (provider esclusivo sparito, segreti non
 *   decifrabili) → un Error normale che nomina il motivo: la coda segue la
 *   sua regola dei tentativi (rimettere in coda per sempre un lavoro che
 *   nessun account potrà mai fare sarebbe un ciclo);
 * - auth storica (nessun provider abilitato) finita al limite → un Error col
 *   testo del limite, mai «agente uscito con exit N»: senza un account da
 *   marcare non c'è un'ora di ripresa da aspettare.
 */

/** Nessun account disponibile per quota: «aspetta che torni margine», non un fallimento. */
export class NoAccountAvailableError extends Error {
  constructor(
    readonly reason: EmptyReason | "all_limited_now",
    label: string,
  ) {
    super(`${label}: nessun account AI disponibile (${reason})`);
    this.name = "NoAccountAvailableError";
  }
}

/** Prima riga non vuota del testo del limite, per un messaggio d'errore leggibile. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? text
  ).slice(0, 300);
}

/**
 * Esegue `attempt` sugli account scelti per il progetto. Restituisce il valore
 * del primo tentativo che NON è finito al limite; vedi il docblock del modulo
 * per gli altri esiti. `label` identifica il run nei messaggi d'errore.
 */
export async function runBacklogWithProviders<T>(
  deps: { select: SelectDeps },
  projectId: string,
  label: string,
  attempt: (provider: ResolvedProvider | undefined) => Promise<T>,
  limitTextOf: (value: T) => string | null,
): Promise<T> {
  const run = await runWithProviders(
    deps.select,
    { projectId, workClass: "interactive" },
    attempt,
    limitTextOf,
  );
  if (run.kind === "done") return run.value;
  if (run.kind === "legacy_limited") {
    throw new Error(`${label}: provider AI al limite d'uso (${firstLine(run.limitText)})`);
  }
  throwUnavailable(deps, projectId, label, run.reason);
}

/** Nessun account: quota → NoAccountAvailableError, configurazione → Error col motivo (e una riga di log). */
function throwUnavailable(
  deps: { select: SelectDeps },
  projectId: string,
  label: string,
  reason: EmptyReason | "all_limited_now",
): never {
  if (isQuotaWait(reason)) throw new NoAccountAvailableError(reason, label);
  deps.select.log?.(
    `[stubwise-worker] ${label}: nessun provider AI utilizzabile per il progetto ${projectId} (${reason})`,
  );
  throw new Error(
    reason === "exclusive_unavailable"
      ? `${label}: provider AI del progetto non disponibile (disabilitato o eliminato)`
      : `${label}: nessun provider AI utilizzabile (segreti non decifrabili)`,
  );
}

/**
 * Controllo ECONOMICO prima del lavoro che costa (embedding, retrieval): una
 * sola lettura della scelta. Nessun account → lancia come
 * {@link runBacklogWithProviders}, così un job in attesa non paga un
 * embedding a ogni tick a vuoto. Il run rifà comunque la sua scelta.
 */
export async function assertAccountAvailable(
  deps: { select: SelectDeps },
  projectId: string,
  label: string,
): Promise<void> {
  const selection = await (deps.select.selectProvidersFn ?? selectProviders)(deps.select, {
    projectId,
    workClass: "interactive",
  });
  if (selection.legacyAuth || selection.candidates.length > 0) return;
  throwUnavailable(deps, projectId, label, selection.emptyReason ?? "all_limited");
}

/** {@link runBacklogWithProviders} per il caso comune: un run del CLI per tentativo. */
export function runBacklogAgent(
  deps: { select: SelectDeps },
  projectId: string,
  label: string,
  attempt: (provider: ResolvedProvider | undefined) => Promise<AgentRunResult>,
): Promise<AgentRunResult> {
  return runBacklogWithProviders(deps, projectId, label, attempt, limitTextOfRun);
}
