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

import type { ResolvedProvider } from "../providers/chain.js";

/**
 * Un singolo server MCP **stdio** locale al run: il CLI lo lancia come processo
 * figlio. Solo stdio (niente SSE/HTTP) perché l'unico caso d'uso è un binario
 * bundlato nell'immagine del worker.
 */
export interface AgentMcpServerConfig {
  /** Eseguibile da lanciare (path o nome in PATH), es. "node". */
  command: string;
  /** Argomenti dell'eseguibile, es. ["/app/dist/ask-user-mcp/index.js"]. */
  args?: string[];
  /**
   * Variabili d'ambiente del SERVER MCP (non del CLI). Viaggiano dentro il file
   * di configurazione, mai nell'allowlist dell'env del CLI: è così che un
   * bridge locale al run riceve i suoi parametri (es. il path del file su cui
   * scrivere) senza che l'allowlist debba essere allargata.
   */
  env?: Record<string, string>;
}

/**
 * Server MCP da abilitare per QUESTO run, e solo per questo run. Il runner li
 * serializza in un file di configurazione effimero e li passa al CLI con
 * `--mcp-config` + `--strict-mcp-config` (quest'ultimo ignora ogni altra
 * configurazione MCP: nei run del worker devono esistere solo questi server).
 * Le chiavi sono i nomi dei server: il tool corrispondente si chiama poi
 * `mcp__<nome>__<tool>` negli `allowedTools`.
 */
export interface AgentMcpConfig {
  servers: Record<string, AgentMcpServerConfig>;
}

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
  /**
   * Server MCP locali a questo run (vedi AgentMcpConfig). Assente o senza
   * server = nessun `--mcp-config`, comportamento storico. Abilitare un server
   * NON ne abilita i tool: vanno elencati anche in `allowedTools` con il nome
   * `mcp__<server>__<tool>`.
   */
  mcpConfig?: AgentMcpConfig;
  /**
   * Permission mode del CLI claude, mappato su `--permission-mode <mode>`:
   * - "acceptEdits" (default): consente le modifiche ai file ma NEGA Bash in
   *   headless (i comandi vanno abilitati via allowedTools). È la modalità del
   *   run di esecuzione del fix.
   * - "plan": modalità di SOLA ANALISI — il modello esplora (Read/Grep/Glob) e
   *   propone un piano senza modificare file. È la modalità del run di
   *   pianificazione del fix (il modello "costoso", read-only).
   * - "default": permission mode di default del CLI.
   */
  permissionMode?: "default" | "acceptEdits" | "plan";
  /** Numero massimo di turni agentici (> 0). */
  maxTurns: number;
  /** Timeout complessivo in millisecondi (> 0). */
  timeoutMs: number;
  /**
   * Id di una sessione CLI claude da RIPRENDERE, mappato su `--resume <id>`. Il
   * modello ricarica il contesto della sessione (cosa ha già esplorato) e il
   * `prompt` è solo il nuovo turno. Usato dalla sessione di analisi sul codice
   * del backlog: il primo turno omette resumeSessionId (nuova sessione, prompt
   * di priming) e ne ricava il `sessionId` dal risultato; i turni successivi lo
   * passano con la sola domanda. Omesso = nessuna ripresa (sessione nuova).
   */
  resumeSessionId?: string;
  /**
   * Credenziale del provider AI da usare per QUESTO run, risolta dalla catena
   * (vedi providers/chain.ts). Determina come si autentica il CLI claude:
   *  - kind "api_key" → ANTHROPIC_API_KEY (e si esclude CLAUDE_CODE_OAUTH_TOKEN);
   *  - kind "account" → CLAUDE_CODE_OAUTH_TOKEN (e si esclude ANTHROPIC_API_KEY).
   * Assente (catena vuota) → comportamento storico: auth dall'env del container
   * (ANTHROPIC_API_KEY se presente) o dall'OAuth del volume ~/.claude.
   */
  provider?: ResolvedProvider;
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
  /**
   * Id della sessione CLI del run, estratto dal campo `session_id` del JSON del
   * CLI (parse difensivo). È l'id da passare come `resumeSessionId` al turno
   * successivo della sessione di analisi sul codice. Assente quando il CLI non
   * lo riporta (versione vecchia, parse fallito o output non-JSON): il chiamante
   * ricade sul ri-priming a ogni turno (degradato ma funzionante).
   */
  sessionId?: string;
}

export interface AgentRunner {
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * Errore tipato per i fallimenti che impediscono di avere un risultato:
 * opzioni non valide (maxTurns/timeoutMs ≤ 0), preparazione del run fallita
 * (es. la config MCP non scrivibile) o spawn fallito (binario mancante,
 * permessi, kill da segnale esterno). NON copre gli exit code non-zero, che
 * sono risultati validi restituiti al chiamante.
 *
 * `options.cause` conserva l'errore originale (es. l'errore fs) quando il
 * messaggio è una traduzione: il log del job resta leggibile, la diagnostica
 * non si perde.
 */
export class AgentRunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
