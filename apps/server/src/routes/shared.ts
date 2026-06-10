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
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as Error & { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}
