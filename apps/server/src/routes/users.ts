import { asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { issuePasswordResetToken } from "../auth/password-reset.js";
import { gitIdentities, projectMembers, roles, users } from "@stubwise/db";
import { apiError } from "../errors.js";
import { publicUrlOrUndefined } from "../ingest/shared.js";
import { updateInstanceRoleSchema } from "@stubwise/shared";
import { deleteUser, setInstanceRole } from "../services/roles.js";
import { roleRuleErrorSchema, sendRoleRuleError } from "./roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/** Identità pubblica di un utente: mai hash o altri campi sensibili. */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(["admin", "member"]),
  // Ruolo d'istanza (permessi di progetto, 22 ott 2026). Opzionale: le rotte
  // Slack che riusano lo schema non lo popolano.
  instanceRoleId: z.uuid().optional(),
  // Istante di registrazione: la pagina Team mostra "membro dal …".
  createdAt: z.iso.datetime(),
  // Avatar Slack (image URL) derivato dal profilo Slack al momento del link;
  // null se l'utente non è linkato. Sempre lato server, mai dal client.
  avatarUrl: z.string().nullable(),
  // Slack user id linkato a questo utente; null se non linkato.
  slackUserId: z.string().nullable(),
});

/**
 * Utente nella prospettiva della pagina Team: l'identità pubblica più i campi
 * di linking git/bitbucket. Schema esteso DEDICATO a `GET /api/users`, così le
 * altre route che ritornano un singolo utente (`publicUserSchema`: PATCH role,
 * PUT/DELETE slack) restano invariate e non devono popolare questi campi.
 */
export const teamUserSchema = publicUserSchema.extend({
  // Username Bitbucket linkato (users.bitbucketUsername); null se non linkato.
  bitbucketUsername: z.string().nullable(),
  // Email git aliasate a questo membro (tabella git_identities).
  gitIdentities: z.array(
    z.object({ id: z.uuid(), email: z.string(), authorName: z.string().nullable() }),
  ),
});

/**
 * Route degli utenti, registrate sotto /api/users. La lista serve alla UI per
 * il selettore degli assegnatari e le menzioni: con `users.view_all` (d'istanza)
 * la vede intera; senza, vede sé stesso, chi condivide almeno un progetto con
 * lui e i full admin (membri impliciti di ogni progetto).
 */
export async function userRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(teamUserSchema), ...authErrorResponses } },
    },
    async (request) => {
      const me = request.user!;
      // Filtro nella WHERE: chi condivide un progetto, i full admin e sé stessi.
      const visible = me.instancePermissions.has("users.view_all")
        ? undefined
        : sql`(
            ${users.id} = ${me.id}
            or exists (
              select 1 from ${roles} ur
              where ur.id = ${users.instanceRoleId}
                and ur.permissions @> array['instance.full_admin']::text[]
            )
            or exists (
              select 1 from ${projectMembers} theirs
              inner join ${projectMembers} mine on mine.project_id = theirs.project_id
              where theirs.user_id = ${users.id} and mine.user_id = ${me.id}
            )
          )`;
      const rows = await app.db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          instanceRoleId: users.instanceRoleId,
          createdAt: users.createdAt,
          avatarUrl: users.slackAvatarUrl,
          slackUserId: users.slackUserId,
          bitbucketUsername: users.bitbucketUsername,
        })
        .from(users)
        .where(visible)
        .orderBy(asc(users.createdAt));

      // Git identities di TUTTI gli utenti in UNA query (no N+1), poi
      // raggruppate per userId in memoria.
      const userIds = rows.map((row) => row.id);
      const identityRows = userIds.length
        ? await app.db
            .select({
              id: gitIdentities.id,
              userId: gitIdentities.userId,
              email: gitIdentities.email,
              authorName: gitIdentities.authorName,
            })
            .from(gitIdentities)
            .where(inArray(gitIdentities.userId, userIds))
        : [];
      const identitiesByUser = new Map<
        string,
        { id: string; email: string; authorName: string | null }[]
      >();
      for (const row of identityRows) {
        const list = identitiesByUser.get(row.userId) ?? [];
        list.push({ id: row.id, email: row.email, authorName: row.authorName });
        identitiesByUser.set(row.userId, list);
      }

      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        gitIdentities: identitiesByUser.get(row.id) ?? [],
      }));
    },
  );

  /** L'utente nella forma di `publicUserSchema`, dopo un cambio di ruolo. */
  async function publicUser(id: string) {
    const [row] = await app.db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        instanceRoleId: users.instanceRoleId,
        createdAt: users.createdAt,
        avatarUrl: users.slackAvatarUrl,
        slackUserId: users.slackUserId,
      })
      .from(users)
      .where(eq(users.id, id));
    return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
  }

  const ruleErrors = {
    400: roleRuleErrorSchema,
    403: roleRuleErrorSchema,
    404: roleRuleErrorSchema,
    409: roleRuleErrorSchema,
  };

  // PATCH /api/users/:id/role — percorso LEGACY (client che conoscono solo
  // admin/member): porta il ruolo d'istanza sul preset `Admin`/`User` con le
  // stesse regole di `/instance-role` (anti-escalation, ultimo full admin, non
  // il proprio). Risponde ancora `last_admin` invece di `last_full_admin`: è il
  // codice che quei client traducono.
  app.patch(
    "/:id/role",
    {
      config: { access: { kind: "instance", permission: "users.manage" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ role: z.enum(["admin", "member"]) }),
        response: { 200: publicUserSchema, ...authErrorResponses, ...ruleErrors },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [preset] = await app.db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.presetKey, request.body.role === "admin" ? "admin" : "user"));
      if (!preset) {
        return apiError(reply, 409, "role_required_by_system", "Preset role missing");
      }
      try {
        await setInstanceRole(app.db, request.user!, id, preset.id, {
          lastAdminCode: "last_admin",
        });
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
      const user = await publicUser(id);
      if (!user) return apiError(reply, 404, "user_not_found", "User not found");
      return reply.code(200).send(user);
    },
  );

  // PATCH /api/users/:id/instance-role — cambia il ruolo d'istanza. Si
  // assegna solo un ruolo i cui permessi d'istanza effettivi sono inclusi nei
  // propri (un ruolo con `instance.full_admin` lo assegna solo un full admin),
  // mai il proprio, e mai togliendo l'ultimo full admin.
  app.patch(
    "/:id/instance-role",
    {
      config: { access: { kind: "instance", permission: "users.manage" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        body: updateInstanceRoleSchema,
        response: { 200: publicUserSchema, ...authErrorResponses, ...ruleErrors },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        await setInstanceRole(app.db, request.user!, id, request.body.roleId);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
      const user = await publicUser(id);
      if (!user) return apiError(reply, 404, "user_not_found", "User not found");
      return reply.code(200).send(user);
    },
  );

  // DELETE /api/users/:id — elimina un utente (non sé stessi). Le sue tracce
  // nei ticket restano senza autore (colonne `ON DELETE SET NULL`), quello che
  // è solo suo (sessioni, token, inbox, account Google) se ne va con lui. Mai
  // l'ultimo full admin (409 `last_full_admin`).
  app.delete(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "users.manage" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), ...authErrorResponses, ...ruleErrors },
      },
    },
    async (request, reply) => {
      try {
        await deleteUser(app.db, request.user!, request.params.id);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
      return reply.code(204).send(null);
    },
  );

  // POST /api/users/:id/password-reset — link monouso per reimpostare la
  // password di un altro utente (solo admin, 21 ott 2026). Il link vale 24 ore
  // e annulla quelli precedenti dello stesso utente; nel DB ne resta solo
  // l'hash (vedi `password_reset_tokens`). Chi lo usa sceglie la password
  // nuova su `/reset-password/<token>`, e tutte le sue sessioni si chiudono.
  //
  // Non su sé stessi (400): per la propria password c'è il cambio dal profilo,
  // che chiede quella attuale. Senza questo rifiuto una sessione admin rubata
  // basterebbe a fissare una password nuova sull'account dell'admin senza
  // conoscere quella vecchia.
  app.post(
    "/:id/password-reset",
    {
      config: { access: { kind: "instance", permission: "users.manage" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          201: z.object({ url: z.string(), expiresAt: z.iso.datetime() }),
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      // Solo dalla sessione del browser, come `POST /api/auth/me/password`: un
      // PAT (MCP, script, il token dell'app) è una credenziale delegata, e chi
      // lo ruba non deve poter prendersi l'account di un altro utente
      // emettendo un link a nome dell'admin.
      if (request.user!.patId !== undefined) {
        return apiError(
          reply,
          403,
          "session_required",
          "Password reset links can only be created from a browser session",
        );
      }
      if (id === request.user!.id) {
        return apiError(
          reply,
          400,
          "cannot_reset_own_password",
          "Use the password change in your account settings",
        );
      }
      const issued = await issuePasswordResetToken(app.db, id, request.user!.id);
      if (!issued) {
        return apiError(reply, 404, "user_not_found", "User not found");
      }
      // URL assoluto quando PUBLIC_URL è configurato (in produzione lo è
      // sempre), altrimenti il solo path: il web lo completa con la propria
      // origin.
      const path = `/reset-password/${issued.token}`;
      const base = publicUrlOrUndefined(instance);
      return reply
        .code(201)
        .send({ url: base ? `${base}${path}` : path, expiresAt: issued.expiresAt.toISOString() });
    },
  );
}
