import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { desktopHandoffs, roles, users } from "@stubwise/db";
import {
  desktopExchangeBodySchema,
  desktopExchangeResponseSchema,
  desktopHandoffBodySchema,
  desktopHandoffResponseSchema,
} from "@stubwise/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, onRequestHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { sessionUserSelection, toSessionUser } from "../auth/session.js";
import { apiError } from "../errors.js";
import { createPatForUser } from "./pat.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/** Quanto vive un codice: il tempo di tornare dal browser all'app. */
export const DESKTOP_HANDOFF_TTL_MS = 120_000;

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Il login del desktop passa dal browser di sistema (integrazione area 2,
 * 9 nov 2026; `docs/invariants/second-factor.md`).
 *
 * 1. Il desktop genera `state` e `code_verifier`, apre il browser su `/app`
 *    con `code_challenge = base64url(SHA-256(verifier))`.
 * 2. Nel browser, dopo il login COMPLETO (password + secondo fattore) e un
 *    clic di conferma, `POST /desktop-handoff` emette un codice monouso.
 * 3. Il browser riapre l'app (`stubwise://auth?code=…&state=…`), e il desktop
 *    scambia codice + verifier col suo token (`POST /desktop-exchange`).
 *
 * È una PORTA CHE DÀ UN TOKEN: il secondo fattore lo garantisce la sessione
 * completa E riconfermata richiesta al passo 2 (una sessione parziale riceve
 * 401 dall'hook globale, una completa ma vecchia 403 `reauth_required`, un PAT
 * 403 `session_required`), mai un codice chiesto allo scambio.
 */
export function desktopHandoffRoutes(instance: FastifyInstance, credentialsRateLimit: onRequestHookHandler): void {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/desktop-handoff",
    {
      // Conia un token, come `POST /api/pats`: vuole la RICONFERMA (secondo
      // fattore negli ultimi 10 minuti), così un cookie rubato non basta.
      // Un PAT la riceve 403 `session_required` dal gate (decisione del 9 nov 2026).
      config: { access: { kind: "user" }, reauth: true },
      schema: {
        body: desktopHandoffBodySchema,
        response: { 200: desktopHandoffResponseSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Solo una sessione del browser: un token non conia altri token.
      if (request.user!.patId) {
        return apiError(reply, 403, "session_required", "This action needs a browser session");
      }
      const code = randomBytes(32).toString("base64url");
      await app.db.insert(desktopHandoffs).values({
        userId: request.user!.id,
        codeHash: sha256Hex(code),
        codeChallenge: request.body.codeChallenge,
        deviceName: request.body.deviceName,
        expiresAt: new Date(Date.now() + DESKTOP_HANDOFF_TTL_MS),
      });
      return { code };
    },
  );

  app.post(
    "/desktop-exchange",
    {
      // Lo stesso bucket di `/login` e `/mobile-login`: una porta in più sulle
      // credenziali non è un tentativo in più.
      onRequest: credentialsRateLimit,
      config: { access: { kind: "public" }, credentialDoor: true },
      schema: {
        body: desktopExchangeBodySchema,
        response: { 200: desktopExchangeResponseSchema, 400: errorSchema, 429: errorSchema },
      },
    },
    async (request, reply) => {
      const invalid = () => apiError(reply, 400, "invalid_grant", "The sign-in code is not valid");
      // Il codice si consuma PRIMA di guardare il verifier: un verifier
      // sbagliato lo brucia, così non si tenta una seconda volta.
      const [handoff] = await app.db
        .update(desktopHandoffs)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(desktopHandoffs.codeHash, sha256Hex(request.body.code)),
            isNull(desktopHandoffs.usedAt),
            gt(desktopHandoffs.expiresAt, sql`now()`),
          ),
        )
        .returning();
      if (!handoff) return invalid();
      const computed = Buffer.from(createHash("sha256").update(request.body.codeVerifier).digest("base64url"));
      const expected = Buffer.from(handoff.codeChallenge);
      if (computed.length !== expected.length || !timingSafeEqual(computed, expected)) return invalid();

      const [user] = await app.db
        .select(sessionUserSelection)
        .from(users)
        .innerJoin(roles, eq(roles.id, users.instanceRoleId))
        .where(eq(users.id, handoff.userId));
      if (!user) return invalid();
      await recordSecurityEvent(app.db, { kind: "login", user });
      // Il nome è quello confermato nel browser, non quello dello scambio.
      const { id: patId, token } = await createPatForUser(
        app.db,
        user.id,
        `Desktop · ${handoff.deviceName}`,
        null,
        "desktop",
      );
      return reply.code(200).send({ token, patId, user: toSessionUser(user) });
    },
  );
}
