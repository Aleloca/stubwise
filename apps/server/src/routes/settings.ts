import { automationRuleSettingSchema, automationSettingsSchema, instanceSettingsViewSchema, prReviewSettingsSchema, updateAutomationSettingsSchema, updateInstanceSettingsSchema } from "@stubwise/shared";
import { legacySaveChangesUrl, loadLegacyWebhook, saveLegacyWebhook, testLegacyWebhook } from "../services/legacy-webhook.js";
import { sendRoleRuleError } from "./roles.js";
import { changedFields, recordChange, stableAmount } from "../services/change-log.js";
import { eq } from "drizzle-orm";
import {
  mailAdmissionPatchSchema,
  mailAdmissionSchema,
  readServerAnalysisLimits,
  serverAnalysisSettingsSchema,
  ticketTypeSchema,
  type TicketType,
} from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { automationRules, encrypt, instanceSettings } from "@stubwise/db";
import { s3ConfigFromSettings } from "../storage/index.js";
import { requireReauth } from "../auth/access.js";
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


// Automazione PR Review d'istanza (singleton instance_settings): se attiva, il
// worker recensisce le PR esterne dei progetti abilitati.



type AutomationRule = z.infer<typeof automationRuleSettingSchema>;

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
  notifyDocsLimitPaused: z.boolean(),
  notifyJobFailed: z.boolean(),
  notifyMonitor: z.boolean(),
  notifyAwaitingInput: z.boolean(),
  notifyPulse: z.boolean(),
  notifyBrief: z.boolean(),
  // ⚠️ NIENTE `notifyGoogleProposal` qui, di proposito (fase 6, Task 4 del
  // piano di fix di review): la proposta nata dalla posta/calendario ha
  // audience `mailbox_owner` e non deve MAI raggiungere il webhook
  // d'istanza — un canale condiviso — indipendentemente da un toggle. La
  // colonna `notify_google_proposal` resta in DB (innocua, sempre `true` di
  // default, nessuna migrazione), ma questo campo di rotta è stato rimosso
  // apposta: un toggle che sembrasse controllare "manda la posta di un
  // collega sul webhook di team" sarebbe fuorviante di per sé, anche se
  // inerte. Vedi `shouldSendWebhook` in `packages/notifications/src/dispatch.ts`.
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
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica le generazioni Docs in pausa per limite provider".
  notifyDocsLimitPaused: z.boolean().default(true),
  notifyJobFailed: z.boolean(),
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica gli alert di monitoraggio server (allarme/recovery)".
  notifyMonitor: z.boolean().default(true),
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica le domande dell'AI in attesa di risposta".
  notifyAwaitingInput: z.boolean().default(true),
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "notifica il pulse proattivo sui progetti fermi".
  notifyPulse: z.boolean().default(true),
  // Default true: i client esistenti che non inviano il campo conservano il
  // comportamento "annuncia il brief settimanale del progetto".
  notifyBrief: z.boolean().default(true),
  // ⚠️ NIENTE `notifyGoogleProposal` qui: vedi il commento gemello su
  // `notificationSettingsResponseSchema`. Un client che lo manda comunque
  // (SPA in cache, automazione) lo vede ignorato in silenzio — Zod scarta i
  // campi ignoti da un `z.object()` non `.strict()` — non rifiutato: stessa
  // tolleranza di ogni altro campo qui.
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


/**
 * Legge la riga singleton delle impostazioni d'istanza. La migrazione seeda
 * id=1 con default 'en', ma per robustezza (DB ripristinato senza seed) si
 * ripiega sul default dell'enum.
 */
async function loadInstanceSettings(
  db: Db,
  encryptionKey: Buffer,
): Promise<z.infer<typeof instanceSettingsViewSchema>> {
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
 * Configurazione d'istanza dell'AMMISSIONE della posta (fase 6c, singleton
 * instance_settings). Legge il default difensivo se la riga manca (DB
 * ripristinato senza seed), come `loadInstanceSettings`.
 */
async function loadMailAdmission(db: Db): Promise<Omit<z.infer<typeof mailAdmissionSchema>, "classifyV2">> {
  const [row] = await db
    .select({
      admitWorkspaceDomains: instanceSettings.emailAdmitWorkspaceDomains,
      denyLabels: instanceSettings.emailAdmissionDenyLabels,
      denyAutomated: instanceSettings.emailAdmissionDenyAutomated,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return {
    admitWorkspaceDomains: row?.admitWorkspaceDomains ?? true,
    denyLabels: row?.denyLabels ?? ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"],
    denyAutomated: row?.denyAutomated ?? true,
  };
}

/**
 * Route delle impostazioni, registrate sotto /api/settings. Per lo più solo
 * admin: l'automazione AI tocca quota e PR, è una scelta di amministrazione.
 *
 * Eccezione: `GET /mail-admission` è leggibile da OGNI utente autenticato,
 * come `GET /:projectId/email-routes` in `projects.ts` — l'ammissione
 * d'istanza e l'attribuzione per progetto condividono lo stesso perimetro di
 * lettura, e nascondere all'operatore la ragione per cui un messaggio non
 * arriva mai (perché non è ammesso, non perché nessuna regola combacia)
 * renderebbe la sezione "Posta" del progetto incomprensibile a chi non è
 * admin. La scrittura resta `settings.manage`, come per le regole di progetto.
 */
type InstanceRow = typeof instanceSettings.$inferSelect;

/**
 * Area 9, F3: le voci del registro di `PUT /instance`, coi valori stabili del
 * prototipo (`budget.ts`, `storage.ts`): l'importo come numero, il locale,
 * i soli campi dell'archiviazione che cambiano; il secret solo «sostituito».
 * (L'id della chiave d'accesso non è un segreto: è il nome dell'utente S3.)
 */
async function recordInstanceChanges(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], actor: { id: string; email: string }, before: InstanceRow | null, after: InstanceRow, secretTouched: boolean) {
  const ai = (id: string) => ({ type: "ai_settings", id, label: id });
  const storage = { type: "storage", id: "storage", label: "storage" };
  const budgetBefore = stableAmount(before?.monthlyBudgetUsd);
  const budgetAfter = stableAmount(after.monthlyBudgetUsd);
  if (budgetBefore !== budgetAfter) {
    await recordChange(tx, { type: "budget.changed", actor, projectId: null, data: { object: ai("budget"), before: budgetBefore, after: budgetAfter } });
  }
  if ((before?.contentLanguage ?? null) !== after.contentLanguage) {
    await recordChange(tx, { type: "content_language.changed", actor, projectId: null, data: { object: ai("content_language"), before: before?.contentLanguage ?? null, after: after.contentLanguage } });
  }
  const s3Fields = (row: InstanceRow | null) => ({ endpoint: row?.s3Endpoint ?? null, region: row?.s3Region ?? null, bucket: row?.s3Bucket ?? null, accessKeyId: row?.s3AccessKey ?? null });
  const diff = changedFields(s3Fields(before), s3Fields(after));
  if (diff) await recordChange(tx, { type: "storage.changed", actor, projectId: null, data: { object: storage, ...diff } });
  if (secretTouched) await recordChange(tx, { type: "storage.secret_replaced", actor, projectId: null, data: { object: storage } });
}

export async function settingsRoutes(instance: FastifyInstance, opts: { mailClassifyV2?: boolean } = {}): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/automation",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
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
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: {
        body: updateAutomationSettingsSchema,
        response: { 200: automationSettingsSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => {
      // Upsert di ciascuna regola sul tipo (PK). In transazione: o passano
      // tutte o nessuna, così la lettura successiva è sempre coerente.
      await app.db.transaction(async (tx) => {
        const rulesBefore = await loadAllRules(tx as unknown as Db);
        const reviewBefore = await loadPrReviewSettings(tx as unknown as Db);
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
        // Area 9, F3: come il prototipo (`automation.ts`), le SOLE righe
        // cambiate e la review solo se cambia, in JSON di valori stabili.
        const rulesAfter = await loadAllRules(tx as unknown as Db);
        const reviewAfter = await loadPrReviewSettings(tx as unknown as Db);
        const value = (r: AutomationRule) => ({ taskType: r.type, autoFix: r.autoFix, maxEffort: r.maxEffort, planApprovalMinEffort: r.planApprovalMinEffort, maxCostUsd: r.maxCostUsd });
        const changed = rulesAfter.filter((r) => JSON.stringify(value(r)) !== JSON.stringify(value(rulesBefore.find((b) => b.type === r.type)!)));
        const reviewChanged = JSON.stringify(reviewBefore) !== JSON.stringify(reviewAfter);
        if (changed.length > 0 || reviewChanged) {
          const encode = (rules: AutomationRule[], review: typeof reviewAfter) => JSON.stringify({ rules: rules.map(value), prReview: reviewChanged ? review : null });
          await recordChange(tx, {
            type: "automation.changed",
            actor: request.user!,
            projectId: null,
            data: {
              object: { type: "ai_settings", id: "automation", label: "automation" },
              before: encode(changed.map((r) => rulesBefore.find((b) => b.type === r.type)!), reviewBefore),
              after: encode(changed, reviewAfter),
            },
          });
        }
      });
      return { rules: await loadAllRules(app.db), prReview: await loadPrReviewSettings(app.db) };
    },
  );

  // Area 8, F4b, S11: i tetti dell'analisi dei server (F4b-2 = b). Il worker
  // li rilegge a ogni analisi; senza riga (o con una corrotta) i default.
  app.get(
    "/server-analysis",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: { response: { 200: serverAnalysisSettingsSchema, ...authErrorResponses } },
    },
    async () => readServerAnalysisLimits((await app.db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)))[0]?.serverAnalysisLimits),
  );

  app.put(
    "/server-analysis",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: { body: serverAnalysisSettingsSchema, response: { 200: serverAnalysisSettingsSchema, 400: errorSchema, ...authErrorResponses } },
    },
    async (request) => {
      const limits = request.body;
      await app.db.transaction(async (tx) => {
        const [row] = await tx.select({ limits: instanceSettings.serverAnalysisLimits }).from(instanceSettings).where(eq(instanceSettings.id, 1)).for("update");
        await tx
          .insert(instanceSettings)
          .values({ id: 1, serverAnalysisLimits: limits })
          .onConflictDoUpdate({ target: instanceSettings.id, set: { serverAnalysisLimits: limits, updatedAt: new Date() } });
        // Area 9, F3: le chiavi del prototipo (`serverAnalysis.ts`): l'interruttore
        // come booleano, i numeri come testo, i soli campi che cambiano.
        const fields = (l: z.infer<typeof serverAnalysisSettingsSchema>) => ({
          analysisEnabled: l.enabled,
          maxMinutes: String(l.maxMinutes),
          maxCostUsd: String(l.maxCostUsd),
          maxAgentReads: String(l.maxAgentReads),
          maxSshReads: String(l.maxSshReads),
        });
        const diff = changedFields(fields(readServerAnalysisLimits(row?.limits)), fields(limits));
        if (diff) {
          await recordChange(tx, { type: "server_analysis.changed", actor: request.user!, projectId: null, data: { object: { type: "ai_settings", id: "server_analysis", label: "server_analysis" }, ...diff } });
        }
      });
      return limits;
    },
  );

  app.get(
    "/notifications",
    {
      config: { access: { kind: "instance", permission: "integrations.manage" } },
      schema: {
        response: { 200: notificationSettingsResponseSchema, ...authErrorResponses },
      },
    },
    // Area 9, F3 (H-4): sul webhook più vecchio (`services/legacy-webhook.ts`).
    async () => loadLegacyWebhook(app.db),
  );

  app.put(
    "/notifications",
    {
      config: { access: { kind: "instance", permission: "integrations.manage" }, partialReauth: true },
      schema: {
        body: updateNotificationsBodySchema,
        response: {
          200: notificationSettingsResponseSchema,
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      // Area 9, F3 (H-4): sul webhook più vecchio, con le regole di
      // `services/legacy-webhook.ts` (un URL vuoto spegne, non elimina).
      // Un URL nuovo chiede la riconferma, come sulla rotta nuova.
      if ((await legacySaveChangesUrl(app.db, request.body.webhookUrl)) && !(await requireReauth(request, reply))) return reply;
      try {
        return await saveLegacyWebhook(app.db, request.user!, request.body);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.post(
    "/notifications/test",
    {
      config: { access: { kind: "instance", permission: "integrations.manage" } },
      schema: {
        response: { 200: testNotificationResponseSchema, ...authErrorResponses },
      },
    },
    async () => {
      // La prova fa emergere l'esito (a differenza del dispatch best-effort):
      // l'admin deve sapere se il webhook è corretto. Usa il format salvato e
      // un evento ticket.created fittizio con link a ${publicUrl}/tickets/test.
      // Area 9, F3 (H-4): la prova del webhook più vecchio, col suo formato e la sua firma.
      return testLegacyWebhook(app.db, app.encryptionKey, app.publicUrl);
    },
  );

  app.get(
    "/instance",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: {
        response: { 200: instanceSettingsViewSchema, ...authErrorResponses },
      },
    },
    async () => {
      return loadInstanceSettings(app.db, app.encryptionKey);
    },
  );

  app.put(
    "/instance",
    {
      config: { access: { kind: "instance", permission: "settings.manage" }, partialReauth: true },
      schema: {
        body: updateInstanceSettingsSchema,
        response: {
          200: instanceSettingsViewSchema,
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      // Area 9, F3 (D-5): la riconferma solo quando il corpo porta un segreto
      // (sostituito o azzerato), con la regola del gate (`requireReauth`).
      const touchesSecret = [body.s3SecretKey, body.slackSigningSecret, body.slackBotToken].some((v) => v !== undefined);
      if (touchesSecret && !(await requireReauth(request, reply))) return reply;
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

      await app.db.transaction(async (tx) => {
        const [before] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).for("update");
        const [after] = await tx
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
          })
          .returning();
        await recordInstanceChanges(tx, request.user!, before ?? null, after!, body.s3SecretKey !== undefined);
      });
      return loadInstanceSettings(app.db, app.encryptionKey);
    },
  );

  app.get(
    "/mail-admission",
    {
      // Vedi il commento sul docblock di settingsRoutes: unica GET del file
      // aperta a tutti gli autenticati, non solo agli admin.
      config: { access: { kind: "instance", permission: "mail_admission.view" } },
      schema: {
        response: { 200: mailAdmissionSchema, ...authErrorResponses },
      },
    },
    async () => {
      return { ...(await loadMailAdmission(app.db)), classifyV2: opts.mailClassifyV2 ?? false };
    },
  );

  app.patch(
    "/mail-admission",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: {
        body: mailAdmissionPatchSchema,
        response: {
          200: mailAdmissionSchema,
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const body = request.body;
      // Semantica PATCH: campo assente → colonna invariata. Raccolto in `set`
      // solo se presente nel body, come i campi S3 non-secret sopra — nessuna
      // di queste tre colonne è nullable, quindi "invariato" va costruito
      // così e non con `?? undefined`.
      const set: {
        emailAdmitWorkspaceDomains?: boolean;
        emailAdmissionDenyLabels?: string[];
        emailAdmissionDenyAutomated?: boolean;
      } = {};
      if (body.admitWorkspaceDomains !== undefined) {
        set.emailAdmitWorkspaceDomains = body.admitWorkspaceDomains;
      }
      if (body.denyLabels !== undefined) {
        set.emailAdmissionDenyLabels = body.denyLabels;
      }
      if (body.denyAutomated !== undefined) {
        set.emailAdmissionDenyAutomated = body.denyAutomated;
      }

      // Upsert sul singleton (id=1): la migrazione non seeda righe nuove (solo
      // colonne con default su una riga che già esiste), ma onConflict rende
      // la rotta robusta anche su un DB ripristinato senza la riga id=1.
      await app.db
        .insert(instanceSettings)
        .values({
          id: 1,
          emailAdmitWorkspaceDomains: set.emailAdmitWorkspaceDomains ?? true,
          emailAdmissionDenyLabels:
            set.emailAdmissionDenyLabels ?? ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "SPAM"],
          emailAdmissionDenyAutomated: set.emailAdmissionDenyAutomated ?? true,
        })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: { ...set, updatedAt: new Date() },
        });
      return { ...(await loadMailAdmission(app.db)), classifyV2: opts.mailClassifyV2 ?? false };
    },
  );
}

export { automationSettingsSchema };
