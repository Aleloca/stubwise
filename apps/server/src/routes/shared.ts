import { z } from "zod";

/** Corpo standard delle risposte di errore JSON: `{ message }`. */
export const errorSchema = z.object({ message: z.string() });

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
