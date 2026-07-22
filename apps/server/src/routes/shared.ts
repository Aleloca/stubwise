import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Genera una chiave di ingestion per gli SDK: 32 caratteri esadecimali (16
 * byte casuali). Dalla Fase 3 l'ingestion è a livello di PROGETTO (D8): la
 * chiave si genera alla creazione del progetto. Lo stesso generatore serviva
 * finora ai repository; è estratto qui per un'unica fonte di verità sul formato
 * (32 hex), atteso dagli SDK già distribuiti e dai test.
 */
export function generateIngestionKey(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Genera la chiave dell'agente di monitoraggio server (`sk_` + 48 hex, 24 byte
 * casuali). È l'unica volta che la chiave esiste in chiaro: si mostra all'admin
 * alla registrazione del server, poi si persiste solo il suo hash
 * ({@link hashServerKey}). L'agente la invia nell'header X-Stubwise-Server-Key.
 */
export function generateServerKey(): string {
  return `sk_${randomBytes(24).toString("hex")}`;
}

/** Prefisso dei Personal Access Token: unica fonte di verità, usata anche in auth/session.ts. */
export const PAT_PREFIX = "stw_pat_";

/** Personal Access Token: {@link PAT_PREFIX} + 24 byte esadecimali. In DB si salva solo hashServerKey(token). */
export function generatePat(): string {
  return `${PAT_PREFIX}${randomBytes(24).toString("hex")}`;
}

/**
 * Hash sha256 (hex) della chiave dell'agente: è ciò che si persiste in
 * `servers.key_hash`. All'ingest si ri-hasha la chiave ricevuta e si cerca la
 * riga sulla colonna unique — nessun confronto in tempo variabile utile a un
 * attaccante e nessuna chiave in chiaro a riposo.
 */
export function hashServerKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Corpo standard delle risposte di errore JSON: `{ message }` più un `code`
 * stabile (snake_case) opzionale. Gli errori user-facing espliciti
 * (vedi `apiError`) valorizzano `code`; gli errori di validazione Zod
 * auto-generati no, perciò resta opzionale.
 */
export const errorSchema = z.object({ code: z.string().optional(), message: z.string() });

/**
 * `schemaErrorFormatter` per-route che alza a 422 lo statusCode dell'errore di
 * validazione Zod (Fastify default-a 400 solo se non è già impostato). Serve
 * alle superfici pubbliche (ingestion SDK, widget) il cui contratto col client
 * prevede 422 (Unprocessable Entity) su body malformato, non 400. Da passare
 * come `schemaErrorFormatter` nelle opzioni della route.
 */
export function unprocessableEntityFormatter(
  errors: Array<{ instancePath: string; message?: string; keyword: string }>,
  dataVar: string,
): Error & { statusCode: number } {
  const error = new Error(
    `${dataVar} non valido: ${errors
      .map((e) => `${e.instancePath} ${e.message ?? e.keyword}`.trim())
      .join("; ")}`,
  ) as Error & { statusCode: number };
  error.statusCode = 422;
  return error;
}

/**
 * Configurazione di un limite di rate per @fastify/rate-limit: quante
 * richieste (`max`) per finestra (`timeWindow`, es. "1 minute").
 */
export interface RateLimitConfig {
  max: number;
  timeWindow: number | string;
}

/**
 * Risposte di errore prodotte dai preHandler requireAuth/requireAdmin.
 * Da spalmare nello schema `response` delle route protette.
 */
export const authErrorResponses = {
  401: errorSchema,
  403: errorSchema,
} as const;

/**
 * Riconosce una violazione di vincolo unique di Postgres (codice 23505)
 * risalendo la catena dei `cause`: Drizzle incapsula l'errore del driver.
 */
export function isUniqueViolation(error: unknown): boolean {
  return hasPostgresCode(error, "23505");
}

/**
 * Riconosce una violazione di foreign key di Postgres (codice 23503),
 * stessa risalita della catena dei `cause` di isUniqueViolation.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPostgresCode(error, "23503");
}

/** Cerca un codice errore Postgres risalendo la catena dei `cause`. */
function hasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as Error & { code?: unknown }).code === code) return true;
    current = current.cause;
  }
  return false;
}
