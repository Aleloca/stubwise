import { recordChange } from "../services/change-log.js";
import { eq, inArray } from "drizzle-orm";
import {
  AI_MODEL_CHOICES,
  AI_OPERATIONS,
  aiModelChoiceSchema,
  aiOperationSchema,
  aiModelSourceOf,
  isConfigurableAiOperation,
  modelSettingsViewSchema,
  type AiModelChoice,
  type AiOperation,
} from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { aiModelSettings, instanceSettings } from "@stubwise/db";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Modello Anthropic per tipo di lavoro AI (solo admin). Il worker legge
 * `ai_model_settings` a ogni run: un cambio vale dalla prossima esecuzione,
 * senza riavvio. `null` nel PATCH cancella la riga (torna al predefinito).
 */

// Area 9, F3: lo schema sta in `@stubwise/shared`, lo legge anche il client.
const modelSettingsSchema = modelSettingsViewSchema;

const patchBodySchema = z.object({
  models: z.partialRecord(aiOperationSchema, aiModelChoiceSchema.nullable()),
});

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

async function loadModelSettings(db: DbOrTx): Promise<z.infer<typeof modelSettingsSchema>> {
  const rows = await db.select().from(aiModelSettings);
  const [settings] = await db
    .select({ defaults: instanceSettings.workerModelDefaults, envOperations: instanceSettings.workerModelEnvOperations })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  const chosen = new Map(rows.map((r) => [r.operation, r.model]));
  const defaults = settings?.defaults ?? {};
  const known = new Set<string>(AI_MODEL_CHOICES);
  return {
    operations: AI_OPERATIONS.map((operation) => {
      const model = chosen.get(operation);
      return {
        operation,
        configurable: isConfigurableAiOperation(operation),
        // Una riga con un valore fuori catalogo (lista cambiata in un deploy) si mostra come "predefinito".
        model: model !== undefined && known.has(model) ? (model as AiModelChoice) : null,
        workerDefault: defaults[operation] ?? null,
        source: aiModelSourceOf(operation, model, settings?.envOperations),
        fallbackSource: aiModelSourceOf(operation, null, settings?.envOperations) as "env" | "default",
      };
    }),
    choices: [...AI_MODEL_CHOICES],
  };
}

/**
 * Il modello effettivo come valore stabile del registro (Ruling T3):
 * `<fonte>:<modello>`, fonte `set`, `env` o `default`. Senza un default
 * pubblicato dal worker (mai partito) il modello non si sa: `null`.
 */
function stableModel(row: { model: string | null; workerDefault: string | null; source: "setting" | "env" | "default" }): string | null {
  const model = row.source === "setting" ? row.model : row.workerDefault;
  if (model === null) return null;
  return `${row.source === "setting" ? "set" : row.source}:${model}`;
}

/**
 * Il `PATCH /api/settings/models` (area 9, F7: estratto dalla rotta, lo
 * chiama anche `setModel` di Claude): un modello per operazione, null torna
 * al default, una voce per operazione che CAMBIA.
 */
export async function patchModelSettings(
  db: Db,
  actor: { id: string; email: string },
  models: Partial<Record<AiOperation, AiModelChoice | null>>,
): Promise<{ ok: true } | { ok: false; operation: string }> {
  const entries = Object.entries(models) as [AiOperation, AiModelChoice | null | undefined][];
  const bad = entries.find(([op]) => !isConfigurableAiOperation(op));
  if (bad) return { ok: false, operation: bad[0] };
  const toDelete = entries.filter(([, m]) => m === null).map(([op]) => op);
  const toSet = entries.filter(([, m]) => typeof m === "string") as [AiOperation, AiModelChoice][];
  await db.transaction(async (tx) => {
    const before = await loadModelSettings(tx);
    if (toDelete.length > 0) {
      await tx.delete(aiModelSettings).where(inArray(aiModelSettings.operation, toDelete));
    }
    for (const [operation, model] of toSet) {
      await tx
        .insert(aiModelSettings)
        .values({ operation, model, updatedByUserId: actor.id })
        .onConflictDoUpdate({
          target: aiModelSettings.operation,
          set: { model, updatedAt: new Date(), updatedByUserId: actor.id },
        });
    }
    // Area 9, F3: come il prototipo (`models.ts`), una voce per operazione
    // che CAMBIA, col modello effettivo prima e dopo in valore stabile
    // (`set:opus`, `env:haiku`, `default:sonnet`); l'oggetto è l'id
    // dell'operazione, il nome lo traduce la pagina.
    const after = await loadModelSettings(tx);
    for (const row of after.operations) {
      const old = before.operations.find((o) => o.operation === row.operation)!;
      const a = stableModel(old);
      const b = stableModel(row);
      if (a === b) continue;
      await recordChange(tx, { type: "model.changed", actor, projectId: null, data: { object: { type: "ai_settings", id: row.operation, label: row.operation }, before: a, after: b } });
    }
  });
  return { ok: true };
}

export async function modelSettingsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      config: { mcp: { action: "settings.models", summary: "I modelli AI: quello usato per ogni operazione.", effect: "read" }, access: { kind: "instance", permission: "settings.manage" } },
      schema: { response: { 200: modelSettingsSchema, ...authErrorResponses } },
    },
    async () => loadModelSettings(app.db),
  );

  app.patch(
    "/",
    {
      config: { mcp: { action: "settings.updateModels", summary: "Cambia il modello AI di una o più operazioni.", effect: "write", note: "Vale per tutta l'istanza, non solo per chi la cambia." }, access: { kind: "instance", permission: "settings.manage" } },
      schema: {
        body: patchBodySchema,
        response: { 200: modelSettingsSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Area 9, F7: la funzione, la stessa dell'azione di Claude `setModel`.
      const out = await patchModelSettings(app.db, request.user!, request.body.models);
      if (!out.ok) return reply.code(400).send({ code: "not_configurable", message: `operazione non configurabile: ${out.operation}` });
      return loadModelSettings(app.db);
    },
  );
}
