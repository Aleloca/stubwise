import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { SecondFactorAttempt } from "../auth/second-factor/index.js";
import { apiError } from "../errors.js";
import { errorSchema } from "./shared.js";

/**
 * Le risposte HTTP di un tentativo di secondo fattore non riuscito, UGUALI su
 * ogni porta che passa da `attemptSecondFactor` (login, riconferma, …): il
 * client le traduce una volta sola.
 */

/** 423 del passo bloccato: oltre al codice, fino a quando. */
export const lockedErrorSchema = errorSchema.extend({ lockedUntil: z.iso.datetime() });

function sendLocked(reply: FastifyReply, until: Date): FastifyReply {
  return reply.code(423).send({
    code: "second_factor_locked",
    message: "Too many wrong codes, second factor locked",
    lockedUntil: until.toISOString(),
  });
}

/**
 * Tentativo non riuscito. Bloccato (anche dal tentativo che fa scattare il
 * blocco, così il client lo sa subito) → 423; codice non valutato perché il
 * tetto è pieno di tentativi in volo → 429 (si riprova); sbagliato → 401.
 */
export function rejectAttempt(
  reply: FastifyReply,
  failure: Extract<SecondFactorAttempt<unknown>, { ok: false }>,
): FastifyReply {
  if (failure.reason === "locked") return sendLocked(reply, failure.lockedUntil);
  if (failure.reason === "busy") {
    return apiError(reply, 429, "second_factor_busy", "Too many attempts in progress, retry");
  }
  return apiError(reply, 401, "invalid_second_factor", "Invalid second factor code");
}
