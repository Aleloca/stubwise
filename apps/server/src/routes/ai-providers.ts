import { aiProviderViewSchema, createAiProviderSchema, updateAiProviderSchema } from "@stubwise/shared";
import { recordChange } from "../services/change-log.js";
import { aiProviders, aiUsageSnapshots, encrypt, projects, type Db } from "@stubwise/db";
import { asc, count, desc, eq, or, sql } from "drizzle-orm";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Area 9, F3, Task 8c: le ultime 4 cifre di una credenziale (la vista le mostra; null se più corta di 8). */
const last4Of = (secret: string): string | null => (secret.length >= 8 ? secret.slice(-4) : null);

/** Spegnere o eliminare l'ULTIMO account acceso: senza, il worker non lavora (decisione del maintainer, 18 nov 2026). */
class LastEnabledProvider extends Error {}
export const LAST_ENABLED = Symbol("last_enabled_provider");
const lastEnabledOrThrow = (error: unknown): typeof LAST_ENABLED => {
  if (error instanceof LastEnabledProvider) return LAST_ENABLED;
  throw error;
};
const lastEnabledError = (reply: Parameters<typeof apiError>[0]) =>
  apiError(reply, 409, "last_enabled_provider", "This is the only enabled AI account: enable another one first");

/**
 * L'account `id` e tutti quelli accesi, bloccati in UNA query in ordine di id:
 * due spegnimenti in corsa non lasciano zero accesi, e chi blocca più account
 * (questa regola, il riordino dell'«Annulla» di Claude che li blocca tutti per
 * id) li prende nello stesso ordine. Prima si bloccava la riga dell'account e
 * POI gli altri: contro un riordino in corso le due transazioni potevano
 * aspettarsi a vicenda (revisione del lotto 1). Nessun test deterministico:
 * l'ordine dei lock di due transazioni non si riproduce a comando, ed è
 * l'unica query che conta.
 */
async function lockForEnabledRule(tx: DbOrTx, id: string): Promise<{ target: AiProviderRow | undefined; othersEnabled: number }> {
  const rows = await tx
    .select()
    .from(aiProviders)
    .where(or(eq(aiProviders.id, id), eq(aiProviders.enabled, true)))
    .orderBy(asc(aiProviders.id))
    .for("update");
  return { target: rows.find((r) => r.id === id), othersEnabled: rows.filter((r) => r.id !== id && r.enabled).length };
}
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

/** Il contesto della vista (Task 8c): quanti account sono accesi, l'uso dell'ultimo campione per provider. */
interface ProviderViewContext {
  enabledCount: number;
  usedPct: Map<string, number>;
  now: Date;
}

/** La soglia di «vicino al limite» (Task 8c): come il prototipo, dall'80% usato. */
export const QUOTA_NEAR_PCT = 80;

async function providerViewContext(db: DbOrTx): Promise<ProviderViewContext> {
  const [{ n }] = (await db.select({ n: count() }).from(aiProviders).where(eq(aiProviders.enabled, true))) as [{ n: number }];
  const snaps = await db
    .selectDistinctOn([aiUsageSnapshots.providerId], { providerId: aiUsageSnapshots.providerId, session: aiUsageSnapshots.sessionRemaining, weekly: aiUsageSnapshots.weeklyRemaining })
    .from(aiUsageSnapshots)
    .orderBy(aiUsageSnapshots.providerId, desc(aiUsageSnapshots.capturedAt));
  const pct = (w: unknown) => (w && typeof w === "object" && typeof (w as { percentUsed?: unknown }).percentUsed === "number" ? (w as { percentUsed: number }).percentUsed : 0);
  return { enabledCount: Number(n), usedPct: new Map(snaps.map((s) => [s.providerId, Math.max(pct(s.session), pct(s.weekly))])), now: new Date() };
}

async function providerViews(db: DbOrTx, rows: AiProviderRow[]) {
  const ctx = await providerViewContext(db);
  return rows.map((r) => toPublicProvider(r, ctx));
}

function toPublicProvider(row: AiProviderRow, ctx: ProviderViewContext): z.infer<typeof aiProviderViewSchema> {
  const limited = row.limitedUntil !== null && row.limitedUntil > ctx.now;
  return {
    lastEnabled: row.enabled && ctx.enabledCount === 1,
    last4: row.secretLast4,
    limitedUntil: row.limitedUntil?.toISOString() ?? null,
    quotaBand: limited ? "limited" : (ctx.usedPct.get(row.id) ?? 0) >= QUOTA_NEAR_PCT ? "near" : "ok",
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

/**
 * Il riordino (`POST /api/ai-providers/reorder`, area 9, F7: estratto dalla
 * rotta). null se `orderedIds` non elenca esattamente tutti gli account.
 */
export async function reorderProviders(db: Db, actor: { id: string; email: string }, orderedIds: string[]): Promise<AiProviderRow[] | null> {
  const unique = new Set(orderedIds);
  const rows = await db.transaction(async (tx) => {
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
      await recordChange(tx, { type: "provider.reordered", actor: actor, projectId: null, data: { object: providerObject(moved), before: chain(beforeRows), after: chain(afterRows) } });
    }
    return afterRows;
  }).catch((error: unknown) => {
    if (error instanceof ReorderMismatchError) return null;
    throw error;
  });
  return rows;
}

/**
 * La patch di un account AI (`PATCH /api/ai-providers/:id`, area 9, F7:
 * estratta dalla rotta). La riconferma per un segreto la chiede la ROTTA;
 * Claude non ne porta mai uno (`encryptionKey` null). Restituisce la riga,
 * `undefined` se non c'è, o `LAST_ENABLED` per l'ultimo account acceso.
 */
export async function patchProvider(
  db: Db,
  encryptionKey: Buffer | null,
  actor: { id: string; email: string },
  id: string,
  body: { label?: string | undefined; secret?: string | undefined; enabled?: boolean | undefined; position?: number | undefined },
): Promise<AiProviderRow | undefined | typeof LAST_ENABLED> {
  const { label, secret, enabled, position } = body;
  const key = (): Buffer => {
    if (!encryptionKey) throw new Error("patchProvider: un segreto senza chiave di cifratura");
    return encryptionKey;
  };
  const updates: Partial<AiProviderRow> = {};
  if (label !== undefined) updates.label = label;
  if (enabled !== undefined) updates.enabled = enabled;
  if (position !== undefined) updates.position = position;
  if (secret !== undefined) {
    updates.secretEncrypted = encrypt(secret, key());
    updates.secretLast4 = last4Of(secret);
  }

  // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
  const row = await db.transaction(async (tx) => {
    const { target: before, othersEnabled } = await lockForEnabledRule(tx, id);
    if (!before || Object.keys(updates).length === 0) return before;
    // Una posizione a mano è un riordino (registro, area 9): la stessa voce di `reorderProviders`.
    const orderOf = () => tx.select().from(aiProviders).orderBy(asc(aiProviders.position), asc(aiProviders.createdAt));
    const beforeOrder = position !== undefined ? await orderOf() : [];
    // Task 8c: l'ultimo account acceso non si spegne.
    if (before.enabled && updates.enabled === false && othersEnabled === 0) throw new LastEnabledProvider();
    const [after] = await tx.update(aiProviders).set(updates).where(eq(aiProviders.id, id)).returning();
    const object = providerObject(after!);
    // Area 9, F3: le voci del prototipo. L'interruttore con on/off; la
    // credenziale «sostituita», mai un valore; un nome nuovo (il prototipo
    // non rinomina) con prima e dopo com'è dato da una persona.
    if (before.enabled !== after!.enabled) {
      await recordChange(tx, { type: "provider.updated", actor: actor, projectId: null, data: { object, before: before.enabled ? "on" : "off", after: after!.enabled ? "on" : "off" } });
    }
    if (before.label !== after!.label) {
      await recordChange(tx, { type: "provider.updated", actor: actor, projectId: null, data: { object, before: before.label, after: after!.label, params: { field: "name" } } });
    }
    if (secret !== undefined) {
      await recordChange(tx, { type: "provider.credential_replaced", actor: actor, projectId: null, data: { object } });
    }
    if (position !== undefined) {
      const afterOrder = await orderOf();
      const moved = afterOrder.find((r, i) => beforeOrder[i]?.id !== r.id);
      const chain = (list: AiProviderRow[]) => list.map((r) => r.label).join(", ");
      if (moved) await recordChange(tx, { type: "provider.reordered", actor: actor, projectId: null, data: { object: providerObject(moved), before: chain(beforeOrder), after: chain(afterOrder) } });
    }
    return after;
  }).catch(lastEnabledOrThrow);
  return row;
}

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
          .values({ kind, label, secretEncrypted, secretLast4: last4Of(secret), position: resolvedPosition })
          .returning();
        if (!row) throw new Error("insert del provider non ha restituito la riga");
        await recordChange(tx, { type: "provider.created", actor: request.user!, projectId: null, data: { object: providerObject(row), params: { kind: row.kind } } });
        return row;
      });
      return reply.code(201).send((await providerViews(app.db, [created]))[0]!);
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
      return providerViews(app.db, rows);
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

      // Area 9, F7: la funzione, la stessa dell'azione di Claude `moveProvider`.
      const rows = await reorderProviders(app.db, request.user!, orderedIds);
      if (rows === null) {
        return apiError(
          reply,
          400,
          "reorder_set_mismatch",
          "orderedIds must list exactly all existing providers",
        );
      }
      return providerViews(app.db, rows);
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" }, partialReauth: true },
      schema: {
        params: idParamsSchema,
        body: updateAiProviderSchema,
        response: { 200: aiProviderViewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { label, secret, enabled, position } = request.body;
      // Area 9, F3 (D-5): la riconferma solo quando il corpo porta un segreto
      // (sostituito o azzerato), con la regola del gate (`requireReauth`).
      if (secret !== undefined && !(await requireReauth(request, reply))) return reply;
      // Area 9, F7: la funzione, la stessa dell'azione di Claude `setProviderEnabled`.
      const row = await patchProvider(app.db, app.encryptionKey, request.user!, request.params.id, { label, secret, enabled, position });
      if (row === LAST_ENABLED) return lastEnabledError(reply);
      if (!row) return apiError(reply, 404, "ai_provider_not_found", "AI provider not found");
      return (await providerViews(app.db, [row]))[0]!;
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
      return (await providerViews(app.db, [row]))[0]!;
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "ai_providers.manage" }, reauth: true },
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // L'ON DELETE SET NULL azzera l'id sui progetti, non il flag: lo si azzera
      // qui, nella stessa transazione e PRIMA della cancellazione.
      const deleted = await app.db.transaction(async (tx) => {
        // Task 8c: l'ultimo account acceso non si elimina.
        const { target, othersEnabled } = await lockForEnabledRule(tx, request.params.id);
        if (target?.enabled && othersEnabled === 0) throw new LastEnabledProvider();
        await tx
          .update(projects)
          .set({ aiProviderExclusive: false })
          .where(eq(projects.aiProviderId, request.params.id));
        const gone = await tx.delete(aiProviders).where(eq(aiProviders.id, request.params.id)).returning();
        for (const row of gone) await recordChange(tx, { type: "provider.deleted", actor: request.user!, projectId: null, data: { object: providerObject(row) } });
        return gone;
      }).catch(lastEnabledOrThrow);
      if (deleted === LAST_ENABLED) return lastEnabledError(reply);
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
