import { automationRuleSettingSchema, secretLast4, automationSettingsSchema, prReviewSettingsSchema, ticketTypeSchema, updateAutomationSettingsSchema, updateInstanceSettingsSchema, type TicketType } from "@stubwise/shared";
import { automationRules, automationRuns, encrypt, instanceSettings, type Db } from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { changedFields, recordChange, stableAmount } from "./change-log.js";

/**
 * Area 9, F7 (fix della regressione dell'integrazione): le scritture delle
 * impostazioni d'istanza (`PUT /api/settings/automation`, `PUT
 * /api/settings/instance`), che chiamano anche le azioni di Claude
 * (`saveAutomation`, `saveBudget`). Stanno in un servizio e non nella rotta:
 * la rotta importa lo storage (S3), e il catalogo di Claude non deve poter
 * raggiungere niente che esca da solo (`claude-actions-effects.test.ts`).
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
 * Restituisce le regole per TUTTI i tipi di ticket (i 5 di ticketTypeSchema),
 * riempiendo con il default quelle eventualmente assenti nel DB: la UI mostra
 * sempre una riga coerente per ogni tipo.
 */
export async function loadAllRules(db: Db): Promise<AutomationRule[]> {
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
export async function loadPrReviewSettings(db: Db): Promise<z.infer<typeof prReviewSettingsSchema>> {
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

/**
 * Il `PUT /api/settings/automation` (area 9, F7: estratto dalla rotta, lo
 * chiama anche `saveAutomation` di Claude). Upsert di ciascuna regola sul
 * tipo (PK), in transazione: o passano tutte o nessuna.
 */
export async function putAutomationSettings(db: Db, actor: { id: string; email: string }, body: z.infer<typeof updateAutomationSettingsSchema>): Promise<void> {
  await db.transaction(async (tx) => {
    const rulesBefore = await loadAllRules(tx as unknown as Db);
    const reviewBefore = await loadPrReviewSettings(tx as unknown as Db);
    for (const rule of body.rules) {
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
    const maxCost = body.prReview.maxCostUsd;
    await tx
      .insert(instanceSettings)
      .values({
        id: 1,
        prReviewEnabled: body.prReview.enabled,
        prReviewMaxCostUsd: maxCost != null ? String(maxCost) : null,
      })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: {
          prReviewEnabled: body.prReview.enabled,
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
        actor: actor,
        projectId: null,
        data: {
          object: { type: "ai_settings", id: "automation", label: "automation" },
          before: encode(changed.map((r) => rulesBefore.find((b) => b.type === r.type)!), reviewBefore),
          after: encode(changed, reviewAfter),
        },
      });
    }
  });
}

/** Le automazioni d'istanza come le legge la pagina (e l'inverso di `saveAutomation`). */
export async function readAutomationSettings(db: Db): Promise<z.infer<typeof automationSettingsSchema>> {
  return { rules: await loadAllRules(db), prReview: await loadPrReviewSettings(db) };
}

/**
 * Il `PUT /api/settings/instance` (area 9, F7: estratto dalla rotta, lo
 * chiama anche `saveBudget` di Claude, che non porta mai
 * un segreto: per loro `encryptionKey` è null, e un segreto qui lancerebbe).
 * La riconferma per un segreto la chiede la ROTTA, prima.
 */
export async function putInstanceSettings(
  db: Db,
  encryptionKey: Buffer | null,
  actor: { id: string; email: string },
  body: z.infer<typeof updateInstanceSettingsSchema>,
): Promise<{ reachedBefore: boolean }> {
  const key = (): Buffer => {
    if (!encryptionKey) throw new Error("putInstanceSettings: un segreto senza chiave di cifratura");
    return encryptionKey;
  };
  // Upsert sul singleton (id=1): la migrazione seeda la riga, ma onConflict
  // la rende idempotente anche se mancasse. updatedAt va impostato a mano
  // nel `set`: il $onUpdate di drizzle NON scatta su onConflictDoUpdate.
  // numeric(12,6): drizzle scrive una STRINGA. number → stringa, null resta null.
  // Una PATCH (review di F3, critico): budget e lingua ASSENTI restano;
  // `monthlyBudgetUsd: null` esplicito toglie il tetto.
  const base: Record<string, string | null> = {};
  if (body.contentLanguage !== undefined) base.contentLanguage = body.contentLanguage;
  if (body.monthlyBudgetUsd !== undefined) base.monthlyBudgetUsd = body.monthlyBudgetUsd !== null ? String(body.monthlyBudgetUsd) : null;

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
      body.s3SecretKey === "" ? null : encrypt(body.s3SecretKey, key());
    // Le ultime 4, con la chiave (0225, rimandi lotto 5).
    s3Set.s3SecretKeyLast4 = body.s3SecretKey === "" ? null : secretLast4(body.s3SecretKey);
  }

  const reachedBefore = (await aiBudgetState(db)).exhausted;
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).for("update");
    const [after] = await tx
      .insert(instanceSettings)
      .values({ id: 1, ...base, ...s3Set })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: {
          ...base,
          ...s3Set,
          updatedAt: new Date(),
        },
      })
      .returning();
    await recordInstanceChanges(tx, actor, before ?? null, after!, body.s3SecretKey !== undefined);
    // Area 9, F4 (invariante 5): il budget torna disponibile per questo
    // salvataggio → i passi delle automazioni fermi per il budget ripartono
    // SUBITO, nella stessa transazione (il mese nuovo li trova al giro dei
    // 15′). Il `budget_held` dei job delle task resta com'è.
    if (reachedBefore && !(await aiBudgetState(tx as unknown as Db)).exhausted) {
      await tx
        .update(automationRuns)
        .set({ dueAt: sql`now()` })
        .where(and(eq(automationRuns.status, "running"), sql`${automationRuns.cursor} -> 'aiWaiting' ->> 'reason' = 'monthly_budget'`));
    }
  });
  return { reachedBefore };
}
