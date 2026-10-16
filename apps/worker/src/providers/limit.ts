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
  // Testi del CLI 2.1.287 (ott 2026), forma «You've hit your … limit · resets …».
  "hit your session limit",
  "hit your weekly limit",
  "hit your usage limit",
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

  // Il limite già riconosciuto da una fase di pipeline (il suo messaggio non
  // porta marcatori: il testo vero sta in agentOutput).
  if (input instanceof ProviderLimitError) return true;

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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * Ora del reset annunciata dal CLI nel testo del limite («resets 6pm (UTC)»,
 * «resets Oct 14, 1:30pm (UTC)»). Solo UTC: è l'unico fuso che il CLI usa nei
 * testi osservati. Senza data: oggi se l'ora è futura, altrimenti domani. Con la
 * data: quest'anno, o il prossimo se la data è già passata da più di un giorno.
 * Null se il testo non ha un reset riconoscibile (il chiamante ripiega sullo
 * snapshot o su un'attesa fissa).
 */
export function limitResetAt(text: string, now: Date): Date | null {
  const at = parseLimitResetAt(text, now);
  if (!at) return null;
  // Un reset oltre una settimana non esiste (la finestra più lunga è
  // settimanale): è una data vecchia nel testo spinta all'anno dopo, e non
  // deve bloccare un account o l'auth storica per mesi.
  const max = now.getTime() + MAX_RESET_AHEAD_MS;
  return at.getTime() > max ? new Date(max) : at;
}

const MAX_RESET_AHEAD_MS = 7 * 86_400_000;

function parseLimitResetAt(text: string, now: Date): Date | null {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(text);
  if (!m) return null;
  let hour = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === "pm") hour += 12;
  const minute = m[4] !== undefined ? Number(m[4]) : 0;
  if (m[1] !== undefined) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    let at = new Date(Date.UTC(now.getUTCFullYear(), month, Number(m[2]), hour, minute));
    if (at.getTime() < now.getTime() - 86_400_000) {
      at = new Date(Date.UTC(now.getUTCFullYear() + 1, month, Number(m[2]), hour, minute));
    }
    return at;
  }
  let at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000);
  return at;
}
