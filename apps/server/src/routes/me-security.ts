import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions } from "@stubwise/db";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  passkeyAuthenticationOptionsSchema,
  passkeyVerifyBodySchema,
  secondFactorCodeBodySchema,
  totpEnrollmentResponseSchema,
  totpSetupConfirmResponseSchema,
} from "@stubwise/shared";
import { regenerateBackupCodes } from "../auth/second-factor/backup-codes.js";
import { attemptSecondFactor, verifySecondFactorCode } from "../auth/second-factor/index.js";
import {
  authenticationOptions,
  finishAuthentication,
  passkeyRp,
} from "../auth/second-factor/passkeys.js";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { confirmTotp, hasConfirmedTotp, startTotpEnrollment } from "../auth/second-factor/totp.js";
import type { SessionUser } from "../auth/session.js";
import { apiError } from "../errors.js";
import { lockedErrorSchema, rejectAttempt } from "./second-factor-replies.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const errorResponses = {
  ...authErrorResponses,
  403: errorSchema,
  409: errorSchema,
  429: errorSchema,
} as const;

/**
 * Sicurezza del PROPRIO account (`/api/me/security`). Qui le rotte della
 * riconferma recente (`config.reauth`, vedi `auth/access.ts`):
 *
 * - `POST /reauth` e `/reauth/passkey/*`: un secondo fattore da una sessione
 *   completa, che rinfresca `sessions.second_factor_at`. Ogni codice passa da
 *   `attemptSecondFactor`: i codici sbagliati contano nel tetto per account e
 *   il blocco ferma anche la riconferma (un cookie rubato non prova codici
 *   all'infinito). La sessione resta valida: si bloccano solo le azioni
 *   sensibili.
 * - `POST /totp/setup` e `/totp/setup/confirm` (`reauth: "setup_allowed"`):
 *   per chi non ha ancora un'app (sessione di prima del rilascio) è la
 *   configurazione obbligatoria, che conta come riconferma; per chi ce l'ha è
 *   la «riconfigura app», con la riconferma recente, e il segreto nuovo
 *   sostituisce il vecchio solo alla conferma.
 *
 * Un PAT non riconferma mai: 403 `session_required`, come le rotte sensibili.
 */
export async function meSecurityRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** La sessione della richiesta; `null` per chi arriva con un token. */
  function sessionOf(user: SessionUser): string | null {
    return user.patId === undefined ? (user.sessionId ?? null) : null;
  }

  function sessionRequired(reply: FastifyReply): FastifyReply {
    return apiError(reply, 403, "session_required", "This action requires a browser session");
  }

  /** Secondo fattore usato adesso, su QUESTA sessione. */
  async function markConfirmed(sessionId: string): Promise<void> {
    await app.db
      .update(sessions)
      .set({ secondFactorAt: sql`now()` })
      .where(eq(sessions.id, sessionId));
  }

  app.post(
    "/reauth",
    {
      config: { access: { kind: "user" } },
      schema: {
        body: secondFactorCodeBodySchema,
        response: { 204: z.null(), ...errorResponses, 401: errorSchema, 423: lockedErrorSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const sessionId = sessionOf(user);
      if (!sessionId) return sessionRequired(reply);
      // Senza app non c'è un codice da provare: si configura (stesso codice
      // delle rotte sensibili, così la web apre la configurazione).
      if (!(await hasConfirmedTotp(app.db, user.id))) {
        return apiError(reply, 403, "second_factor_setup_required", "Second factor setup required");
      }
      const attempt = await attemptSecondFactor(app.db, user, () =>
        verifySecondFactorCode(app.db, app.encryptionKey, user.id, request.body.code),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);
      await markConfirmed(sessionId);
      return reply.code(204).send(null);
    },
  );

  /** Opzioni WebAuthn della riconferma: challenge sulla sessione, una volta sola. */
  app.post(
    "/reauth/passkey/options",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: passkeyAuthenticationOptionsSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      const sessionId = sessionOf(user);
      if (!sessionId) return sessionRequired(reply);
      const options = await authenticationOptions(
        app.db,
        sessionId,
        user.id,
        passkeyRp(app.publicUrl),
      );
      if (!options.allowCredentials?.length) {
        return apiError(reply, 409, "no_passkeys", "No passkeys registered");
      }
      return reply.code(200).send(options);
    },
  );

  app.post(
    "/reauth/passkey/verify",
    {
      config: { access: { kind: "user" } },
      schema: {
        body: passkeyVerifyBodySchema,
        response: { 204: z.null(), ...errorResponses, 401: errorSchema, 423: lockedErrorSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const sessionId = sessionOf(user);
      if (!sessionId) return sessionRequired(reply);
      const attempt = await attemptSecondFactor(app.db, user, () =>
        finishAuthentication(
          app.db,
          sessionId,
          user.id,
          // Lo schema fissa solo il minimo; il resto lo verifica la libreria.
          request.body.response as unknown as AuthenticationResponseJSON,
          passkeyRp(app.publicUrl),
        ),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);
      await markConfirmed(sessionId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/totp/setup",
    {
      config: { access: { kind: "user" }, reauth: "setup_allowed" },
      schema: { response: { 200: totpEnrollmentResponseSchema, ...errorResponses } },
    },
    async (request) => startTotpEnrollment(app.db, app.encryptionKey, request.user!),
  );

  app.post(
    "/totp/setup/confirm",
    {
      config: { access: { kind: "user" }, reauth: "setup_allowed" },
      schema: {
        body: secondFactorCodeBodySchema,
        response: {
          200: totpSetupConfirmResponseSchema,
          ...errorResponses,
          401: errorSchema,
          423: lockedErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      // Il gate ha già escluso i PAT: qui c'è sempre una sessione.
      const sessionId = user.sessionId!;
      const reconfigure = await hasConfirmedTotp(app.db, user.id);
      const attempt = await attemptSecondFactor(app.db, user, () =>
        confirmTotp(app.db, app.encryptionKey, user.id, request.body.code),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);
      if (reconfigure) {
        await recordSecurityEvent(app.db, { kind: "totp_reconfigured", user });
        return reply.code(200).send({ backupCodes: null });
      }
      // Prima app (sessione di prima del rilascio): codici di riserva, e la
      // configurazione conta come riconferma, così l'azione sensibile che
      // l'ha chiesta riparte dalla stessa sessione.
      const backupCodes = await regenerateBackupCodes(app.db, user.id);
      await markConfirmed(sessionId);
      await recordSecurityEvent(app.db, { kind: "enrolled", user });
      return reply.code(200).send({ backupCodes });
    },
  );
}
