import { aiProviders, encrypt } from "@stubwise/db";
import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin } from "../auth/session.js";
import { authErrorResponses, errorSchema } from "./shared.js";
import { apiError } from "../errors.js";

// Tipo di credenziale del provider: allineato all'enum ai_provider_kind del DB.
const aiProviderKindSchema = z.enum(["api_key", "account"]);

const createProviderSchema = z.object({
  kind: aiProviderKindSchema,
  label: z.string().min(1).max(100),
  // La secret in chiaro: cifrata prima di toccare il DB, non torna mai indietro.
  secret: z.string().min(1),
  // Posizione di failover esplicita; assente = append in coda.
  position: z.int().optional(),
});

// In modifica: la secret presente (min 1) viene ricifrata; assente = invariata.
// Non si può svuotare una secret (un provider senza credenziale non ha senso):
// per rimuoverla si elimina il provider. La validazione min(1) rifiuta "" con 400.
const updateProviderSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  secret: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  position: z.int().optional(),
});

const reorderSchema = z.object({ orderedIds: z.array(z.uuid()) });

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Proiezione pubblica di un provider: campi elencati esplicitamente (mai spread
 * della riga), così `secretEncrypted` non può trapelare nemmeno se lo schema
 * cambiasse. La secret è write-only: si espone solo il flag `secretSet`.
 */
// Stato del test della credenziale, allineato all'enum ai_provider_test_status.
const aiProviderTestStatusSchema = z.enum(["idle", "pending", "passed", "failed"]);

const publicProviderSchema = z.object({
  id: z.uuid(),
  kind: aiProviderKindSchema,
  label: z.string(),
  position: z.int(),
  enabled: z.boolean(),
  secretSet: z.literal(true),
  createdAt: z.string(),
  // Esito dell'ultimo test della credenziale (lo esegue il worker, vedi
  // POST /:id/test e apps/worker/src/agent/credential-tester.ts). `testError`
  // è il messaggio dell'ultimo fallimento (mai il segreto); le date sono ISO.
  testStatus: aiProviderTestStatusSchema,
  testRequestedAt: z.string().nullable(),
  testCheckedAt: z.string().nullable(),
  testError: z.string().nullable(),
});

type AiProviderRow = typeof aiProviders.$inferSelect;

function toPublicProvider(row: AiProviderRow): z.infer<typeof publicProviderSchema> {
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
 * write-only (espone solo `secretSet`). Tutte le route sono solo admin.
 * L'ordine di failover è dato da `position`; il riordino è applicativo
 * (riscrittura delle position in transazione via POST /reorder).
 */
export async function aiProviderRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        body: createProviderSchema,
        response: { 201: publicProviderSchema, ...authErrorResponses },
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

      const [created] = await app.db
        .insert(aiProviders)
        .values({ kind, label, secretEncrypted, position: resolvedPosition })
        .returning();
      if (!created) throw new Error("insert del provider non ha restituito la riga");
      return reply.code(201).send(toPublicProvider(created));
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAdmin,
      schema: { response: { 200: z.array(publicProviderSchema), ...authErrorResponses } },
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
      preHandler: requireAdmin,
      schema: {
        body: reorderSchema,
        response: { 200: z.array(publicProviderSchema), 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { orderedIds } = request.body;
      const unique = new Set(orderedIds);
      if (unique.size !== orderedIds.length) {
        return apiError(reply, 400, "reorder_duplicate_ids", "orderedIds contains duplicate ids");
      }

      const rows = await app.db.transaction(async (tx) => {
        const existing = await tx.select({ id: aiProviders.id }).from(aiProviders);
        const existingIds = new Set(existing.map((r) => r.id));
        if (existingIds.size !== unique.size || [...unique].some((id) => !existingIds.has(id))) {
          // Lancia per rollback; il chiamante traduce in 400.
          throw new ReorderMismatchError();
        }
        for (const [index, id] of orderedIds.entries()) {
          await tx.update(aiProviders).set({ position: index }).where(eq(aiProviders.id, id));
        }
        return tx
          .select()
          .from(aiProviders)
          .orderBy(asc(aiProviders.position), asc(aiProviders.createdAt));
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
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: updateProviderSchema,
        response: { 200: publicProviderSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { label, secret, enabled, position } = request.body;
      const updates: Partial<AiProviderRow> = {};
      if (label !== undefined) updates.label = label;
      if (enabled !== undefined) updates.enabled = enabled;
      if (position !== undefined) updates.position = position;
      if (secret !== undefined) updates.secretEncrypted = encrypt(secret, app.encryptionKey);

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      const [row] =
        Object.keys(updates).length === 0
          ? await app.db.select().from(aiProviders).where(eq(aiProviders.id, request.params.id))
          : await app.db
              .update(aiProviders)
              .set(updates)
              .where(eq(aiProviders.id, request.params.id))
              .returning();
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
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 200: publicProviderSchema, 404: errorSchema, ...authErrorResponses },
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
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const deleted = await app.db
        .delete(aiProviders)
        .where(eq(aiProviders.id, request.params.id))
        .returning({ id: aiProviders.id });
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
