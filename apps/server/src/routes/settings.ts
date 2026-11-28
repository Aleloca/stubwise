import { automationSettingsSchema, instanceSettingsViewSchema, updateAutomationSettingsSchema, updateInstanceSettingsSchema } from "@stubwise/shared";
import { changedFields, recordChange } from "../services/change-log.js";
import { eq } from "drizzle-orm";
import {
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
/**
 * Cambiano l'endpoint o il bucket dello storage rispetto a quelli salvati?
 * Lo stesso confronto di `reauthOf` (`claude-actions/catalog.ts`): un campo
 * assente non cambia, gli spazi intorno non contano.
 */
async function storageTargetChanges(db: Db, body: { s3Endpoint?: string | null; s3Bucket?: string | null }): Promise<boolean> {
  const [row] = await db.select({ endpoint: instanceSettings.s3Endpoint, bucket: instanceSettings.s3Bucket }).from(instanceSettings).limit(1);
  const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const changes = (next: string | null | undefined, saved: string | null | undefined) => next !== undefined && norm(next) !== norm(saved);
  return changes(body.s3Endpoint, row?.endpoint) || changes(body.s3Bucket, row?.bucket);
}

export async function settingsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/automation",
    {
      config: { mcp: { action: "settings.automation", summary: "Le regole d'istanza delle automazioni e della review delle PR.", effect: "read" }, access: { kind: "instance", permission: "settings.manage" } },
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
      config: { mcp: { action: "settings.updateAutomation", summary: "Modifica le regole d'istanza delle automazioni e della review delle PR.", effect: "write", note: "Vale per tutta l'istanza, non solo per chi la cambia." }, access: { kind: "instance", permission: "settings.manage" } },
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
      config: { mcp: { action: "settings.serverAnalysis", summary: "I limiti dell'analisi AI dei server (acceso, minuti, costo, letture).", effect: "read" }, access: { kind: "instance", permission: "settings.manage" } },
      schema: { response: { 200: serverAnalysisSettingsSchema, ...authErrorResponses } },
    },
    async () => readServerAnalysisLimits((await app.db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)))[0]?.serverAnalysisLimits),
  );

  app.put(
    "/server-analysis",
    {
      config: { mcp: { action: "settings.updateServerAnalysis", summary: "Modifica i limiti dell'analisi AI dei server (acceso, minuti, costo, letture).", effect: "write", note: "Vale per tutta l'istanza, non solo per chi la cambia." }, access: { kind: "instance", permission: "settings.manage" } },
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
    "/instance",
    {
      config: { mcp: { action: "settings.instance", summary: "Le impostazioni dell'istanza (lingua dei contenuti, budget mensile, storage S3), senza segreti.", effect: "read" }, access: { kind: "instance", permission: "settings.manage" } },
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
      config: { mcp: { action: "settings.updateInstance", summary: "Modifica le impostazioni dell'istanza: lingua dei contenuti, budget mensile, storage S3.", effect: "write", note: "Un segreto nuovo (chiave S3) e un cambio di endpoint o bucket dello storage (decidono dove vanno gli allegati di tutti) chiedono la riconferma: da qui session_required. Vale per tutta l'istanza, non solo per chi la cambia." }, access: { kind: "instance", permission: "settings.manage" }, partialReauth: true },
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
      // Area 9, F3 (D-5): la riconferma quando il corpo porta un segreto
      // (sostituito o azzerato), con la regola del gate (`requireReauth`).
      // Dal 26 nov 2026 (decisione del maintainer) anche quando CAMBIANO
      // l'endpoint o il bucket dello storage, per qualunque chiamante: decidono
      // DOVE vanno e da dove si servono gli allegati di tutti, col segreto
      // salvato che resta in uso (è la regola che il lotto 10 aveva dato
      // all'azione di Claude `saveStorage`, `reauthOf`). Lo stesso valore,
      // spazi a parte, non è un cambio.
      const touchesSecret = [body.s3SecretKey].some((v) => v !== undefined);
      const movesStorage = body.s3Endpoint !== undefined || body.s3Bucket !== undefined ? await storageTargetChanges(app.db, body) : false;
      if ((touchesSecret || movesStorage) && !(await requireReauth(request, reply))) return reply;
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
      config: { mcp: { action: "settings.setAttachments", summary: "Accende o spegne gli allegati per tutta l'istanza.", effect: "write", note: "Vale per tutta l'istanza, non solo per chi la cambia." }, access: { kind: "instance", permission: "settings.manage" } },
      schema: { body: z.object({ on: z.boolean() }), response: { 200: instanceSettingsViewSchema, 422: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const out = await setAttachments(app.db, app.encryptionKey, request.user!, request.body.on);
      if (!out.ok) return apiError(reply, 422, "not_set_up", "Set up the storage before turning attachments on");
      return loadInstanceSettings(app.db, app.encryptionKey);
    },
  );
}

export { automationSettingsSchema };
