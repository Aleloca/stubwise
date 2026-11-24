import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { roleRuleErrorSchema } from "./roles.js";
import { activityCommits, gitAuthorsSeen, gitIdentities, projects, repositories, users } from "@stubwise/db";
import { inProjectsStrict, isAllProjects, visibleProjectIds } from "../auth/access.js";
import { apiError } from "../errors.js";
import { publishSecurityAlert } from "../auth/second-factor/alerts.js";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { personObject, recordChange } from "../services/change-log.js";
import {
  authErrorResponses,
  errorSchema,
  isForeignKeyViolation,
  isUniqueViolation,
  rejectAgentUserParam,
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
  /**
   * Rimandi, lotto 5 (il prototipo, «N commit in ACQ»): i commit di questa
   * email nei report giornalieri (`activity_commits`), e i codici dei progetti
   * in cui stanno — SOLO i progetti che chi guarda vede. `.default`: un
   * server più vecchio non li manda.
   */
  commits: z.number().int().default(0),
  projectCodes: z.array(z.string()).default([]),
});

export async function gitIdentityRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // Niente identità git né Bitbucket per l'utente di sistema «Claude».
  rejectAgentUserParam(instance);

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
      config: { access: { kind: "instance", permission: "users.manage" }, reauth: true },
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ email: z.string().trim().min(1), authorName: z.string().optional() }),
        response: {
          200: z.array(gitIdentitySchema),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
          // Gli errori di regola (`permission` incluso). Il bersaglio non è più
          // protetto (area 9, D-2): resta lo schema, per i client.
          403: roleRuleErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [existing] = await app.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id));
      if (!existing) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      const email = request.body.email.trim().toLowerCase();
      try {
        // Area 9, F2: l'identità e la sua voce nascono insieme.
        await app.db.transaction(async (tx) => {
          await tx.insert(gitIdentities).values({ userId: id, email, authorName: request.body.authorName ?? null });
          await recordChange(tx, { type: "person.git_identity_linked", actor: request.user!, projectId: null, data: { object: personObject(existing), params: { email } } });
        });
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
      config: { access: { kind: "instance", permission: "users.manage" }, reauth: true },
      schema: {
        params: z.object({ id: z.uuid(), email: z.string() }),
        response: {
          204: z.null(),
          404: errorSchema,
          ...authErrorResponses,
          // Gli errori di regola (`permission` incluso). Il bersaglio non è più
          // protetto (area 9, D-2): resta lo schema, per i client.
          403: roleRuleErrorSchema,
        },
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
      const deleted = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .delete(gitIdentities)
          .where(and(eq(gitIdentities.userId, request.params.id), eq(gitIdentities.email, email)))
          .returning({ id: gitIdentities.id });
        if (!row) return null;
        const [owner] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, request.params.id));
        await recordChange(tx, { type: "person.git_identity_unlinked", actor: request.user!, projectId: null, data: { object: personObject(owner!), params: { email } } });
        return row;
      });
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
      // Review di F1 (I2): con la riconferma, come le identità git.
      config: { access: { kind: "instance", permission: "users.manage" }, reauth: true },
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ username: z.string().trim().min(1) }),
        response: {
          200: z.object({ id: z.uuid(), bitbucketUsername: z.string().nullable() }),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
          // Gli errori di regola (`permission` incluso). Il bersaglio non è più
          // protetto (area 9, D-2): resta lo schema, per i client.
          403: roleRuleErrorSchema,
        },
      },
    },
    async (request, reply) => {
      let updated;
      try {
        updated = await app.db.transaction(async (tx) => {
          const [before] = await tx.select({ bitbucketUsername: users.bitbucketUsername }).from(users).where(eq(users.id, request.params.id)).for("update");
          const [row] = await tx
            .update(users)
            .set({ bitbucketUsername: request.body.username })
            .where(eq(users.id, request.params.id))
            .returning({ id: users.id, email: users.email, bitbucketUsername: users.bitbucketUsername });
          if (row) {
            await recordChange(tx, { type: "person.bitbucket_username_set", actor: request.user!, projectId: null, data: { object: personObject(row), before: before?.bitbucketUsername ?? null, after: row.bitbucketUsername } });
          }
          return row;
        });
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
      if (updated.id !== request.user!.id) {
        await recordSecurityEvent(app.db, { kind: "bitbucket_linked", user: updated, actor: request.user! });
        await publishSecurityAlert(app.db, updated.id, "bitbucket_linked", request.user!.email);
      }
      return reply.code(200).send({ id: updated.id, bitbucketUsername: updated.bitbucketUsername });
    },
  );

  // DELETE /api/users/:id/bitbucket — azzera users.bitbucketUsername (solo admin).
  app.delete(
    "/users/:id/bitbucket",
    {
      config: { access: { kind: "instance", permission: "users.manage" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          204: z.null(),
          404: errorSchema,
          ...authErrorResponses,
          // Gli errori di regola (`permission` incluso). Il bersaglio non è più
          // protetto (area 9, D-2): resta lo schema, per i client.
          403: roleRuleErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const updated = await app.db.transaction(async (tx) => {
        const [before] = await tx.select({ bitbucketUsername: users.bitbucketUsername }).from(users).where(eq(users.id, request.params.id)).for("update");
        const [row] = await tx.update(users).set({ bitbucketUsername: null }).where(eq(users.id, request.params.id)).returning({ id: users.id, email: users.email });
        // Area 9, F2: azzerarlo è un «impostato a niente», con il prima.
        if (row && before?.bitbucketUsername) {
          await recordChange(tx, { type: "person.bitbucket_username_set", actor: request.user!, projectId: null, data: { object: personObject(row), before: before.bitbucketUsername, after: null } });
        }
        return row;
      });
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
      config: { access: { kind: "instance", permission: "users.manage" } },
      schema: { response: { 200: z.array(observedAuthorSchema), ...authErrorResponses } },
    },
    async (request) => {
      const seen = await app.db
        .select()
        .from(gitAuthorsSeen)
        .orderBy(sql`${gitAuthorsSeen.lastSeenAt} desc`);
      const linked = await app.db
        .select({ email: gitIdentities.email, userId: gitIdentities.userId })
        .from(gitIdentities);
      const byEmail = new Map(linked.map((l) => [l.email, l.userId]));
      // I commit per email e progetto, nei soli progetti visibili (nella WHERE). Una query.
      const scope = await visibleProjectIds(app.db, request.user!);
      const counts =
        seen.length === 0 || (!isAllProjects(scope) && scope.length === 0)
          ? []
          : await app.db
              .select({ email: sql<string>`lower(${activityCommits.authorEmail})`, code: projects.code, n: sql<number>`count(distinct ${activityCommits.sha})::int` })
              .from(activityCommits)
              .innerJoin(repositories, eq(repositories.id, activityCommits.repoId))
              .innerJoin(projects, eq(projects.id, repositories.projectId))
              .where(and(inProjectsStrict(repositories.projectId, scope), inArray(sql`lower(${activityCommits.authorEmail})`, seen.map((s) => s.email.toLowerCase()))))
              .groupBy(sql`lower(${activityCommits.authorEmail})`, projects.code);
      const commitsOf = new Map<string, { commits: number; projectCodes: string[] }>();
      for (const c of [...counts].sort((a, b) => a.code.localeCompare(b.code))) {
        const row = commitsOf.get(c.email) ?? { commits: 0, projectCodes: [] };
        row.commits += c.n;
        row.projectCodes.push(c.code);
        commitsOf.set(c.email, row);
      }
      return seen.map((s) => ({
        email: s.email,
        authorName: s.authorName,
        lastSeenAt: s.lastSeenAt.toISOString(),
        linkedUserId: byEmail.get(s.email) ?? null,
        ...(commitsOf.get(s.email.toLowerCase()) ?? { commits: 0, projectCodes: [] }),
      }));
    },
  );
}
