import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, onRequestHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sessions, userPasskeys, type Db } from "@stubwise/db";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  enrollConfirmResponseSchema,
  passkeyAuthenticationOptionsSchema,
  passkeyVerifyBodySchema,
  secondFactorCodeBodySchema,
  secondFactorStatusSchema,
  secondFactorVerifyResponseSchema,
  totpEnrollmentResponseSchema,
} from "@stubwise/shared";
import { regenerateBackupCodes, remainingBackupCodes } from "../auth/second-factor/backup-codes.js";
import { attemptSecondFactor, verifySecondFactorCode } from "../auth/second-factor/index.js";
import { lockedUntil } from "../auth/second-factor/lockout.js";
import {
  authenticationOptions,
  finishAuthentication,
  passkeyRp,
} from "../auth/second-factor/passkeys.js";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import {
  commitPendingTotp,
  hasConfirmedTotp,
  matchPendingTotp,
  startTotpEnrollment,
} from "../auth/second-factor/totp.js";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  SESSION_TTL_MS,
  type SessionUser,
} from "../auth/session.js";
import { apiError } from "../errors.js";
import { lockedErrorSchema, rejectAttempt } from "./second-factor-replies.js";
import { errorSchema } from "./shared.js";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Annulla la transazione della configurazione, con la risposta da dare. */
class EnrollmentAborted extends Error {
  constructor(readonly reason: "totp" | "session") {
    super(reason);
  }
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
   * Promuove a completa la sessione parziale `sessionId`: STESSA riga (niente
   * seconda sessione), secondo fattore fatto adesso, durata piena. `false` se
   * la sessione non c'è più (scaduta o chiusa nel frattempo) o è già completa.
   */
  async function promoteSessionRow(db: DbOrTx, sessionId: string): Promise<boolean> {
    const updated = await db
      .update(sessions)
      .set({
        stage: "full",
        secondFactorAt: sql`now()`,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      })
      .where(and(eq(sessions.id, sessionId), ne(sessions.stage, "full")))
      .returning({ id: sessions.id });
    return updated.length > 0;
  }

  /** Il cookie della sessione appena promossa, con la durata piena. */
  function setFullSessionCookie(reply: FastifyReply, sessionId: string): void {
    reply.setCookie(SESSION_COOKIE, sessionId, {
      ...SESSION_COOKIE_OPTIONS,
      signed: true,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  }

  async function promoteSession(reply: FastifyReply, user: SessionUser): Promise<boolean> {
    if (!(await promoteSessionRow(app.db, user.sessionId!))) return false;
    setFullSessionCookie(reply, user.sessionId!);
    return true;
  }

  /**
   * Lo stadio `enrollment` è deciso al login, ma la sessione parziale vive
   * 10 minuti: se nel frattempo l'app è stata configurata (dal login del vero
   * utente, per esempio), quella sessione non configura più niente — o chi
   * ha solo la password sostituirebbe l'app esistente senza secondo fattore.
   */
  function enrollmentClosed(reply: FastifyReply): FastifyReply {
    return apiError(
      reply,
      409,
      "second_factor_stage_mismatch",
      "Second factor already configured, log in again",
    );
  }

  /**
   * Secondo fattore riuscito (codice o passkey): sessione promossa, evento
   * `login`, risposta del login completo.
   */
  async function completeLogin(reply: FastifyReply, user: SessionUser): Promise<FastifyReply> {
    if (!(await promoteSession(reply, user))) {
      return apiError(reply, 401, "unauthorized", "Authentication required");
    }
    await recordSecurityEvent(app.db, { kind: "login", user });
    return reply.code(200).send({
      user: { id: user.id, email: user.email, role: user.role },
      backupCodesRemaining: await remainingBackupCodes(app.db, user.id),
    });
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
      return completeLogin(reply, user);
    },
  );

  /**
   * Opzioni WebAuthn per usare una passkey al posto del codice: la challenge
   * si salva sulla sessione parziale, e vale una volta sola. Chi non ha
   * passkey riceve 409 (la web non offre la scelta: `GET /` dice `passkeys`).
   */
  app.post(
    "/second-factor/passkey/options",
    {
      onRequest: credentialsRateLimit,
      config: { access: { kind: "second_factor", stage: "second_factor" } },
      schema: { response: { 200: passkeyAuthenticationOptionsSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      const options = await authenticationOptions(
        app.db,
        user.sessionId!,
        user.id,
        passkeyRp(app.publicUrl),
      );
      if (!options.allowCredentials?.length) {
        return apiError(reply, 409, "no_passkeys", "No passkeys registered");
      }
      return reply.code(200).send(options);
    },
  );

  /**
   * La passkey come secondo fattore: stessa promozione e stesso tetto di
   * `/verify`. Una firma che non torna (challenge, origin, passkey d'altri)
   * conta come un codice sbagliato.
   */
  app.post(
    "/second-factor/passkey/verify",
    {
      onRequest: credentialsRateLimit,
      config: { access: { kind: "second_factor", stage: "second_factor" } },
      schema: {
        body: passkeyVerifyBodySchema,
        response: {
          200: secondFactorVerifyResponseSchema,
          ...errorResponses,
          423: lockedErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const attempt = await attemptSecondFactor(app.db, user, () =>
        finishAuthentication(
          app.db,
          user.sessionId!,
          user.id,
          // Lo schema fissa solo il minimo; il resto lo verifica la libreria.
          request.body.response as unknown as AuthenticationResponseJSON,
          passkeyRp(app.publicUrl),
        ),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);
      return completeLogin(reply, user);
    },
  );

  app.post(
    "/second-factor/enroll",
    {
      onRequest: credentialsRateLimit,
      config: { access: { kind: "second_factor", stage: "enrollment" } },
      schema: { response: { 200: totpEnrollmentResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      if (await hasConfirmedTotp(app.db, user.id)) return enrollmentClosed(reply);
      return reply.code(200).send(await startTotpEnrollment(app.db, app.encryptionKey, user));
    },
  );

  /**
   * Conferma della prima app. Il codice si verifica (sotto il tetto) SENZA
   * scrivere; poi, solo a tentativo riuscito, UNA transazione conferma l'app,
   * scrive i codici di riserva e promuove la sessione: o tutto o niente, e
   * la sessione diventa completa solo con i codici nella risposta. Un codice
   * giusto che perde la corsa col blocco non lascia un'app confermata senza
   * riserva.
   */
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
      if (await hasConfirmedTotp(app.db, user.id)) return enrollmentClosed(reply);
      const attempt = await attemptSecondFactor(app.db, user, () =>
        matchPendingTotp(app.db, app.encryptionKey, user.id, request.body.code),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);
      let backupCodes: string[];
      try {
        backupCodes = await app.db.transaction(async (tx) => {
          // `firstOnly`: un'app confermata nel frattempo non si sostituisce.
          if (!(await commitPendingTotp(tx, user.id, attempt.result, { firstOnly: true }))) {
            throw new EnrollmentAborted("totp");
          }
          const codes = await regenerateBackupCodes(tx, app.encryptionKey, user.id);
          if (!(await promoteSessionRow(tx, user.sessionId!))) {
            throw new EnrollmentAborted("session");
          }
          return codes;
        });
      } catch (error) {
        if (!(error instanceof EnrollmentAborted)) throw error;
        if (error.reason === "session") {
          return apiError(reply, 401, "unauthorized", "Authentication required");
        }
        // App confermata altrove, o pendente cambiato (un'altra `/enroll`):
        // il codice non conferma più niente.
        if (await hasConfirmedTotp(app.db, user.id)) return enrollmentClosed(reply);
        return apiError(reply, 401, "invalid_second_factor", "Invalid second factor code");
      }
      setFullSessionCookie(reply, user.sessionId!);
      await recordSecurityEvent(app.db, { kind: "enrolled", user });
      return reply.code(200).send({
        user: { id: user.id, email: user.email, role: user.role },
        backupCodes,
      });
    },
  );
}
