import type { FastifyReply } from "fastify";

/**
 * Invia una risposta di errore user-facing standard: `{ code, message }` con
 * `code` stabile (snake_case, indipendente dalla lingua, pensato per la UI)
 * e `message` in inglese come fallback leggibile. Gli errori di validazione
 * Zod (FST_ERR_VALIDATION) restano auto-generati e senza `code`.
 */
export function apiError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ code, message });
}
