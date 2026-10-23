import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, onRequestHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions, userPasskeys } from "@stubwise/db";
import {
  enrollConfirmResponseSchema,
  secondFactorCodeBodySchema,
  secondFactorStatusSchema,
  secondFactorVerifyResponseSchema,
  totpEnrollmentResponseSchema,
} from "@stubwise/shared";
import { regenerateBackupCodes, remainingBackupCodes } from "../auth/second-factor/backup-codes.js";
import {
  attemptSecondFactor,
  verifySecondFactorCode,
  type SecondFactorAttempt,
} from "../auth/second-factor/index.js";
import { lockedUntil } from "../auth/second-factor/lockout.js";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { confirmTotp, startTotpEnrollment } from "../auth/second-factor/totp.js";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  SESSION_TTL_MS,
  type SessionUser,
} from "../auth/session.js";
import { apiError } from "../errors.js";
import { errorSchema } from "./shared.js";

/** 423 del passo bloccato: oltre al codice, fino a quando. */
const lockedErrorSchema = errorSchema.extend({ lockedUntil: z.iso.datetime() });

function sendLocked(reply: FastifyReply, until: Date): FastifyReply {
  return reply.code(423).send({
    code: "second_factor_locked",
    message: "Too many wrong codes, second factor locked",
    lockedUntil: until.toISOString(),
  });
}

const errorResponses = {
  401: errorSchema,
  409: errorSchema,
  429: errorSchema,
} as const;

/**
 * Secondo passo del login web (`/api/auth/second-factor`), registrato DENTRO
 * `authRoutes` e con il suo `credentialsRateLimit`: un codice sbagliato costa
 * un tentativo dello stesso bucket per IP della password, perché è una porta
 * sullo stesso account. Il bucket per IP però non basta da solo — chi ha la
 * password può provare i codici da molti IP —, e per questo ogni codice
 * passa anche da `attemptSecondFactor`, il tetto per ACCOUNT (anche con
 * richieste in parallelo).
 *
 * Tutte le rotte sono `{ kind: "second_factor" }`: le raggiunge SOLO una
 * sessione parziale (una completa o un PAT ricevono 409 `second_factor_done`),
 * e lo stadio giusto lo impone l'hook di accesso (`stage`).
 */
export function secondFactorLoginRoutes(
  instance: FastifyInstance,
  credentialsRateLimit: onRequestHookHandler,
): void {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * Promuove la sessione parziale della richiesta a completa: STESSA riga
   * (niente seconda sessione), secondo fattore fatto adesso, durata piena, e
   * cookie riscritto con la durata piena. `false` se la sessione non c'è più
   * (scaduta o chiusa nel frattempo).
   */
  async function promoteSession(reply: FastifyReply, user: SessionUser): Promise<boolean> {
    const updated = await app.db
      .update(sessions)
      .set({
        stage: "full",
        secondFactorAt: sql`now()`,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      })
      .where(and(eq(sessions.id, user.sessionId!), ne(sessions.stage, "full")))
      .returning({ id: sessions.id });
    if (updated.length === 0) return false;
    reply.setCookie(SESSION_COOKIE, user.sessionId!, {
      ...SESSION_COOKIE_OPTIONS,
      signed: true,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return true;
  }

  /**
   * Tentativo non riuscito. Bloccato (anche dal tentativo che fa scattare il
   * blocco, così il client lo sa subito) → 423; codice non valutato perché il
   * tetto è pieno di tentativi in volo → 429 (si riprova); sbagliato → 401.
   */
  function rejectAttempt(
    reply: FastifyReply,
    failure: Extract<SecondFactorAttempt<unknown>, { ok: false }>,
  ): FastifyReply {
    if (failure.reason === "locked") return sendLocked(reply, failure.lockedUntil);
    if (failure.reason === "busy") {
      return apiError(reply, 429, "second_factor_busy", "Too many attempts in progress, retry");
    }
    return apiError(reply, 401, "invalid_second_factor", "Invalid second factor code");
  }

  app.get(
    "/second-factor",
    {
      onRequest: credentialsRateLimit,
      config: { access: { kind: "second_factor" } },
      schema: { response: { 200: secondFactorStatusSchema, ...errorResponses } },
    },
    async (request) => {
      const user = request.user!;
      const [passkey] = await app.db
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(eq(userPasskeys.userId, user.id))
        .limit(1);
      const until = await lockedUntil(app.db, user.id);
      return {
        // L'hook lascia passare qui solo una sessione parziale.
        stage: user.sessionStage as "second_factor" | "enrollment",
        passkeys: passkey !== undefined,
        backupCodesRemaining: await remainingBackupCodes(app.db, user.id),
        lockedUntil: until?.toISOString() ?? null,
      };
    },
  );

  app.post(
    "/second-factor/verify",
    {
      onRequest: credentialsRateLimit,
      config: { access: { kind: "second_factor", stage: "second_factor" } },
      schema: {
        body: secondFactorCodeBodySchema,
        response: {
          200: secondFactorVerifyResponseSchema,
          ...errorResponses,
          423: lockedErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      // Bloccato: nemmeno il codice giusto passa, e non si consuma nulla.
      const attempt = await attemptSecondFactor(app.db, user, () =>
        verifySecondFactorCode(app.db, app.encryptionKey, user.id, request.body.code),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);

      if (!(await promoteSession(reply, user))) {
        return apiError(reply, 401, "unauthorized", "Authentication required");
      }
      await recordSecurityEvent(app.db, { kind: "login", user });
      return reply.code(200).send({
        user: { id: user.id, email: user.email, role: user.role },
        backupCodesRemaining: await remainingBackupCodes(app.db, user.id),
      });
    },
  );

  app.post(
    "/second-factor/enroll",
    {
      onRequest: credentialsRateLimit,
      config: { access: { kind: "second_factor", stage: "enrollment" } },
      schema: { response: { 200: totpEnrollmentResponseSchema, ...errorResponses } },
    },
    async (request) => startTotpEnrollment(app.db, app.encryptionKey, request.user!),
  );

  app.post(
    "/second-factor/enroll/confirm",
    {
      onRequest: credentialsRateLimit,
      config: { access: { kind: "second_factor", stage: "enrollment" } },
      schema: {
        body: secondFactorCodeBodySchema,
        response: { 200: enrollConfirmResponseSchema, ...errorResponses, 423: lockedErrorSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const attempt = await attemptSecondFactor(app.db, user, () =>
        confirmTotp(app.db, app.encryptionKey, user.id, request.body.code),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);
      const backupCodes = await regenerateBackupCodes(app.db, user.id);
      if (!(await promoteSession(reply, user))) {
        return apiError(reply, 401, "unauthorized", "Authentication required");
      }
      await recordSecurityEvent(app.db, { kind: "enrolled", user });
      return reply.code(200).send({
        user: { id: user.id, email: user.email, role: user.role },
        backupCodes,
      });
    },
  );
}
