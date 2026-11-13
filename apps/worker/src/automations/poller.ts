import type { Db } from "@stubwise/db";
import { consumeAutomationEvents } from "./consumer.js";
import { fireSchedules } from "./schedules.js";

/**
 * Il poller delle AUTOMATIONS (area 7, fetta 1): a ogni giro il consumatore
 * degli eventi, poi l'esecutore. Task SEPARATO dal loop dei job e FUORI dal
 * serializer per-progetto (il motore non tocca mirror né worktree, C6): la
 * mutua esclusione la danno `SKIP LOCKED` sugli eventi e il lease sulle
 * esecuzioni, quindi più worker possono girare insieme. Mai due giri insieme
 * nello stesso processo. Best-effort: un guasto si scrive nel log e il giro
 * dopo riprova; un riavvio non perde niente (tutto lo stato è nel DB).
 */
export interface AutomationsPollerDeps {
  db: Db;
  intervalSeconds: number;
  signal: AbortSignal;
  log?: (msg: string) => void;
  /** Il passo dell'esecutore (`executeDueRuns`); assente = solo il consumatore. */
  execute?: () => Promise<unknown>;
}

export async function pollAutomationsOnce(deps: Omit<AutomationsPollerDeps, "intervalSeconds" | "signal">): Promise<void> {
  const log = deps.log ?? (() => {});
  try {
    // Finché ce n'è: un batch pieno ne lascia altri.
    while ((await consumeAutomationEvents({ db: deps.db, log })) > 0) {
      /* il prossimo batch */
    }
  } catch (err) {
    log(`[automations] consumo degli eventi non riuscito: ${String(err)}`);
  }
  try {
    // Gli inizi a orario (F2, S7): una volta per automazione e giorno, per vincolo.
    await fireSchedules(deps.db, new Date(), log);
  } catch (err) {
    log(`[automations] inizi a orario non riusciti: ${String(err)}`);
  }
  if (!deps.execute) return;
  try {
    await deps.execute();
  } catch (err) {
    log(`[automations] esecutore non riuscito: ${String(err)}`);
  }
}

export function startAutomationsPoller(deps: AutomationsPollerDeps): () => void {
  if (deps.intervalSeconds <= 0) return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running || deps.signal.aborted) return;
    running = true;
    void pollAutomationsOnce(deps).finally(() => {
      running = false;
    });
  }, deps.intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
  const stop = () => clearInterval(timer);
  deps.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
