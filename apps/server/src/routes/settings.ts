import { effortSchema, ticketTypeSchema, type TicketType } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { automationRules } from "@stubwise/db";
import { requireAdmin } from "../auth/session.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Impostazioni di automazione AI per tipo di ticket. L'admin decide, in
 * Settings, se l'auto-fix è attivo per un tipo e fino a quale sforzo
 * (max_effort): il triage avvia il fix automaticamente solo se auto_fix è
 * true E l'effort stimato è <= max_effort. Le righe sono seedate dalla
 * migrazione per tutti e 4 i tipi; questo modulo le legge/aggiorna e fa
 * comunque fallback a un default se una riga mancasse.
 */

/** Default difensivo, gemello di quello del worker: se una riga manca. */
const DEFAULT_RULE = { autoFix: true, maxEffort: 3 } as const;

const automationRuleSchema = z.object({
  type: ticketTypeSchema,
  autoFix: z.boolean(),
  maxEffort: effortSchema,
});

const automationSettingsSchema = z.object({
  rules: z.array(automationRuleSchema),
});

const updateAutomationBodySchema = z.object({
  // Almeno una regola; ogni tipo al più una volta è una garanzia debole qui
  // (l'upsert è idempotente), ma lo schema valida tipo/effort di ciascuna.
  rules: z.array(automationRuleSchema).min(1),
});

type AutomationRule = z.infer<typeof automationRuleSchema>;

/**
 * Restituisce le regole per TUTTI e 4 i tipi, riempiendo con il default
 * quelle eventualmente assenti nel DB: la UI mostra sempre 4 righe coerenti.
 */
async function loadAllRules(db: Db): Promise<AutomationRule[]> {
  const rows = await db.select().from(automationRules);
  const byType = new Map(rows.map((r) => [r.type, r]));
  return ticketTypeSchema.options.map((type: TicketType) => {
    const row = byType.get(type);
    return {
      type,
      autoFix: row?.autoFix ?? DEFAULT_RULE.autoFix,
      maxEffort: row?.maxEffort ?? DEFAULT_RULE.maxEffort,
    };
  });
}

/**
 * Route delle impostazioni, registrate sotto /api/settings. Solo admin:
 * l'automazione AI tocca quota e PR, è una scelta di amministrazione.
 */
export async function settingsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/automation",
    {
      preHandler: requireAdmin,
      schema: {
        response: { 200: automationSettingsSchema, ...authErrorResponses },
      },
    },
    async () => {
      return { rules: await loadAllRules(app.db) };
    },
  );

  app.put(
    "/automation",
    {
      preHandler: requireAdmin,
      schema: {
        body: updateAutomationBodySchema,
        response: { 200: automationSettingsSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      // Upsert di ciascuna regola sul tipo (PK). In transazione: o passano
      // tutte o nessuna, così la lettura successiva è sempre coerente.
      await app.db.transaction(async (tx) => {
        for (const rule of request.body.rules) {
          await tx
            .insert(automationRules)
            .values({ type: rule.type, autoFix: rule.autoFix, maxEffort: rule.maxEffort })
            .onConflictDoUpdate({
              target: automationRules.type,
              set: { autoFix: rule.autoFix, maxEffort: rule.maxEffort },
            });
        }
      });
      return { rules: await loadAllRules(app.db) };
    },
  );
}

export { automationSettingsSchema };
