import type { AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import {
  isQuotaWait,
  limitTextOfRun,
  runWithProviders,
  type EmptyReason,
  type SelectDeps,
} from "../providers/select.js";

/**
 * Scelta dell'account per i run del backlog (intake, stima, deep dive, chat
 * CODE, turno di refinement): un involucro su `runWithProviders`
 * (providers/select.ts, la stessa scelta di ogni run `claude` del worker), in
 * un modulo a sé per NON creare un ciclo di import a livello di valore fra
 * poller.ts (importa runDeepDive) e i moduli che eseguono i run.
 *
 * Tutti questi run sono `interactive` (design 2026-10-15 §2.9). Il provider
 * del progetto è PREFERITO (con «solo questo» è l'unico); un run finito al
 * limite marca l'account e si riprova col successivo, nello stesso turno.
 *
 * Gli esiti che non sono un run riuscito diventano ECCEZIONI, perché i
 * chiamanti già trattano un'eccezione come «questo run non c'è stato»:
 * - nessun account disponibile per QUOTA → {@link NoAccountAvailableError}:
 *   il chiamante decide (stima/intake tornano in coda restituendo il
 *   tentativo; chat CODE, deep dive e refinement lo dicono nella chat);
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
  if (isQuotaWait(run.reason)) throw new NoAccountAvailableError(run.reason, label);
  deps.select.log?.(
    `[stubwise-worker] ${label}: nessun provider AI utilizzabile per il progetto ${projectId} (${run.reason})`,
  );
  throw new Error(
    run.reason === "exclusive_unavailable"
      ? `${label}: provider AI del progetto non disponibile (disabilitato o eliminato)`
      : `${label}: nessun provider AI utilizzabile (segreti non decifrabili)`,
  );
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
