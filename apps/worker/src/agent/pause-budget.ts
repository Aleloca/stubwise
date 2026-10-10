// apps/worker/src/agent/pause-budget.ts

/**
 * Tetto TOTALE della pausa di un lavoro (design queue-stop §2): la somma di
 * tutte le pause («Ferma» senza testo) di un job, su tutti i suoi segmenti.
 * Una pausa che supera ciò che resta scade a ciò che resta. Configurabile
 * SOLO nei test (`StreamingClaudeRunner({ pauseBudgetMs })`), mai da env:
 * entra UNA volta nel conto di `assertStaleInvariant` (index.ts), e un valore
 * diverso in produzione renderebbe falso quel conto.
 */
export const AGENT_PAUSE_BUDGET_MS = 10 * 60_000;

/**
 * Quante chiavi si ricordano al più. Il worker è UN processo e i job in volo
 * sono al più `WORKER_CONCURRENCY` (più i turni di backlog): 256 chiavi non si
 * esauriscono mai con un lavoro ancora vivo, e la memoria resta limitata
 * anche se nessuno dice quando un job è finito.
 */
const MAX_KEYS = 256;

/** Budget consumato per chiave (vedi `AgentRunSession.pauseKey`). In memoria. */
export class PauseBudgets {
  private readonly consumed = new Map<string, number>();

  constructor(readonly totalMs: number = AGENT_PAUSE_BUDGET_MS) {}

  remainingMs(key: string): number {
    return Math.max(0, this.totalMs - (this.consumed.get(key) ?? 0));
  }

  consume(key: string, ms: number): void {
    const next = (this.consumed.get(key) ?? 0) + Math.max(0, ms);
    // Reinserita in coda: la più vecchia è la prima a uscire.
    this.consumed.delete(key);
    this.consumed.set(key, next);
    while (this.consumed.size > MAX_KEYS) {
      const oldest = this.consumed.keys().next().value;
      if (oldest === undefined) break;
      this.consumed.delete(oldest);
    }
  }
}
