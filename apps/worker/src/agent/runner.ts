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
  /**
   * Pattern di tool da consentire oltre a quelli del permission-mode, es.
   * ["Bash(npm test:*)", "Bash(pnpm test:*)"]. Necessario per la fase di fix:
   * acceptEdits da solo NEGA Bash in headless, ma il prompt di fix chiede
   * all'agente di eseguire i test. Omesso = nessun tool extra.
   */
  allowedTools?: string[];
  /** Numero massimo di turni agentici (> 0). */
  maxTurns: number;
  /** Timeout complessivo in millisecondi (> 0). */
  timeoutMs: number;
}

/**
 * Consumo di un singolo modello dentro un run dell'agente. Un run può usarne
 * più d'uno (es. subagent), quindi `usage.models` è una lista. I conteggi sono
 * sempre presenti (default 0); `costUsd` è opzionale perché il CLI può non
 * riportarlo (versione vecchia, chiave senza usage nel JSON).
 */
export interface AgentModelUsage {
  /** Identificativo del modello riportato dal CLI (es. "claude-opus-4-8"). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd?: number;
}

/**
 * Consumi complessivi di un run, estratti dal JSON del CLI. Sempre opzionale
 * su AgentRunResult: se il CLI non riporta usage (o il parse fallisce), il
 * campo è semplicemente undefined — il run resta valido, manca solo il dato.
 */
export interface AgentRunUsage {
  /** Costo totale in USD del run, se riportato (`total_cost_usd`). */
  totalCostUsd?: number;
  /** Una voce per modello usato nel run (da `modelUsage`). */
  models: AgentModelUsage[];
}

export interface AgentRunResult {
  /** stdout + stderr combinati del processo agente. */
  output: string;
  /** Exit code del processo: non-zero è un risultato, non un errore. */
  exitCode: number;
  /**
   * Consumi (token + costo) del run, se estratti dal JSON del CLI. Assente
   * quando il CLI non li riporta o il parse fallisce: mai un errore, solo un
   * dato mancante.
   */
  usage?: AgentRunUsage;
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
