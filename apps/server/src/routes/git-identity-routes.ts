import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { gitAuthorsSeen, gitIdentities, users } from "@stubwise/db";
import { requireAdmin } from "../auth/session.js";
import { apiError } from "../errors.js";
import {
  authErrorResponses,
  errorSchema,
  isForeignKeyViolation,
  isUniqueViolation,
} from "./shared.js";

/**
 * Route di GESTIONE del linking identità git/Bitbucket → membro Stubwise (solo
 * admin), gemelle di {@link slackIdentityRoutes}. Il piano "Daily activity
 * report" ne ha bisogno per attribuire i commit a una persona.
 *
 *   - POST/DELETE /api/users/:id/git-identities[/:email]  (alias email git → membro)
 *   - PUT/DELETE  /api/users/:id/bitbucket                 (users.bitbucketUsername)
 *   - GET         /api/git/observed-authors                (picker degli autori visti)
 *
 * L'email git è memorizzata SEMPRE lowercase (+ trim): lo schema ha un unique
 * case-sensitive, quindi la normalizzazione è responsabilità dell'app, non del
 * DB. Il plugin è montato sotto /api in app.ts, così i path sopra sono completi.
 */

/** Una git identity nella forma esposta al client. */
const gitIdentitySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  authorName: z.string().nullable(),
});

/** Autore git osservato, arricchito col membro eventualmente linkato. */
const observedAuthorSchema = z.object({
  email: z.string(),
  authorName: z.string().nullable(),
  lastSeenAt: z.iso.datetime(),
  /** Id del membro Stubwise linkato a questa email (via git_identities), o null. */
  linkedUserId: z.uuid().nullable(),
});

export async function gitIdentityRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Elenco delle git identities di un membro (per il refresh dopo una mutation). */
  async function identitiesOf(userId: string) {
    return app.db
      .select({
        id: gitIdentities.id,
        email: gitIdentities.email,
        authorName: gitIdentities.authorName,
      })
      .from(gitIdentities)
      .where(eq(gitIdentities.userId, userId));
  }

  // POST /api/users/:id/git-identities — associa un'email git al membro (solo
  // admin). L'email è normalizzata lowercase + trim prima dell'insert.
  app.post(
    "/users/:id/git-identities",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ email: z.string().trim().min(1), authorName: z.string().optional() }),
        response: {
          200: z.array(gitIdentitySchema),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [existing] = await app.db.select({ id: users.id }).from(users).where(eq(users.id, id));
      if (!existing) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      const email = request.body.email.trim().toLowerCase();
      try {
        await app.db
          .insert(gitIdentities)
          .values({ userId: id, email, authorName: request.body.authorName ?? null });
      } catch (err) {
        // Email unique (case-sensitive nel DB, ma noi lowercasiamo): se è già
        // linkata a QUESTO o a un ALTRO membro, 409 anziché 500.
        if (isUniqueViolation(err)) {
          return apiError(
            reply,
            409,
            "git_identity_taken",
            "This git email is already linked to a member",
          );
        }
        // Race: l'utente potrebbe essere sparito tra il pre-check e l'insert →
        // la FK user_id → users.id lancia 23503. Trattalo come 404, non 500.
        if (isForeignKeyViolation(err)) {
          return apiError(reply, 404, "user_not_found", "User not found");
        }
        throw err;
      }
      return reply.code(200).send(await identitiesOf(id));
    },
  );

  // DELETE /api/users/:id/git-identities/:email — rimuove l'associazione (solo
  // admin). L'email nel path è lowercasata per combaciare col dato memorizzato.
  app.delete(
    "/users/:id/git-identities/:email",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid(), email: z.string() }),
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      let email: string;
      try {
        email = decodeURIComponent(request.params.email).trim().toLowerCase();
      } catch {
        // decodeURIComponent lancia URIError su input malformato (es. %ZZ):
        // non è un'associazione esistente → 404, non un 500 grezzo.
        return apiError(reply, 404, "git_identity_not_found", "Git identity not found");
      }
      const [deleted] = await app.db
        .delete(gitIdentities)
        .where(and(eq(gitIdentities.userId, request.params.id), eq(gitIdentities.email, email)))
        .returning({ id: gitIdentities.id });
      if (!deleted) {
        return apiError(reply, 404, "git_identity_not_found", "Git identity not found");
      }
      return reply.code(204).send(null);
    },
  );

  // PUT /api/users/:id/bitbucket — linka users.bitbucketUsername (solo admin).
  app.put(
    "/users/:id/bitbucket",
    {
      preHandler: requireAdmin,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ username: z.string().trim().min(1) }),
        response: {
          200: z.object({ id: z.uuid(), bitbucketUsername: z.string().nullable() }),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      let updated;
      try {
        [updated] = await app.db
          .update(users)
          .set({ bitbucketUsername: request.body.username })
          .where(eq(users.id, request.params.id))
          .returning({ id: users.id, bitbucketUsername: users.bitbucketUsername });
      } catch (err) {
        // bitbucketUsername è unique: se è già di un altro membro, 409 anziché 500.
        if (isUniqueViolation(err)) {
          return apiError(
            reply,
            409,
            "bitbucket_identity_taken",
            "This Bitbucket username is already linked to another member",
          );
        }
        throw err;
      }
      if (!updated) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      return reply.code(200).send(updated);
    },
  );

  // DELETE /api/users/:id/bitbucket — azzera users.bitbucketUsername (solo admin).
  app.delete(
    "/users/:id/bitbucket",
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
        .set({ bitbucketUsername: null })
        .where(eq(users.id, request.params.id))
        .returning({ id: users.id });
      if (!updated) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      return reply.code(204).send(null);
    },
  );

  // GET /api/git/observed-authors — autori git visti dal poller col link
  // Stubwise (solo admin), per il picker in /team. Nessun N+1: una query per gli
  // autori e una per i link, poi join in memoria sull'email.
  app.get(
    "/git/observed-authors",
    {
      preHandler: requireAdmin,
      schema: { response: { 200: z.array(observedAuthorSchema), ...authErrorResponses } },
    },
    async () => {
      const seen = await app.db
        .select()
        .from(gitAuthorsSeen)
        .orderBy(sql`${gitAuthorsSeen.lastSeenAt} desc`);
      const linked = await app.db
        .select({ email: gitIdentities.email, userId: gitIdentities.userId })
        .from(gitIdentities);
      const byEmail = new Map(linked.map((l) => [l.email, l.userId]));
      return seen.map((s) => ({
        email: s.email,
        authorName: s.authorName,
        lastSeenAt: s.lastSeenAt.toISOString(),
        linkedUserId: byEmail.get(s.email) ?? null,
      }));
    },
  );
}
