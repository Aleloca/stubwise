import { effortSchema, languageSchema, ticketTypeSchema, type TicketType } from "@stubwise/shared";
import { sendTest } from "@stubwise/notifications";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { automationRules, instanceSettings, notificationSettings } from "@stubwise/db";
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
const DEFAULT_RULE = { autoFix: true, maxEffort: 3, planApprovalMinEffort: null } as const;

const automationRuleSchema = z.object({
  type: ticketTypeSchema,
  autoFix: z.boolean(),
  maxEffort: effortSchema,
  // Soglia 1–5 oltre la quale (effort >= soglia) il fix richiede approvazione
  // umana del piano. null = mai (nessun gate di approvazione). Default null per
  // i client legacy che non inviano il campo.
  planApprovalMinEffort: effortSchema.nullable().default(null),
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
 * Impostazioni del webhook di notifica in uscita (riga singleton id=1). La
 * proiezione pubblica espone tutti i campi tranne quelli interni (id/timestamp):
 * il webhook NON è un segreto (lo conosce chi configura), quindi viene
 * restituito così com'è per riempire il form.
 */
const notificationFormatSchema = z.enum(["slack", "discord", "generic"]);

const notificationSettingsResponseSchema = z.object({
  webhookUrl: z.string().nullable(),
  format: notificationFormatSchema,
  enabled: z.boolean(),
  notifyTicketCreated: z.boolean(),
  notifyPrOpened: z.boolean(),
  notifyPrClosed: z.boolean(),
  notifyJobHeld: z.boolean(),
  notifyPlanReview: z.boolean(),
  notifyJobFailed: z.boolean(),
});

/**
 * Body del PUT: il webhook deve essere un URL https quando valorizzato; la
 * stringa vuota è ammessa e significa "nessun webhook" (salvata come null),
 * così la UI può svuotare il campo senza un endpoint dedicato.
 */
const updateNotificationsBodySchema = z.object({
  webhookUrl: z
    .union([z.literal(""), z.url({ protocol: /^https$/, error: "deve essere un URL https" })])
    .optional()
    .default(""),
  format: notificationFormatSchema,
  enabled: z.boolean(),
  notifyTicketCreated: z.boolean(),
  notifyPrOpened: z.boolean(),
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica anche le PR chiuse senza merge" come gli altri toggle.
  notifyPrClosed: z.boolean().default(true),
  notifyJobHeld: z.boolean(),
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica i piani in attesa di approvazione" come gli altri toggle.
  notifyPlanReview: z.boolean().default(true),
  notifyJobFailed: z.boolean(),
});

const testNotificationResponseSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});

/**
 * Impostazioni d'istanza (riga singleton id=1). `contentLanguage` è la lingua
 * usata per i CONTENUTI generati dalla piattaforma (commenti AI, report PR,
 * messaggi di notifica) — distinta dalla lingua dell'interfaccia del singolo
 * utente. La migrazione seeda la riga id=1; il PUT fa upsert idempotente.
 */
const instanceSettingsResponseSchema = z.object({
  contentLanguage: languageSchema,
});

const updateInstanceBodySchema = z.object({
  contentLanguage: languageSchema,
});

/**
 * Legge la riga di configurazione delle notifiche. La migrazione seeda la riga
 * id=1, ma per robustezza (DB ripristinato senza seed) si ripiega su default.
 */
async function loadNotificationSettings(
  db: Db,
): Promise<z.infer<typeof notificationSettingsResponseSchema>> {
  const [row] = await db.select().from(notificationSettings).limit(1);
  if (!row) {
    return {
      webhookUrl: null,
      format: "slack",
      enabled: true,
      notifyTicketCreated: true,
      notifyPrOpened: true,
      notifyPrClosed: true,
      notifyJobHeld: true,
      notifyPlanReview: true,
      notifyJobFailed: true,
    };
  }
  return {
    webhookUrl: row.webhookUrl,
    format: row.format,
    enabled: row.enabled,
    notifyTicketCreated: row.notifyTicketCreated,
    notifyPrOpened: row.notifyPrOpened,
    notifyPrClosed: row.notifyPrClosed,
    notifyJobHeld: row.notifyJobHeld,
    notifyPlanReview: row.notifyPlanReview,
    notifyJobFailed: row.notifyJobFailed,
  };
}

/**
 * Legge la riga singleton delle impostazioni d'istanza. La migrazione seeda
 * id=1 con default 'en', ma per robustezza (DB ripristinato senza seed) si
 * ripiega sul default dell'enum.
 */
async function loadInstanceSettings(
  db: Db,
): Promise<z.infer<typeof instanceSettingsResponseSchema>> {
  const [row] = await db.select().from(instanceSettings).limit(1);
  return { contentLanguage: row?.contentLanguage ?? "en" };
}

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
      planApprovalMinEffort: row?.planApprovalMinEffort ?? DEFAULT_RULE.planApprovalMinEffort,
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
            .values({
              type: rule.type,
              autoFix: rule.autoFix,
              maxEffort: rule.maxEffort,
              planApprovalMinEffort: rule.planApprovalMinEffort,
            })
            .onConflictDoUpdate({
              target: automationRules.type,
              set: {
                autoFix: rule.autoFix,
                maxEffort: rule.maxEffort,
                planApprovalMinEffort: rule.planApprovalMinEffort,
              },
            });
        }
      });
      return { rules: await loadAllRules(app.db) };
    },
  );

  app.get(
    "/notifications",
    {
      preHandler: requireAdmin,
      schema: {
        response: { 200: notificationSettingsResponseSchema, ...authErrorResponses },
      },
    },
    async () => {
      return loadNotificationSettings(app.db);
    },
  );

  app.put(
    "/notifications",
    {
      preHandler: requireAdmin,
      schema: {
        body: updateNotificationsBodySchema,
        response: {
          200: notificationSettingsResponseSchema,
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const body = request.body;
      // Stringa vuota → null: "nessun webhook configurato".
      const webhookUrl = body.webhookUrl === "" ? null : body.webhookUrl;
      // Upsert sul singleton (id=1): la migrazione seeda la riga, ma onConflict
      // la rende idempotente anche se mancasse. updatedAt è gestito da $onUpdate.
      await app.db
        .insert(notificationSettings)
        .values({
          id: 1,
          webhookUrl,
          format: body.format,
          enabled: body.enabled,
          notifyTicketCreated: body.notifyTicketCreated,
          notifyPrOpened: body.notifyPrOpened,
          notifyPrClosed: body.notifyPrClosed,
          notifyJobHeld: body.notifyJobHeld,
          notifyPlanReview: body.notifyPlanReview,
          notifyJobFailed: body.notifyJobFailed,
        })
        .onConflictDoUpdate({
          target: notificationSettings.id,
          set: {
            webhookUrl,
            format: body.format,
            enabled: body.enabled,
            notifyTicketCreated: body.notifyTicketCreated,
            notifyPrOpened: body.notifyPrOpened,
            notifyPrClosed: body.notifyPrClosed,
            notifyJobHeld: body.notifyJobHeld,
            notifyPlanReview: body.notifyPlanReview,
            notifyJobFailed: body.notifyJobFailed,
          },
        });
      return loadNotificationSettings(app.db);
    },
  );

  app.post(
    "/notifications/test",
    {
      preHandler: requireAdmin,
      schema: {
        response: { 200: testNotificationResponseSchema, ...authErrorResponses },
      },
    },
    async () => {
      // sendTest fa emergere l'esito (a differenza del dispatch best-effort):
      // l'admin deve sapere se il webhook è corretto. Usa il format salvato e
      // un evento ticket.created fittizio con link a ${publicUrl}/tickets/test.
      return sendTest(app.db, app.publicUrl);
    },
  );

  app.get(
    "/instance",
    {
      preHandler: requireAdmin,
      schema: {
        response: { 200: instanceSettingsResponseSchema, ...authErrorResponses },
      },
    },
    async () => {
      return loadInstanceSettings(app.db);
    },
  );

  app.put(
    "/instance",
    {
      preHandler: requireAdmin,
      schema: {
        body: updateInstanceBodySchema,
        response: {
          200: instanceSettingsResponseSchema,
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      // Upsert sul singleton (id=1): la migrazione seeda la riga, ma onConflict
      // la rende idempotente anche se mancasse. updatedAt è gestito da $onUpdate.
      await app.db
        .insert(instanceSettings)
        .values({ id: 1, contentLanguage: request.body.contentLanguage })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: { contentLanguage: request.body.contentLanguage },
        });
      return loadInstanceSettings(app.db);
    },
  );
}

export { automationSettingsSchema };
