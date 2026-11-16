import { createHmac, timingSafeEqual } from "node:crypto";
import { deviceTokens, personalAccessTokens, sessions } from "@stubwise/db";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { meSessionSchema } from "@stubwise/shared";
import { z } from "zod";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F1 (D-9): le MIE sessioni. Le sessioni COMPLETE del browser e i
 * token di desktop e telefono (PAT `desktop`/`mobile`); mai una sessione
 * parziale, mai un PAT fatto a mano (quelli stanno in `/api/pats`). Si chiude
 * una sessione, o si revoca un token coi suoi device, ma MAI quella corrente
 * (per uscire c'è il logout).
 *
 * Gli id sono OPACHI: per il browser `b_` + un HMAC dell'id di sessione con la
 * chiave d'istanza (l'id vero è la credenziale del cookie, e non esce mai);
 * per i token `t_` + l'id del PAT, che non è un segreto.
 */

const sessionRowSchema = meSessionSchema;

export async function meSessionsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const opaque = (sessionId: string) => `b_${createHmac("sha256", app.encryptionKey).update(`session:${sessionId}`).digest("base64url").slice(0, 32)}`;
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const browserSessions = (userId: string) =>
    app.db
      .select({ id: sessions.id, userAgent: sessions.userAgent, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.stage, "full"), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.createdAt));
  const deviceTokensOf = (userId: string) =>
    app.db
      .select({ id: personalAccessTokens.id, kind: personalAccessTokens.kind, name: personalAccessTokens.name, createdAt: personalAccessTokens.createdAt, lastUsedAt: personalAccessTokens.lastUsedAt })
      .from(personalAccessTokens)
      .where(
        and(
          eq(personalAccessTokens.userId, userId),
          inArray(personalAccessTokens.kind, ["desktop", "mobile"]),
          or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(personalAccessTokens.createdAt));

  app.get(
    "/sessions",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(sessionRowSchema), ...authErrorResponses } },
    },
    async (request) => {
      const user = request.user!;
      const [browser, tokens] = await Promise.all([browserSessions(user.id), deviceTokensOf(user.id)]);
      return [
        ...browser.map((s) => ({
          id: opaque(s.id),
          kind: "browser" as const,
          userAgent: s.userAgent,
          label: null,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
          current: s.id === user.sessionId,
        })),
        ...tokens.map((t) => ({
          id: `t_${t.id}`,
          kind: t.kind as "desktop" | "mobile",
          userAgent: null,
          label: t.name,
          createdAt: t.createdAt.toISOString(),
          lastSeenAt: t.lastUsedAt?.toISOString() ?? null,
          current: t.id === user.patId,
        })),
      ];
    },
  );

  app.delete(
    "/sessions/:id",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: z.object({ id: z.string().min(1).max(80) }),
        response: { 204: z.null(), ...authErrorResponses, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;
      const notFound = () => apiError(reply, 404, "not_found", "Session not found");
      const current = () => apiError(reply, 409, "current_session", "To end this session, sign out");
      if (id.startsWith("b_")) {
        const match = (await browserSessions(user.id)).find((s) => same(opaque(s.id), id));
        if (!match) return notFound();
        if (match.id === user.sessionId) return current();
        await app.db.delete(sessions).where(and(eq(sessions.id, match.id), eq(sessions.userId, user.id)));
        return reply.code(204).send(null);
      }
      if (id.startsWith("t_")) {
        const patId = id.slice(2);
        const token = (await deviceTokensOf(user.id)).find((t) => t.id === patId);
        if (!token) return notFound();
        if (token.id === user.patId) return current();
        // Come la revoca di `/api/pats`: i device del token si SPENGONO prima, poi il token va.
        await app.db.transaction(async (tx) => {
          await tx
            .update(deviceTokens)
            .set({ disabledAt: new Date(), disabledReason: "pat_revoked" })
            .where(and(eq(deviceTokens.patId, token.id), eq(deviceTokens.userId, user.id), isNull(deviceTokens.disabledAt)));
          await tx.delete(personalAccessTokens).where(and(eq(personalAccessTokens.id, token.id), eq(personalAccessTokens.userId, user.id)));
        });
        return reply.code(204).send(null);
      }
      return notFound();
    },
  );
}
