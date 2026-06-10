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
