import { AgentRunError, AgentTimeoutError, type AgentRunResult } from "../agent/runner.js";

/**
 * Rilevamento BEST-EFFORT di un errore di limite di RATE/USAGE del provider AI:
 * il segnale che la credenziale corrente è temporaneamente esaurita e conviene
 * provare la prossima della catena (failover, vedi handler.ts), invece di
 * fallire il job.
 *
 * È volutamente CONSERVATIVO: distingue il limite dai normali fallimenti del
 * fix/triage (output malformato, test rossi, bug del modello) e dai timeout o
 * dagli spawn falliti. Nel dubbio NON è un limite — un falso positivo
 * brucerebbe una credenziale buona, un falso negativo fa solo fallire il job
 * come oggi (recuperabile a mano). I marcatori coprono due forme:
 *
 *  - ABBONAMENTO (kind "account"): il CLI claude stampa nel testo qualcosa come
 *    "usage limit reached", "rate limit", "limit reached", "limit exceeded".
 *  - API KEY (kind "api_key"): l'API Anthropic risponde 429 con
 *    "rate_limit_error" o, sotto carico, "overloaded"/"overloaded_error" (529).
 *
 * I marcatori sono cercati case-insensitive nell'output combinato del runner.
 * NON ci basiamo su un exit code specifico (varia per versione del CLI): un
 * limite arriva come exit non-zero con il messaggio sopra. I timeout
 * (AgentTimeoutError) e gli spawn falliti (AgentRunError, binario mancante) NON
 * sono limiti.
 *
 * Accetta sia un AgentRunResult (esito normale del runner, anche con exit
 * non-zero) sia un errore lanciato (Error/unknown): così il chiamante può
 * passare indifferentemente il risultato o l'eccezione catturata.
 */

/** Marcatori (case-insensitive) di un limite di rate/usage. Best-effort. */
const LIMIT_MARKERS: readonly string[] = [
  "usage limit reached",
  "rate limit",
  "rate_limit",
  "rate_limit_error",
  "limit reached",
  "limit exceeded",
  "too many requests",
  "429",
  "overloaded",
  "overloaded_error",
];

function textHasLimitMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return LIMIT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * True se l'input rappresenta, best-effort, un errore di limite di rate/usage.
 *
 * - AgentTimeoutError / AgentRunError → MAI un limite (timeout, spawn fallito).
 * - AgentRunResult → limite solo se exit non-zero E l'output contiene un
 *   marcatore (un exit 0 è un successo, non un limite, anche se per assurdo
 *   l'output nominasse "rate limit").
 * - Error / stringa / altro → limite se il messaggio contiene un marcatore.
 */
export function isLimitError(input: AgentRunResult | Error | unknown): boolean {
  // I timeout e gli spawn falliti non sono limiti: sono altri modi di fallire.
  if (input instanceof AgentTimeoutError || input instanceof AgentRunError) return false;

  // Esito del runner: limite solo su exit non-zero con marcatore nell'output.
  if (isAgentRunResult(input)) {
    if (input.exitCode === 0) return false;
    return textHasLimitMarker(input.output);
  }

  if (input instanceof Error) return textHasLimitMarker(input.message);
  if (typeof input === "string") return textHasLimitMarker(input);
  return false;
}

/** Type guard difensivo per AgentRunResult (output stringa + exitCode numero). */
function isAgentRunResult(value: unknown): value is AgentRunResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["output"] === "string" && typeof v["exitCode"] === "number";
}

/**
 * Un run dell'agente è fallito per LIMITE di rate/usage del provider (vedi
 * isLimitError). Lanciato dentro le fasi di pipeline (triage/fix) NON appena un
 * runner.run torna un esito-limite, PRIMA di qualunque effetto osservabile
 * (push del branch, apertura PR): il limite blocca la CHIAMATA, non un lavoro
 * già materializzato. Triage/fix lo catturano e tornano l'esito "limit" SENZA
 * chiudere il job (niente failJob): è il wiring del worker (handler.ts) a
 * decidere il failover sulla credenziale successiva o l'held se la catena è
 * esaurita. Porta con sé l'output dell'agente per il log.
 */
export class ProviderLimitError extends Error {
  readonly agentOutput: string;
  constructor(agentOutput: string) {
    super("provider AI al limite di rate/usage");
    this.name = "ProviderLimitError";
    this.agentOutput = agentOutput;
  }
}
