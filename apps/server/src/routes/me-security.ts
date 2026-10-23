import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sessions, userPasskeys, userTotp } from "@stubwise/db";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  accountSecurityResponseSchema,
  backupCodesResponseSchema,
  passkeyAuthenticationOptionsSchema,
  passkeyRegisterBodySchema,
  passkeyRegistrationOptionsSchema,
  passkeyRenameBodySchema,
  passkeyViewSchema,
  passkeyVerifyBodySchema,
  secondFactorCodeBodySchema,
  totpEnrollmentResponseSchema,
  totpSetupConfirmResponseSchema,
} from "@stubwise/shared";
import { publishSecurityAlert } from "../auth/second-factor/alerts.js";
import {
  regenerateBackupCodes,
  remainingBackupCodes,
} from "../auth/second-factor/backup-codes.js";
import { attemptSecondFactor, verifySecondFactorCode } from "../auth/second-factor/index.js";
import {
  authenticationOptions,
  finishAuthentication,
  finishRegistration,
  passkeyRp,
  registrationOptions,
} from "../auth/second-factor/passkeys.js";
import {
  listSecurityEvents,
  recordSecurityEvent,
  toSecurityEventView,
} from "../auth/second-factor/security-events.js";
import {
  commitPendingTotp,
  hasConfirmedTotp,
  matchPendingTotp,
  startTotpEnrollment,
} from "../auth/second-factor/totp.js";
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
 * - `GET /` e le rotte di codici e passkey: Impostazioni → Sicurezza. Le
 *   scritture che installano o tolgono un fattore chiedono la riconferma; il
 *   nome di una passkey no. Si tocca solo ciò che è PROPRIO: la passkey di un
 *   altro risponde 404 come una che non esiste.
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
      // Il codice si verifica sotto il tetto SENZA scrivere: l'app si
      // conferma solo a tentativo riuscito, e insieme a ciò che ne segue
      // (una transazione), così un codice giusto che perde la corsa col
      // blocco non lascia un'app confermata senza codici di riserva.
      const attempt = await attemptSecondFactor(app.db, user, () =>
        matchPendingTotp(app.db, app.encryptionKey, user.id, request.body.code),
      );
      if (!attempt.ok) return rejectAttempt(reply, attempt);
      const outcome = await app.db.transaction(async (tx) => {
        if (!(await commitPendingTotp(tx, user.id, attempt.result))) return null;
        if (reconfigure) return { backupCodes: null };
        // Prima app (sessione di prima del rilascio): codici di riserva, e la
        // configurazione conta come riconferma, così l'azione sensibile che
        // l'ha chiesta riparte dalla stessa sessione.
        const backupCodes = await regenerateBackupCodes(tx, app.encryptionKey, user.id);
        await tx
          .update(sessions)
          .set({ secondFactorAt: sql`now()` })
          .where(eq(sessions.id, sessionId));
        return { backupCodes };
      });
      // Pendente cambiato nel frattempo (un altro «configura»): il codice
      // non conferma più niente.
      if (!outcome) {
        return apiError(reply, 401, "invalid_second_factor", "Invalid second factor code");
      }
      await recordSecurityEvent(app.db, {
        kind: reconfigure ? "totp_reconfigured" : "enrolled",
        user,
      });
      return reply.code(200).send(outcome);
    },
  );

  // --- Impostazioni → Sicurezza ---------------------------------------------

  /** Una passkey nella forma delle risposte: mai chiave pubblica né id della credenziale. */
  function passkeyView(row: {
    id: string;
    name: string;
    createdAt: Date;
    lastUsedAt: Date | null;
  }) {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    };
  }

  const passkeyColumns = {
    id: userPasskeys.id,
    name: userPasskeys.name,
    createdAt: userPasskeys.createdAt,
    lastUsedAt: userPasskeys.lastUsedAt,
  };

  /** La passkey `id` SE è di `userId`: quella di un altro non esiste. */
  function ownPasskey(id: string, userId: string) {
    return and(eq(userPasskeys.id, id), eq(userPasskeys.userId, userId));
  }

  function passkeyNotFound(reply: FastifyReply): FastifyReply {
    return apiError(reply, 404, "passkey_not_found", "Passkey not found");
  }

  const passkeyParams = z.object({ id: z.uuid() });

  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: accountSecurityResponseSchema, ...authErrorResponses } },
    },
    async (request) => {
      const userId = request.user!.id;
      const [totp] = await app.db
        .select({ confirmedAt: userTotp.confirmedAt })
        .from(userTotp)
        .where(eq(userTotp.userId, userId));
      const confirmedAt = totp?.confirmedAt ?? null;
      const passkeys = await app.db
        .select(passkeyColumns)
        .from(userPasskeys)
        .where(eq(userPasskeys.userId, userId))
        .orderBy(asc(userPasskeys.createdAt));
      return {
        totp: { configured: confirmedAt !== null, confirmedAt: confirmedAt?.toISOString() ?? null },
        passkeys: passkeys.map(passkeyView),
        backupCodesRemaining: await remainingBackupCodes(app.db, userId),
        events: (await listSecurityEvents(app.db, userId)).map(toSecurityEventView),
      };
    },
  );

  /** Codici nuovi, mostrati una volta: i precedenti (usati o no) non valgono più. */
  app.post(
    "/backup-codes",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: { response: { 200: backupCodesResponseSchema, ...errorResponses } },
    },
    async (request) => {
      const user = request.user!;
      const codes = await regenerateBackupCodes(app.db, app.encryptionKey, user.id);
      await recordSecurityEvent(app.db, { kind: "backup_codes_regenerated", user });
      await publishSecurityAlert(app.db, user.id, "backup_codes_regenerated", null);
      return { codes };
    },
  );

  /** Opzioni WebAuthn per aggiungere una passkey: challenge sulla sessione. */
  app.post(
    "/passkeys/options",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: { response: { 200: passkeyRegistrationOptionsSchema, ...errorResponses } },
    },
    async (request) => {
      const user = request.user!;
      // Il gate della riconferma ha già escluso i PAT: qui c'è una sessione.
      return registrationOptions(app.db, user.sessionId!, user, passkeyRp(app.publicUrl));
    },
  );

  app.post(
    "/passkeys",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: {
        body: passkeyRegisterBodySchema,
        response: { 201: passkeyViewSchema, ...errorResponses, 400: errorSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const created = await finishRegistration(
        app.db,
        user.sessionId!,
        user.id,
        request.body.name,
        // Lo schema fissa solo il minimo; il resto lo verifica la libreria.
        request.body.response as unknown as RegistrationResponseJSON,
        passkeyRp(app.publicUrl),
      );
      if (!created) {
        return apiError(
          reply,
          400,
          "passkey_registration_failed",
          "The passkey could not be registered",
        );
      }
      await recordSecurityEvent(app.db, { kind: "passkey_added", user });
      await publishSecurityAlert(app.db, user.id, "passkey_added", null);
      const [row] = await app.db
        .select(passkeyColumns)
        .from(userPasskeys)
        .where(eq(userPasskeys.id, created.id));
      return reply.code(201).send(passkeyView(row!));
    },
  );

  /** Rinominare non installa né toglie un fattore: niente riconferma. */
  app.patch(
    "/passkeys/:id",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: passkeyParams,
        body: passkeyRenameBodySchema,
        response: { 200: passkeyViewSchema, ...authErrorResponses, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .update(userPasskeys)
        .set({ name: request.body.name })
        .where(ownPasskey(request.params.id, request.user!.id))
        .returning(passkeyColumns);
      if (!row) return passkeyNotFound(reply);
      return reply.code(200).send(passkeyView(row));
    },
  );

  app.delete(
    "/passkeys/:id",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: {
        params: passkeyParams,
        response: { 204: z.null(), ...errorResponses, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const removed = await app.db
        .delete(userPasskeys)
        .where(ownPasskey(request.params.id, user.id))
        .returning({ id: userPasskeys.id });
      if (removed.length === 0) return passkeyNotFound(reply);
      await recordSecurityEvent(app.db, { kind: "passkey_removed", user });
      return reply.code(204).send(null);
    },
  );
}
