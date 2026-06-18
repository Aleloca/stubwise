import { eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { users } from "@stubwise/db";
import { requireAdmin } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "../routes/shared.js";
import { publicUserSchema } from "../routes/users.js";
import { loadSlackCreds, defaultSlackClientFactory, type SlackClientFactory } from "./creds.js";

/**
 * Route di GESTIONE dell'identità Slack (solo admin), distinte dalle route
 * signature-authed di {@link slackRoutes}:
 *
 *   - PUT/DELETE /api/users/:id/slack  (link/unlink di un utente a uno Slack id)
 *   - GET /api/slack/workspace-users   (picker dei membri del workspace)
 *
 * Vivono in un plugin SEPARATO perché, a differenza di slackRoutes (urlencoded
 * raw-body + verifica firma Slack, nessuna sessione), questi endpoint sono JSON
 * + autenticati a sessione (requireAdmin). Registrarli nello stesso scope di
 * slackRoutes ne erediterebbe il content-type parser urlencoded scoped, che
 * romperebbe il body JSON. Stanno qui (e non in routes/users.ts) per
 * RIUSARE il meccanismo di accesso al client Slack — `loadSlackCreds` +
 * `SlackClientFactory` — senza duplicarlo. Il plugin viene montato sotto il
 * prefisso /api in app.ts, così i path sopra risultano completi.
 */
export interface SlackIdentityRoutesOptions {
  /** Fabbrica del client Slack. Default: client reale via fetch globale. */
  slackClientFactory?: SlackClientFactory;
}

/** Membro del workspace Slack per il picker, arricchito col link Stubwise. */
const workspaceUserSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** Id dell'utente Stubwise già linkato a questo Slack id, o null. */
  linkedUserId: z.uuid().nullable(),
});

export async function slackIdentityRoutes(
  instance: FastifyInstance,
  opts: SlackIdentityRoutesOptions = {},
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const clientFactory = opts.slackClientFactory ?? defaultSlackClientFactory;

  /** Proietta una riga utente nella forma di publicUserSchema. */
  function toPublicUser(row: {
    id: string;
    email: string;
    role: "admin" | "member";
    createdAt: Date;
    avatarUrl: string | null;
    slackUserId: string | null;
  }) {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }

  // PUT /api/users/:id/slack — linka un utente a uno Slack user id (solo admin).
  // L'avatar viene SEMPRE derivato server-side dal profilo Slack, mai dal client.
  app.put(
    "/users/:id/slack",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ slackUserId: z.string().min(1) }),
        response: {
          200: publicUserSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const creds = await loadSlackCreds(instance);
      if (!creds) {
        return apiError(reply, 400, "slack_not_configured", "Slack integration is not configured");
      }
      const { id } = request.params;
      const [existing] = await app.db.select({ id: users.id }).from(users).where(eq(users.id, id));
      if (!existing) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      const client = clientFactory(creds.botToken);
      const profile = await client.getUserProfile(request.body.slackUserId);
      if (!profile) {
        return apiError(reply, 400, "slack_user_not_found", "Slack user not found");
      }
      let updated;
      try {
        [updated] = await app.db
          .update(users)
          .set({ slackUserId: request.body.slackUserId, slackAvatarUrl: profile.avatarUrl })
          .where(eq(users.id, id))
          .returning({
            id: users.id,
            email: users.email,
            role: users.role,
            createdAt: users.createdAt,
            avatarUrl: users.slackAvatarUrl,
            slackUserId: users.slackUserId,
          });
      } catch (err) {
        // Lo Slack id è unique: se è già di un altro utente, 409 anziché 500.
        if (isUniqueViolation(err)) {
          return apiError(
            reply,
            409,
            "slack_identity_taken",
            "This Slack identity is already linked to another user",
          );
        }
        throw err;
      }
      if (!updated) {
        // Race: l'utente è sparito tra il pre-check e l'update.
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      return reply.code(200).send(toPublicUser(updated));
    },
  );

  // DELETE /api/users/:id/slack — scollega l'identità Slack (solo admin).
  app.delete(
    "/users/:id/slack",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [updated] = await app.db
        .update(users)
        .set({ slackUserId: null, slackAvatarUrl: null })
        .where(eq(users.id, request.params.id))
        .returning({ id: users.id });
      if (!updated) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      return reply.code(204).send(null);
    },
  );

  // GET /api/slack/workspace-users — membri del workspace col link Stubwise
  // (solo admin), per il picker di link. Email/avatar derivati da Slack.
  app.get(
    "/slack/workspace-users",
    {
      preHandler: requireAdmin,
      schema: {
        response: {
          200: z.array(workspaceUserSchema),
          400: errorSchema,
          502: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (_request, reply) => {
      const creds = await loadSlackCreds(instance);
      if (!creds) {
        return apiError(reply, 400, "slack_not_configured", "Slack integration is not configured");
      }
      const client = clientFactory(creds.botToken);
      let members;
      try {
        members = await client.listWorkspaceUsers();
      } catch {
        // listWorkspaceUsers lancia se la prima pagina di users.list fallisce:
        // 502 anziché 500 grezzo (la causa è a monte, su Slack).
        return apiError(reply, 502, "slack_unavailable", "Slack is currently unavailable");
      }
      // Una sola query per i link esistenti, poi mappa in memoria (no N+1).
      const linked = await app.db
        .select({ id: users.id, slackUserId: users.slackUserId })
        .from(users)
        .where(isNotNull(users.slackUserId));
      const linkedBySlackId = new Map(linked.map((u) => [u.slackUserId!, u.id]));
      return members.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        email: m.email,
        avatarUrl: m.avatarUrl,
        linkedUserId: linkedBySlackId.get(m.id) ?? null,
      }));
    },
  );
}
