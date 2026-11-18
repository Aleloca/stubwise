import { aiProviderViewSchema, createAiProviderSchema, updateAiProviderSchema } from "@stubwise/shared";
import { recordChange } from "../services/change-log.js";
import { aiProviders, encrypt, projects } from "@stubwise/db";
import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authErrorResponses, errorSchema } from "./shared.js";
import { requireReauth } from "../auth/access.js";
import { apiError } from "../errors.js";

// Tipo di credenziale del provider: definito in `@stubwise/shared`, da cui
// deriva anche l'enum ai_provider_kind del DB.


// In modifica: la secret presente (min 1) viene ricifrata; assente = invariata.
// Non si può svuotare una secret (un provider senza credenziale non ha senso):
// per rimuoverla si elimina il provider. La validazione min(1) rifiuta "" con 400.

const reorderSchema = z.object({ orderedIds: z.array(z.uuid()) });

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Proiezione pubblica di un provider: campi elencati esplicitamente (mai spread
 * della riga), così `secretEncrypted` non può trapelare nemmeno se lo schema
 * cambiasse. La secret è write-only: si espone solo il flag `secretSet`.
 */
// Stato del test della credenziale, allineato all'enum ai_provider_test_status.


type AiProviderRow = typeof aiProviders.$inferSelect;

function toPublicProvider(row: AiProviderRow): z.infer<typeof aiProviderViewSchema> {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    position: row.position,
    enabled: row.enabled,
    secretSet: true,
    createdAt: row.createdAt.toISOString(),
    testStatus: row.testStatus,
    testRequestedAt: row.testRequestedAt?.toISOString() ?? null,
    testCheckedAt: row.testCheckedAt?.toISOString() ?? null,
    testError: row.testError,
  };
}

/**
 * Route dei provider AI configurati dall'admin, registrate sotto
 * /api/ai-providers. La secret (chiave API o blob di login) è cifrata
 * AES-256-GCM at rest e non esce MAI dall'API: la proiezione pubblica è
 * write-only (espone solo `secretSet`). Tutte le route richiedono `ai_providers.manage`.
 * L'ordine di failover è dato da `position`; il riordino è applicativo
 * (riscrittura delle position in transazione via POST /reorder).
 */
/** L'oggetto delle voci del registro: l'account col nome dato da una persona. */
const providerObject = (row: { id: string; label: string }) => ({ type: "provider", id: row.id, label: row.label });

export async function aiProviderRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" }, reauth: true },
      schema: {
        body: createAiProviderSchema,
        response: { 201: aiProviderViewSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { kind, label, secret, position } = request.body;
      const secretEncrypted = encrypt(secret, app.encryptionKey);

      // Append in coda: max(position)+1, 0 sulla prima riga. Niente unique sulla
      // colonna, quindi una position duplicata non rompe (il riordino la sistema).
      let resolvedPosition = position;
      if (resolvedPosition === undefined) {
        const [agg] = await app.db
          .select({ max: sql<number | null>`max(${aiProviders.position})` })
          .from(aiProviders);
        resolvedPosition = agg?.max === null || agg?.max === undefined ? 0 : agg.max + 1;
      }

      const created = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(aiProviders)
          .values({ kind, label, secretEncrypted, position: resolvedPosition })
          .returning();
        if (!row) throw new Error("insert del provider non ha restituito la riga");
        await recordChange(tx, { type: "provider.created", actor: request.user!, projectId: null, data: { object: providerObject(row), params: { kind: row.kind } } });
        return row;
      });
      return reply.code(201).send(toPublicProvider(created));
    },
  );

  app.get(
    "/",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" } },
      schema: { response: { 200: z.array(aiProviderViewSchema), ...authErrorResponses } },
    },
    async () => {
      const rows = await app.db
        .select()
        .from(aiProviders)
        .orderBy(asc(aiProviders.position), asc(aiProviders.createdAt));
      return rows.map(toPublicProvider);
    },
  );

  // Riordino del failover: riscrive le position 0..n-1 nell'ordine ricevuto, in
  // transazione. `orderedIds` deve coprire ESATTAMENTE tutti i provider esistenti
  // (stesso insieme, senza duplicati): altrimenti 400, per evitare di lasciare
  // righe con position stantie. Registrata prima delle route /:id ma il path
  // distinto evita comunque ambiguità.
  app.post(
    "/reorder",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" } },
      schema: {
        body: reorderSchema,
        response: { 200: z.array(aiProviderViewSchema), 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { orderedIds } = request.body;
      const unique = new Set(orderedIds);
      if (unique.size !== orderedIds.length) {
        return apiError(reply, 400, "reorder_duplicate_ids", "orderedIds contains duplicate ids");
      }

      const rows = await app.db.transaction(async (tx) => {
        const beforeRows = await tx.select().from(aiProviders).orderBy(asc(aiProviders.position), asc(aiProviders.createdAt));
        const existing = beforeRows.map((r) => ({ id: r.id }));
        const existingIds = new Set(existing.map((r) => r.id));
        if (existingIds.size !== unique.size || [...unique].some((id) => !existingIds.has(id))) {
          // Lancia per rollback; il chiamante traduce in 400.
          throw new ReorderMismatchError();
        }
        for (const [index, id] of orderedIds.entries()) {
          await tx.update(aiProviders).set({ position: index }).where(eq(aiProviders.id, id));
        }
        const afterRows = await tx
          .select()
          .from(aiProviders)
          .orderBy(asc(aiProviders.position), asc(aiProviders.createdAt));
        // Come il prototipo: la catena dei nomi prima e dopo, e come oggetto
        // il primo account che ha cambiato posto. Un riordino uguale non scrive.
        const chain = (list: AiProviderRow[]) => list.map((r) => r.label).join(", ");
        const moved = afterRows.find((r, i) => beforeRows[i]?.id !== r.id);
        if (moved) {
          await recordChange(tx, { type: "provider.reordered", actor: request.user!, projectId: null, data: { object: providerObject(moved), before: chain(beforeRows), after: chain(afterRows) } });
        }
        return afterRows;
      }).catch((error: unknown) => {
        if (error instanceof ReorderMismatchError) return null;
        throw error;
      });

      if (rows === null) {
        return apiError(
          reply,
          400,
          "reorder_set_mismatch",
          "orderedIds must list exactly all existing providers",
        );
      }
      return rows.map(toPublicProvider);
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" }, partialReauth: true },
      schema: {
        params: idParamsSchema,
        body: updateAiProviderSchema,
        response: { 200: aiProviderViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { label, secret, enabled, position } = request.body;
      // Area 9, F3 (D-5): la riconferma solo quando il corpo porta un segreto
      // (sostituito o azzerato), con la regola del gate (`requireReauth`).
      if (secret !== undefined && !(await requireReauth(request, reply))) return reply;
      const updates: Partial<AiProviderRow> = {};
      if (label !== undefined) updates.label = label;
      if (enabled !== undefined) updates.enabled = enabled;
      if (position !== undefined) updates.position = position;
      if (secret !== undefined) updates.secretEncrypted = encrypt(secret, app.encryptionKey);

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      const row = await app.db.transaction(async (tx) => {
        const [before] = await tx.select().from(aiProviders).where(eq(aiProviders.id, request.params.id)).for("update");
        if (!before || Object.keys(updates).length === 0) return before;
        const [after] = await tx.update(aiProviders).set(updates).where(eq(aiProviders.id, request.params.id)).returning();
        const object = providerObject(after!);
        // Area 9, F3: le voci del prototipo. L'interruttore con on/off; la
        // credenziale «sostituita», mai un valore; un nome nuovo (il prototipo
        // non rinomina) con prima e dopo com'è dato da una persona.
        if (before.enabled !== after!.enabled) {
          await recordChange(tx, { type: "provider.updated", actor: request.user!, projectId: null, data: { object, before: before.enabled ? "on" : "off", after: after!.enabled ? "on" : "off" } });
        }
        if (before.label !== after!.label) {
          await recordChange(tx, { type: "provider.updated", actor: request.user!, projectId: null, data: { object, before: before.label, after: after!.label, params: { field: "name" } } });
        }
        if (secret !== undefined) {
          await recordChange(tx, { type: "provider.credential_replaced", actor: request.user!, projectId: null, data: { object } });
        }
        return after;
      });
      if (!row) return apiError(reply, 404, "ai_provider_not_found", "AI provider not found");
      return toPublicProvider(row);
    },
  );

  // Richiede un test della credenziale (Polish-A): il SERVER non può lanciare
  // `claude` (non è nella sua immagine), quindi marca la riga `pending` e il
  // WORKER — l'unico che shella sul CLI — la raccoglie, esegue un `claude -p`
  // di prova con quella credenziale e scrive l'esito (vedi
  // apps/worker/src/agent/credential-tester.ts). La UI fa polling sullo stato
  // via GET. Azzera l'esito precedente (testCheckedAt/testError) così il nuovo
  // test parte pulito. Status-guard non necessario: ri-richiedere un test è
  // sempre lecito e idempotente sul lato server.
  app.post(
    "/:id/test",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" } },
      schema: {
        params: idParamsSchema,
        response: { 200: aiProviderViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .update(aiProviders)
        .set({
          testStatus: "pending",
          testRequestedAt: sql`now()`,
          testCheckedAt: null,
          testError: null,
        })
        .where(eq(aiProviders.id, request.params.id))
        .returning();
      if (!row) return apiError(reply, 404, "ai_provider_not_found", "AI provider not found");
      return toPublicProvider(row);
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" }, reauth: true },
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // L'ON DELETE SET NULL azzera l'id sui progetti, non il flag: lo si azzera
      // qui, nella stessa transazione e PRIMA della cancellazione.
      const deleted = await app.db.transaction(async (tx) => {
        await tx
          .update(projects)
          .set({ aiProviderExclusive: false })
          .where(eq(projects.aiProviderId, request.params.id));
        const gone = await tx.delete(aiProviders).where(eq(aiProviders.id, request.params.id)).returning();
        for (const row of gone) await recordChange(tx, { type: "provider.deleted", actor: request.user!, projectId: null, data: { object: providerObject(row) } });
        return gone;
      });
      if (deleted.length === 0) {
        return apiError(reply, 404, "ai_provider_not_found", "AI provider not found");
      }
      return reply.code(204).send(null);
    },
  );
}

// Sentinella interna per annullare la transazione di reorder quando l'insieme
// degli id non combacia con i provider esistenti: il catch la traduce in 400.
class ReorderMismatchError extends Error {}
