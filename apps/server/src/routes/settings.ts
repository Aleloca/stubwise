import { eq } from "drizzle-orm";
import { effortSchema, languageSchema, ticketTypeSchema, type TicketType } from "@stubwise/shared";
import { sendTest } from "@stubwise/notifications";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { automationRules, encrypt, instanceSettings, notificationSettings } from "@stubwise/db";
import { requireAdmin } from "../auth/session.js";
import { s3ConfigFromSettings } from "../storage/index.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Impostazioni di automazione AI per tipo di ticket. L'admin decide, in
 * Settings, se l'auto-fix è attivo per un tipo e fino a quale sforzo
 * (max_effort): il triage avvia il fix automaticamente solo se auto_fix è
 * true E l'effort stimato è <= max_effort. Le righe sono seedate dalla
 * migrazione per tutti i tipi; questo modulo le legge/aggiorna e fa
 * comunque fallback a un default se una riga mancasse.
 */

/** Default difensivo, gemello di quello del worker: se una riga manca. */
const DEFAULT_RULE = {
  autoFix: true,
  maxEffort: 3,
  planApprovalMinEffort: null,
  maxCostUsd: null,
} as const;

// `review` nasce con auto-fix spento anche nel fallback (anti-loop): la riga
// seedata dalla migrazione lo garantisce già, questo copre il DB pre-seed.
const defaultRuleFor = (type: TicketType): Omit<AutomationRule, "type"> =>
  type === "review" ? { ...DEFAULT_RULE, autoFix: false } : DEFAULT_RULE;

const automationRuleSchema = z.object({
  type: ticketTypeSchema,
  autoFix: z.boolean(),
  maxEffort: effortSchema,
  // Soglia 1–5 oltre la quale (effort >= soglia) il fix richiede approvazione
  // umana del piano. null = mai (nessun gate di approvazione). Default null per
  // i client legacy che non inviano il campo.
  planApprovalMinEffort: effortSchema.nullable().default(null),
  // Tetto di costo per-ticket (USD) per questo tipo: oltre questa soglia il job
  // viene messo in hold. null = nessun tetto. Colonna numeric(12,6) → drizzle la
  // legge/scrive come STRINGA, qui l'API la espone come number. Default null per
  // i client legacy che non inviano il campo.
  maxCostUsd: z.number().nonnegative().nullable().default(null),
});

// Automazione PR Review d'istanza (singleton instance_settings): se attiva, il
// worker recensisce le PR esterne dei progetti abilitati.
const prReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  // Tetto di costo per-review (USD). null = nessun tetto. Colonna numeric(12,6)
  // in drizzle → stringa; l'API la espone come number.
  maxCostUsd: z.number().nonnegative().nullable().default(null),
});

const automationSettingsSchema = z.object({
  rules: z.array(automationRuleSchema),
  prReview: prReviewSettingsSchema,
});

const updateAutomationBodySchema = z.object({
  // Almeno una regola; ogni tipo al più una volta è una garanzia debole qui
  // (l'upsert è idempotente), ma lo schema valida tipo/effort di ciascuna.
  rules: z.array(automationRuleSchema).min(1),
  prReview: prReviewSettingsSchema,
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
  notifyBudgetHeld: z.boolean(),
  notifyReviewCompleted: z.boolean(),
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
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica i job messi in hold per superamento budget".
  notifyBudgetHeld: z.boolean().default(true),
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica le review AI delle PR completate".
  notifyReviewCompleted: z.boolean().default(true),
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
  // Tetto di spesa mensile (USD) dell'istanza: oltre questa soglia i nuovi job
  // vengono messi in hold. null = nessun tetto. Colonna numeric(12,6) → drizzle
  // la legge/scrive come STRINGA, qui l'API la espone come number.
  monthlyBudgetUsd: z.number().nonnegative().nullable(),
  // Storage S3-compatibile per gli allegati: i campi non-secret sono esposti in
  // chiaro (null se non impostati); la secret NON viene MAI restituita, solo il
  // flag `s3SecretKeySet`. `attachmentsEnabled` riassume se la config è completa
  // e valida (secret decifrabile).
  s3Endpoint: z.string().nullable(),
  s3Region: z.string().nullable(),
  s3Bucket: z.string().nullable(),
  s3AccessKey: z.string().nullable(),
  s3SecretKeySet: z.boolean(),
  attachmentsEnabled: z.boolean(),
  // Credenziali Slack write-only: i segreti NON sono MAI restituiti, solo i flag
  // che dicono SE sono impostati. `slackEnabled` riassume che entrambi i segreti
  // (signing secret + bot token) sono presenti → l'integrazione è completa.
  slackSigningSecretSet: z.boolean(),
  slackBotTokenSet: z.boolean(),
  slackEnabled: z.boolean(),
});

const updateInstanceBodySchema = z.object({
  contentLanguage: languageSchema,
  // Default null per i client legacy che non inviano il campo.
  monthlyBudgetUsd: z.number().nonnegative().nullable().default(null),
  // Campi S3 opzionali. Semantica: campo non-secret PRESENTE → aggiorna (la
  // stringa vuota azzera → null); ASSENTE → invariato. Per la secret vedi sotto.
  s3Endpoint: z.string().optional(),
  s3Region: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3AccessKey: z.string().optional(),
  // s3SecretKey: ASSENTE (undefined) → non tocca la colonna; stringa NON vuota →
  // cifra e salva; stringa VUOTA esplicita "" → azzera (disabilita lo storage).
  s3SecretKey: z.string().optional(),
  // Segreti Slack: stessa semantica write-only della secret S3. ASSENTE
  // (undefined) → non tocca la colonna; stringa NON vuota → cifra e salva;
  // stringa VUOTA esplicita "" → azzera (null). .optional() per distinguere
  // undefined da "".
  slackSigningSecret: z.string().optional(),
  slackBotToken: z.string().optional(),
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
      notifyBudgetHeld: true,
      notifyReviewCompleted: true,
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
    notifyBudgetHeld: row.notifyBudgetHeld,
    notifyReviewCompleted: row.notifyReviewCompleted,
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
  encryptionKey: Buffer,
): Promise<z.infer<typeof instanceSettingsResponseSchema>> {
  const [row] = await db.select().from(instanceSettings).limit(1);
  // attachmentsEnabled = config S3 completa E valida. s3ConfigFromSettings può
  // LANCIARE se la secret cifrata è corrotta o la chiave è errata: il try/catch
  // tratta l'eccezione come "non configurato/non valido" → false.
  let attachmentsEnabled = false;
  if (row) {
    try {
      attachmentsEnabled = s3ConfigFromSettings(row, encryptionKey) !== null;
    } catch {
      attachmentsEnabled = false;
    }
  }
  return {
    contentLanguage: row?.contentLanguage ?? "en",
    // numeric → stringa lato driver: converto a number, null resta null.
    monthlyBudgetUsd: row?.monthlyBudgetUsd != null ? Number(row.monthlyBudgetUsd) : null,
    s3Endpoint: row?.s3Endpoint ?? null,
    s3Region: row?.s3Region ?? null,
    s3Bucket: row?.s3Bucket ?? null,
    s3AccessKey: row?.s3AccessKey ?? null,
    // Mai la secret: solo se c'è un blob cifrato salvato.
    s3SecretKeySet: row?.s3SecretKeyEncrypted != null,
    attachmentsEnabled,
    // Mai i segreti Slack: solo se c'è un blob cifrato salvato. slackEnabled =
    // entrambi presenti (integrazione completa).
    slackSigningSecretSet: row?.slackSigningSecretEncrypted != null,
    slackBotTokenSet: row?.slackBotTokenEncrypted != null,
    slackEnabled: row?.slackSigningSecretEncrypted != null && row?.slackBotTokenEncrypted != null,
  };
}

/**
 * Restituisce le regole per TUTTI i tipi di ticket (i 5 di ticketTypeSchema),
 * riempiendo con il default quelle eventualmente assenti nel DB: la UI mostra
 * sempre una riga coerente per ogni tipo.
 */
async function loadAllRules(db: Db): Promise<AutomationRule[]> {
  const rows = await db.select().from(automationRules);
  const byType = new Map(rows.map((r) => [r.type, r]));
  return ticketTypeSchema.options.map((type: TicketType) => {
    const row = byType.get(type);
    const fallback = defaultRuleFor(type);
    return {
      type,
      autoFix: row?.autoFix ?? fallback.autoFix,
      maxEffort: row?.maxEffort ?? fallback.maxEffort,
      planApprovalMinEffort: row?.planApprovalMinEffort ?? fallback.planApprovalMinEffort,
      // numeric → stringa lato driver: converto a number, null resta null.
      maxCostUsd: row?.maxCostUsd != null ? Number(row.maxCostUsd) : fallback.maxCostUsd,
    };
  });
}

/** Impostazioni PR Review dal singleton instance_settings (default: spenta). */
async function loadPrReviewSettings(db: Db): Promise<z.infer<typeof prReviewSettingsSchema>> {
  const [row] = await db
    .select({
      enabled: instanceSettings.prReviewEnabled,
      maxCostUsd: instanceSettings.prReviewMaxCostUsd,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return {
    enabled: row?.enabled ?? false,
    // numeric → stringa lato driver: converto a number, null resta null.
    maxCostUsd: row?.maxCostUsd != null ? Number(row.maxCostUsd) : null,
  };
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
      return { rules: await loadAllRules(app.db), prReview: await loadPrReviewSettings(app.db) };
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
          // numeric(12,6): drizzle scrive una STRINGA. number → stringa, null resta null.
          const maxCostUsd = rule.maxCostUsd != null ? String(rule.maxCostUsd) : null;
          await tx
            .insert(automationRules)
            .values({
              type: rule.type,
              autoFix: rule.autoFix,
              maxEffort: rule.maxEffort,
              planApprovalMinEffort: rule.planApprovalMinEffort,
              maxCostUsd,
            })
            .onConflictDoUpdate({
              target: automationRules.type,
              set: {
                autoFix: rule.autoFix,
                maxEffort: rule.maxEffort,
                planApprovalMinEffort: rule.planApprovalMinEffort,
                maxCostUsd,
              },
            });
        }
        // Impostazioni PR Review sul singleton instance_settings (id=1): la
        // migrazione seeda la riga, onConflict la rende idempotente comunque.
        // numeric(12,6): drizzle scrive una STRINGA. number → stringa, null resta null.
        const maxCost = request.body.prReview.maxCostUsd;
        await tx
          .insert(instanceSettings)
          .values({
            id: 1,
            prReviewEnabled: request.body.prReview.enabled,
            prReviewMaxCostUsd: maxCost != null ? String(maxCost) : null,
          })
          .onConflictDoUpdate({
            target: instanceSettings.id,
            set: {
              prReviewEnabled: request.body.prReview.enabled,
              prReviewMaxCostUsd: maxCost != null ? String(maxCost) : null,
              // Il $onUpdate di drizzle NON scatta su onConflictDoUpdate.
              updatedAt: new Date(),
            },
          });
      });
      return { rules: await loadAllRules(app.db), prReview: await loadPrReviewSettings(app.db) };
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
      // la rende idempotente anche se mancasse. updatedAt va impostato a mano
      // nel `set`: il $onUpdate di drizzle NON scatta su onConflictDoUpdate.
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
          notifyBudgetHeld: body.notifyBudgetHeld,
          notifyReviewCompleted: body.notifyReviewCompleted,
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
            notifyBudgetHeld: body.notifyBudgetHeld,
            notifyReviewCompleted: body.notifyReviewCompleted,
            notifyJobFailed: body.notifyJobFailed,
            updatedAt: new Date(),
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
      return loadInstanceSettings(app.db, app.encryptionKey);
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
      const body = request.body;
      // Upsert sul singleton (id=1): la migrazione seeda la riga, ma onConflict
      // la rende idempotente anche se mancasse. updatedAt va impostato a mano
      // nel `set`: il $onUpdate di drizzle NON scatta su onConflictDoUpdate.
      // numeric(12,6): drizzle scrive una STRINGA. number → stringa, null resta null.
      const monthlyBudgetUsd = body.monthlyBudgetUsd != null ? String(body.monthlyBudgetUsd) : null;

      // Campi S3 non-secret: presenti → aggiorna ("" azzera a null); assenti →
      // invariati. Raccolti in `set` solo se nel body, così onConflict non
      // sovrascrive ciò che il client non ha inviato.
      const s3Set: Record<string, string | null> = {};
      if (body.s3Endpoint !== undefined) s3Set.s3Endpoint = body.s3Endpoint === "" ? null : body.s3Endpoint;
      if (body.s3Region !== undefined) s3Set.s3Region = body.s3Region === "" ? null : body.s3Region;
      if (body.s3Bucket !== undefined) s3Set.s3Bucket = body.s3Bucket === "" ? null : body.s3Bucket;
      if (body.s3AccessKey !== undefined)
        s3Set.s3AccessKey = body.s3AccessKey === "" ? null : body.s3AccessKey;
      // Secret: assente → non toccare; "" esplicita → azzera (null, disabilita);
      // non vuota → cifra AES-256-GCM e salva. Mai esposta in lettura.
      if (body.s3SecretKey !== undefined) {
        s3Set.s3SecretKeyEncrypted =
          body.s3SecretKey === "" ? null : encrypt(body.s3SecretKey, app.encryptionKey);
      }
      // Segreti Slack: stessa semantica della secret S3. Assente → non toccare;
      // "" → azzera (null); non vuoto → cifra e salva. Mai esposti in lettura.
      if (body.slackSigningSecret !== undefined) {
        s3Set.slackSigningSecretEncrypted =
          body.slackSigningSecret === ""
            ? null
            : encrypt(body.slackSigningSecret, app.encryptionKey);
      }
      if (body.slackBotToken !== undefined) {
        s3Set.slackBotTokenEncrypted =
          body.slackBotToken === "" ? null : encrypt(body.slackBotToken, app.encryptionKey);
      }

      await app.db
        .insert(instanceSettings)
        .values({ id: 1, contentLanguage: body.contentLanguage, monthlyBudgetUsd, ...s3Set })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: {
            contentLanguage: body.contentLanguage,
            monthlyBudgetUsd,
            ...s3Set,
            updatedAt: new Date(),
          },
        });
      return loadInstanceSettings(app.db, app.encryptionKey);
    },
  );
}

export { automationSettingsSchema };
