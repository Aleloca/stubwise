import { automationSettingsSchema, instanceSettingsViewSchema, updateAutomationSettingsSchema, updateInstanceSettingsSchema } from "@stubwise/shared";
import { legacySaveChangesUrl, loadLegacyWebhook, saveLegacyWebhook, testLegacyWebhook } from "../services/legacy-webhook.js";
import { sendRoleRuleError } from "./roles.js";
import { changedFields, recordChange } from "../services/change-log.js";
import { eq } from "drizzle-orm";
import {
  mailAdmissionPatchSchema,
  mailAdmissionSchema,
  readServerAnalysisLimits,
  serverAnalysisSettingsSchema,
} from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { instanceSettings, monthlyCostUsd } from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import { s3ConfigFromSettings } from "../storage/index.js";
import { setAttachments } from "../services/attachments-switch.js";
import { apiError } from "../errors.js";
import { requireReauth } from "../auth/access.js";
import { loadAllRules, loadPrReviewSettings, putAutomationSettings, putInstanceSettings } from "../services/instance-settings-writes.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Impostazioni di automazione AI per tipo di ticket. L'admin decide, in
 * Settings, se l'auto-fix è attivo per un tipo e fino a quale sforzo
 * (max_effort): il triage avvia il fix automaticamente solo se auto_fix è
 * true E l'effort stimato è <= max_effort. Le righe sono seedate dalla
 * migrazione per tutti i tipi; questo modulo le legge/aggiorna e fa
 * comunque fallback a un default se una riga mancasse.
 */


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
 * Lo storage è configurato E valido (gli allegati si possono caricare). La
 * stessa regola di `attachmentsEnabled` e di `GET /api/storage/uploads`.
 * `s3ConfigFromSettings` può LANCIARE se la secret cifrata è corrotta o la
 * chiave è errata: l'eccezione vale «non configurato/non valido» → false.
 */
export function storageConfigured(row: typeof instanceSettings.$inferSelect | undefined, encryptionKey: Buffer): boolean {
  if (!row) return false;
  try {
    return s3ConfigFromSettings(row, encryptionKey) !== null;
  } catch {
    return false;
  }
}

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
  // attachmentsEnabled = config S3 completa E valida (`storageConfigured`) E interruttore acceso (lotto 6).
  const attachmentsSwitch = row?.attachmentsSwitch ?? true;
  const attachmentsEnabled = attachmentsSwitch && storageConfigured(row, encryptionKey);
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
    s3SecretKeyLast4: row?.s3SecretKeyEncrypted != null ? (row.s3SecretKeyLast4 ?? null) : null,
    attachmentsEnabled,
    attachmentsSwitch,
    // Mai i segreti Slack: solo se c'è un blob cifrato salvato. slackEnabled =
    // entrambi presenti (integrazione completa).
    slackSigningSecretSet: row?.slackSigningSecretEncrypted != null,
    slackBotTokenSet: row?.slackBotTokenEncrypted != null,
    slackEnabled: row?.slackSigningSecretEncrypted != null && row?.slackBotTokenEncrypted != null,
    // Il budget con la regola del worker (`aiBudgetState`): una sola definizione di «raggiunto».
    spentUsd: await monthlyCostUsd(db),
    budgetReached: (await aiBudgetState(db)).exhausted,
    budgetEffect: null,
  };
}

/** Cosa ha fatto un salvataggio al budget (94: la frase dopo «Save»). */
function budgetEffectOf(before: boolean, after: boolean): "released" | "now_reached" | "still_reached" | null {
  if (before && !after) return "released";
  if (!before && after) return "now_reached";
  return before && after ? "still_reached" : null;
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
      // Area 9, F7: la funzione, la stessa dell'azione di Claude `saveAutomation`.
      await putAutomationSettings(app.db, request.user!, request.body);
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
      // Area 9, F7: la funzione, la stessa delle azioni di Claude (`saveBudget`).
      const { reachedBefore } = await putInstanceSettings(app.db, app.encryptionKey, request.user!, body);
      const view = await loadInstanceSettings(app.db, app.encryptionKey);
      return { ...view, budgetEffect: budgetEffectOf(reachedBefore, view.budgetReached) };
    },
  );

  // Lotto 6, voce 2: l'interruttore degli allegati (`settings.manage`, senza riconferma, come il prototipo).
  app.put(
    "/instance/attachments",
    {
      config: { access: { kind: "instance", permission: "settings.manage" } },
      schema: { body: z.object({ on: z.boolean() }), response: { 200: instanceSettingsViewSchema, 422: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const out = await setAttachments(app.db, app.encryptionKey, request.user!, request.body.on);
      if (!out.ok) return apiError(reply, 422, "not_set_up", "Set up the storage before turning attachments on");
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
