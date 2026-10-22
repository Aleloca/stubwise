import { eq, inArray } from "drizzle-orm";
import {
  AI_MODEL_CHOICES,
  AI_OPERATIONS,
  aiModelChoiceSchema,
  aiOperationSchema,
  isConfigurableAiOperation,
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

const modelSettingsSchema = z.object({
  operations: z.array(
    z.object({
      operation: aiOperationSchema,
      configurable: z.boolean(),
      model: aiModelChoiceSchema.nullable(),
      workerDefault: z.string().nullable(),
    }),
  ),
  choices: z.array(aiModelChoiceSchema),
});

const patchBodySchema = z.object({
  models: z.partialRecord(aiOperationSchema, aiModelChoiceSchema.nullable()),
});

async function loadModelSettings(db: Db): Promise<z.infer<typeof modelSettingsSchema>> {
  const rows = await db.select().from(aiModelSettings);
  const [settings] = await db
    .select({ defaults: instanceSettings.workerModelDefaults })
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
      };
    }),
    choices: [...AI_MODEL_CHOICES],
  };
}

export async function modelSettingsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: { response: { 200: modelSettingsSchema, ...authErrorResponses } },
    },
    async () => loadModelSettings(app.db),
  );

  app.patch(
    "/",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: {
        body: patchBodySchema,
        response: { 200: modelSettingsSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const entries = Object.entries(request.body.models) as [
        AiOperation,
        AiModelChoice | null | undefined,
      ][];
      const bad = entries.find(([op]) => !isConfigurableAiOperation(op));
      if (bad) {
        return reply
          .code(400)
          .send({ code: "not_configurable", message: `operazione non configurabile: ${bad[0]}` });
      }
      const toDelete = entries.filter(([, m]) => m === null).map(([op]) => op);
      const toSet = entries.filter(([, m]) => typeof m === "string") as [
        AiOperation,
        AiModelChoice,
      ][];
      await app.db.transaction(async (tx) => {
        if (toDelete.length > 0) {
          await tx.delete(aiModelSettings).where(inArray(aiModelSettings.operation, toDelete));
        }
        for (const [operation, model] of toSet) {
          await tx
            .insert(aiModelSettings)
            .values({ operation, model, updatedByUserId: request.user!.id })
            .onConflictDoUpdate({
              target: aiModelSettings.operation,
              set: { model, updatedAt: new Date(), updatedByUserId: request.user!.id },
            });
        }
      });
      return loadModelSettings(app.db);
    },
  );
}
