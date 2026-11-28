import { changedFields, recordChange } from "../services/change-log.js";
import { widgetObject } from "../services/settings-entries.js";
import { widgetAdminSchema, widgetIdentitySecretResultSchema, widgetRepositoryFiltersSchema, widgetUpsertBodySchema } from "@stubwise/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectPermissionsFor, type RouteAccess } from "../auth/access.js";
import { generateWidgetIdentitySecret } from "../auth/widget-identity.js";
import { fromParam } from "../auth/project-resolvers.js";
import {
  encrypt,
  repositories,
  widgetConversations,
  widgets,
} from "@stubwise/db";
import { authErrorResponses, errorSchema, generateIngestionKey } from "./shared.js";
import { apiError } from "../errors.js";

const idParamsSchema = z.object({ projectId: z.uuid() });
const widgetParamsSchema = z.object({ projectId: z.uuid(), widgetId: z.uuid() });

/**
 * Proiezione pubblica (superficie SPA interna) di un widget. La `key` È esposta:
 * serve allo snippet di embed, e questa superficie è autenticata (sessione
 * cookie). Campi elencati esplicitamente, mai spread della riga (che porterebbe
 * `projectId`, interno all'API).
 */
// La forma di un widget sta in `@stubwise/shared` (`widgetAdminSchema`), la stessa del client.
const widgetSchema = widgetAdminSchema;

type WidgetRow = typeof widgets.$inferSelect;

/** Il corpo senza `origins`, che in tabella si chiama `allowed_origins`. */
function withoutOrigins<T extends { origins?: unknown }>(body: T): Omit<T, "origins"> {
  const rest: T = { ...body };
  delete rest.origins;
  return rest;
}

/**
 * Proiezione di una riga widget + conteggio conversazioni verso lo schema
 * pubblico. `repositoryFilters` è ri-parsato con `widgetRepositoryFiltersSchema`:
 * le entry VECCHIE (salvate prima della feature `kinds`) non hanno il campo, e
 * il `.default([])` dello schema lo materializza a `kinds: []` — così una riga
 * legacy serializza senza errori e la SPA riceve sempre la forma completa.
 */
function toPublicWidget(row: WidgetRow, conversationCount: number): z.infer<typeof widgetSchema> {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    enabled: row.enabled,
    enabledRepositoryIds: row.enabledRepositoryIds,
    repositoryFilters: widgetRepositoryFiltersSchema.parse(row.repositoryFilters),
    title: row.title,
    welcomeMessage: row.welcomeMessage,
    instructions: row.instructions,
    accentColor: row.accentColor,
    language: row.language,
    dailyMessageCap: row.dailyMessageCap,
    dailyTicketCap: row.dailyTicketCap,
    createdAt: row.createdAt.toISOString(),
    conversationCount,
    origins: row.allowedOrigins,
    // Il segreto non esce mai: solo se c'è e quando è nato.
    identitySecretSet: row.identitySecretEncrypted !== null,
    identitySecretRotatedAt: row.identitySecretRotatedAt?.toISOString() ?? null,
    identityRequired: row.identityRequired,
  };
}

/**
 * API INTERNA di amministrazione dei widget di assistenza, sotto
 * /api/projects/:projectId/widgets. Superficie della SPA (sessione cookie),
 * distinta dalla superficie pubblica /widget. Lettura per chi vede il
 * progetto; scrittura (create/update/delete) `widget.manage` nel progetto.
 * Include anche il viewer read-only delle conversazioni (superficie SPA), sotto
 * /widget/conversations.
 */
const READ_ACCESS: RouteAccess = { kind: "project", permission: "member", project: fromParam("projectId") };
const MANAGE_ACCESS: RouteAccess = {
  kind: "project",
  permission: "widget.manage",
  project: fromParam("projectId"),
};

export async function widgetAdminRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * Assicura che ogni id in `enabledRepositoryIds` sia un repository DI QUESTO
   * progetto: un id esistente ma di un altro progetto (o inesistente) è un 422,
   * non un salvataggio silenzioso di un filtro che non retrieverà mai. Restituisce
   * `true` se tutti validi (o lista vuota).
   */
  async function repositoriesBelongToProject(
    projectId: string,
    enabledRepositoryIds: string[],
  ): Promise<boolean> {
    if (enabledRepositoryIds.length === 0) return true;
    const rows = await app.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.projectId, projectId), inArray(repositories.id, enabledRepositoryIds)),
      );
    const valid = new Set(rows.map((r) => r.id));
    return enabledRepositoryIds.every((id) => valid.has(id));
  }

  /**
   * Ogni chiave di `repositoryFilters` deve essere un repo ESPOSTO dal widget
   * (⊆ `enabledRepositoryIds`): un filtro fine per un repo non abilitato non
   * retrieverebbe mai nulla e allargherebbe implicitamente la superficie. Poiché
   * `enabledRepositoryIds` è già validato (repo di questo progetto), la
   * sottoinsieme-relazione copre anche i repo di altri progetti. Restituisce
   * `true` se tutte le chiavi sono ⊆ (o filtro vuoto).
   */
  function filtersSubsetOfEnabled(
    enabledRepositoryIds: string[],
    repositoryFilters: Record<string, unknown>,
  ): boolean {
    const enabled = new Set(enabledRepositoryIds);
    return Object.keys(repositoryFilters).every((id) => enabled.has(id));
  }

  app.get(
    "/:projectId/widgets",
    {
      config: { mcp: { action: "widgets.list", summary: "I widget di Support di un progetto.", effect: "read" }, access: READ_ACCESS },
      schema: {
        params: idParamsSchema,
        response: {
          200: z.object({ widgets: z.array(widgetSchema), canManage: z.boolean() }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      // conversationCount aggregato IN UNA query (LEFT JOIN + GROUP BY, niente
      // N+1): i widget senza conversazioni restano in elenco con count 0.
      const rows = await app.db
        .select({
          widget: widgets,
          conversationCount: sql<number>`count(${widgetConversations.id})::int`,
        })
        .from(widgets)
        .leftJoin(widgetConversations, eq(widgetConversations.widgetId, widgets.id))
        .where(eq(widgets.projectId, projectId))
        .groupBy(widgets.id)
        // Ordine stabile: createdAt asc, tiebreaker sull'id al bordo del limit.
        .orderBy(asc(widgets.createdAt), asc(widgets.id));

      // Area 8, F3: chi guarda può gestirli? (l'app nasconde la sezione senza).
      const permissions = await projectPermissionsFor(app.db, request.user!, projectId);
      return {
        widgets: rows.map((r) => toPublicWidget(r.widget, r.conversationCount)),
        canManage: permissions?.has("widget.manage") ?? false,
      };
    },
  );

  app.post(
    "/:projectId/widgets",
    {
      config: { mcp: { action: "widgets.create", summary: "Crea un widget di Support per un progetto.", effect: "write", note: "Il widget acceso risponde ai clienti sui siti indicati in `origins`." }, access: MANAGE_ACCESS },
      schema: {
        params: idParamsSchema,
        body: widgetUpsertBodySchema,
        response: {
          200: z.object({ widget: widgetSchema }),
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const body = request.body;

      if (!(await repositoriesBelongToProject(projectId, body.enabledRepositoryIds))) {
        return apiError(
          reply,
          422,
          "invalid_repository",
          "enabledRepositoryIds must reference repositories of this project",
        );
      }

      if (!filtersSubsetOfEnabled(body.enabledRepositoryIds, body.repositoryFilters)) {
        return apiError(
          reply,
          422,
          "invalid_repository_filter",
          "repositoryFilters keys must be a subset of enabledRepositoryIds",
        );
      }
      // Un widget nuovo non ha ancora un segreto: «Solo clienti verificati»
      // lo renderebbe inutilizzabile.
      if (body.identityRequired === true) {
        return apiError(reply, 422, "identity_secret_missing", "Generate the identity secret before requiring verified customers");
      }

      const row = await app.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(widgets)
          // body per primo: projectId e key non devono mai essere sovrascrivibili
          // dal client, nemmeno se lo schema diventasse passthrough.
          // `origins` (area 8, F3, S16) è la colonna `allowed_origins`; assente = vuoto.
          .values({ ...withoutOrigins(body), allowedOrigins: body.origins ?? [], projectId, key: generateIngestionKey() })
          .returning();
        if (!created) throw new Error("insert del widget non ha restituito la riga");
        // Area 9, F5: la voce nella transazione; mai la chiave.
        await recordChange(tx, { type: "widget.created", actor: request.user!, projectId, data: { object: widgetObject(created) } });
        return created;
      });
      // Widget appena creato: nessuna conversazione ancora collegata.
      return { widget: toPublicWidget(row, 0) };
    },
  );

  app.put(
    "/:projectId/widgets/:widgetId",
    {
      config: { mcp: { action: "widgets.update", summary: "Modifica un widget di Support: testi, istruzioni, limiti, siti, repository.", effect: "write", note: "Le istruzioni cambiano come risponde ai clienti." }, access: MANAGE_ACCESS },
      schema: {
        params: widgetParamsSchema,
        // `key` NON è nel body: immutabile dopo la creazione.
        body: widgetUpsertBodySchema,
        response: {
          200: z.object({ widget: widgetSchema }),
          404: errorSchema,
          422: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, widgetId } = request.params;
      const body = request.body;

      const [existing] = await app.db
        .select({ id: widgets.id, name: widgets.name, identitySecretEncrypted: widgets.identitySecretEncrypted })
        .from(widgets)
        .where(and(eq(widgets.id, widgetId), eq(widgets.projectId, projectId)));
      // Widget inesistente o di un altro progetto: 404 (isolamento).
      if (!existing) return apiError(reply, 404, "widget_not_found", "Widget not found");

      if (!(await repositoriesBelongToProject(projectId, body.enabledRepositoryIds))) {
        return apiError(
          reply,
          422,
          "invalid_repository",
          "enabledRepositoryIds must reference repositories of this project",
        );
      }

      if (!filtersSubsetOfEnabled(body.enabledRepositoryIds, body.repositoryFilters)) {
        return apiError(
          reply,
          422,
          "invalid_repository_filter",
          "repositoryFilters keys must be a subset of enabledRepositoryIds",
        );
      }
      if (body.identityRequired === true && existing.identitySecretEncrypted === null) {
        return apiError(reply, 422, "identity_secret_missing", "Generate the identity secret before requiring verified customers");
      }

      const row = await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(widgets)
          // `origins` assente (un client che non lo conosce) lascia l'elenco com'è.
          .set({ ...withoutOrigins(body), ...(body.origins !== undefined ? { allowedOrigins: body.origins } : {}) })
          .where(and(eq(widgets.id, widgetId), eq(widgets.projectId, projectId)))
          .returning();
        if (!updated) throw new Error("update del widget non ha restituito la riga");
        // Come il prototipo: la voce c'è sempre, col prima/dopo del solo nome.
        const diff = changedFields({ name: existing.name }, { name: updated.name });
        await recordChange(tx, { type: "widget.updated", actor: request.user!, projectId, data: { object: widgetObject(updated), ...(diff ?? {}) } });
        return updated;
      });

      const [count] = await app.db
        .select({ conversationCount: sql<number>`count(*)::int` })
        .from(widgetConversations)
        .where(eq(widgetConversations.widgetId, widgetId));
      return { widget: toPublicWidget(row, count?.conversationCount ?? 0) };
    },
  );

  // Area 8, «L'API per i siti» (S1): genera o RIGENERA il segreto d'identità
  // del widget, col quale il backend del sito firma i suoi clienti. Il
  // segreto si mostra QUESTA volta sola e si salva cifrato; il vecchio smette
  // subito (D-5). È una credenziale: `widget.manage` più la riconferma recente
  // (`config.reauth`, con le sue regole: vedi `applyReauth`).
  app.post(
    "/:projectId/widgets/:widgetId/identity-secret",
    {
      config: { access: MANAGE_ACCESS, reauth: true },
      schema: {
        params: widgetParamsSchema,
        response: { 200: widgetIdentitySecretResultSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, widgetId } = request.params;
      const secret = generateWidgetIdentitySecret();
      const rotatedAt = new Date();
      const [row] = await app.db
        .update(widgets)
        .set({ identitySecretEncrypted: encrypt(secret, app.encryptionKey), identitySecretRotatedAt: rotatedAt })
        .where(and(eq(widgets.id, widgetId), eq(widgets.projectId, projectId)))
        .returning({ id: widgets.id });
      // Widget inesistente o di un altro progetto: 404 (isolamento), niente scritto.
      if (!row) return apiError(reply, 404, "widget_not_found", "Widget not found");
      // Il segreto non resta in nessuna cache intermedia.
      reply.header("cache-control", "no-store");
      return { secret, rotatedAt: rotatedAt.toISOString() };
    },
  );

  app.delete(
    "/:projectId/widgets/:widgetId",
    {
      config: { mcp: { action: "widgets.delete", summary: "Elimina un widget di Support: smette di rispondere sui siti.", effect: "destructive" }, access: MANAGE_ACCESS },
      schema: {
        params: widgetParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, widgetId } = request.params;
      // La FK widget_conversations.widget_id fa SET NULL: lo storico resta
      // consultabile come "widget eliminato".
      const deleted = await app.db.transaction(async (tx) => {
        const gone = await tx
          .delete(widgets)
          .where(and(eq(widgets.id, widgetId), eq(widgets.projectId, projectId)))
          .returning({ id: widgets.id, name: widgets.name });
        if (gone[0]) await recordChange(tx, { type: "widget.deleted", actor: request.user!, projectId, data: { object: widgetObject(gone[0]) } });
        return gone;
      });
      if (deleted.length === 0) {
        return apiError(reply, 404, "widget_not_found", "Widget not found");
      }
      return reply.code(204).send(null);
    },
  );

  // ── Viewer read-only delle conversazioni del widget (superficie SPA) ──────

}
