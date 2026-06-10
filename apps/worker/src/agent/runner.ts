/**
 * Astrazione sull'agente AI che esegue triage e fix nella pipeline.
 *
 * La pipeline (Task 23/24) chiama AgentRunner due volte per job: triage
 * (model "haiku", pochi turni) e fix (model di default, ~80 turni, timeout
 * lungo). L'implementazione reale (ClaudeCliRunner) shella sul CLI `claude`
 * in modalità headless; FakeAgentRunner permette di testare la pipeline
 * senza quota né modello.
 *
 * Contratto degli errori:
 * - un exit code NON-ZERO è un risultato valido (viene restituito, mai
 *   lanciato): è la pipeline a decidere cosa significa;
 * - AgentRunError per i fallimenti di spawn/opzioni non valide (l'agente
 *   non è mai partito o non è terminato in modo interpretabile);
 * - AgentTimeoutError per i timeout, con l'output parziale: la pipeline
 *   tratta il timeout in modo distinto (job fallito con log).
 */

export interface AgentRunOptions {
  /** Working directory dell'agente (il worktree del job). */
  cwd: string;
  /** Prompt completo (può contenere contenuto non fidato del ticket). */
  prompt: string;
  /** Modello, es. "haiku" per il triage; omesso = default del CLI. */
  model?: string;
  /** Numero massimo di turni agentici (> 0). */
  maxTurns: number;
  /** Timeout complessivo in millisecondi (> 0). */
  timeoutMs: number;
}

export interface AgentRunResult {
  /** stdout + stderr combinati del processo agente. */
  output: string;
  /** Exit code del processo: non-zero è un risultato, non un errore. */
  exitCode: number;
}

export interface AgentRunner {
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * Errore tipato per i fallimenti che impediscono di avere un risultato:
 * opzioni non valide (maxTurns/timeoutMs ≤ 0) o spawn fallito (binario
 * mancante, permessi, kill da segnale esterno). NON copre gli exit code
 * non-zero, che sono risultati validi restituiti al chiamante.
 */
export class AgentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunError";
  }
}

/**
 * Errore tipato per i timeout: porta con sé l'output parziale prodotto
 * prima del kill, così la pipeline può fallire il job allegando il log.
 */
export class AgentTimeoutError extends Error {
  /** Output (stdout+stderr) prodotto prima che il processo venisse ucciso. */
  readonly partialOutput: string;
  /** Il timeout configurato che è stato superato. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, partialOutput: string) {
    super(`Agente ucciso dopo il timeout di ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
    this.partialOutput = partialOutput;
    this.timeoutMs = timeoutMs;
  }
}
