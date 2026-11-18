import { z } from "zod";
import { aiProviderKindSchema } from "./schemas/ai-job.js";
import { gitAccountSchema } from "./schemas/project.js";
import { gitProviderKindSchema } from "./schemas/base-enums.js";
import { languageSchema } from "./schemas/language.js";
import { effortSchema, ticketTypeSchema } from "./schemas/ticket.js";
import { pluginRecommendationsSchema, pluginSchema } from "./schemas/plugin.js";

/**
 * Area 9, F3, Task 8b: le forme delle pagine d'istanza della 9b (provider AI,
 * account git, plugin, archiviazione) che prima stavano solo nelle rotte del
 * server: qui perché le legge anche il client. Un segreto non è MAI in una
 * risposta: solo i flag (`secretSet`, `s3SecretKeySet`…).
 */

// --- Provider AI (`/api/ai-providers`) ---

export const aiProviderTestStatusSchema = z.enum(["idle", "pending", "passed", "failed"]);

export const aiProviderViewSchema = z.object({
  id: z.uuid(),
  kind: aiProviderKindSchema,
  label: z.string(),
  position: z.int(),
  enabled: z.boolean(),
  secretSet: z.literal(true),
  createdAt: z.string(),
  // Esito dell'ultimo test della credenziale (lo fa il worker). `testError` è il
  // messaggio dell'ultimo fallimento (mai il segreto); le date sono ISO.
  testStatus: aiProviderTestStatusSchema,
  testRequestedAt: z.string().nullable().default(null),
  testCheckedAt: z.string().nullable().default(null),
  testError: z.string().nullable().default(null),
});
export type AiProviderView = z.infer<typeof aiProviderViewSchema>;

export const createAiProviderSchema = z.object({
  kind: aiProviderKindSchema,
  label: z.string().min(1).max(100),
  // La secret in chiaro: cifrata prima di toccare il DB, non torna mai indietro.
  secret: z.string().min(1),
  // Posizione di failover esplicita; assente = in coda.
  position: z.int().optional(),
});
export type CreateAiProviderInput = z.infer<typeof createAiProviderSchema>;

/** Una patch; `secret` presente = sostituita (chiede la riconferma). */
export const updateAiProviderSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  secret: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  position: z.int().optional(),
});
export type UpdateAiProviderInput = z.infer<typeof updateAiProviderSchema>;

// --- Account git (`/api/git-accounts`) ---

/** Le credenziali: un token (GitHub) o username/email + API token (Bitbucket). Mai in una risposta. */
export const gitCredentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

export const createGitAccountSchema = z.object({
  name: z.string().min(1).max(200),
  provider: gitProviderKindSchema,
  credentials: gitCredentialsSchema,
  workspace: z.string().min(1).max(200).optional(),
});
export type CreateGitAccountInput = z.infer<typeof createGitAccountSchema>;

/** Una patch; `credentials` presenti = token sostituito (chiede la riconferma). */
export const updateGitAccountSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  credentials: gitCredentialsSchema.optional(),
  workspace: z.string().min(1).max(200).optional(),
});
export type UpdateGitAccountInput = z.infer<typeof updateGitAccountSchema>;

export const gitCredentialCheckSchema = z.object({ name: z.string(), ok: z.boolean(), detail: z.string() });
/** La validazione: `ok` riassume i singoli check. */
export const gitValidateResponseSchema = z.object({ ok: z.boolean(), checks: z.array(gitCredentialCheckSchema) });

export const defaultReviewerWarningSchema = z.object({ repositoryId: z.uuid(), repositoryName: z.string(), code: z.string() });
export const defaultReviewerResponseSchema = z.object({
  account: gitAccountSchema,
  /** Il predefinito precedente dello stesso ambito, tolto nella stessa transazione; null = nessuno. */
  replaced: z.object({ id: z.uuid(), name: z.string() }).nullable().default(null),
  warnings: z.array(defaultReviewerWarningSchema).default([]),
});
export type DefaultReviewerResponse = z.infer<typeof defaultReviewerResponseSchema>;

// --- Plugin (`/api/plugins`) ---

export const pluginRegistrySchema = z.object({
  plugins: z.array(pluginSchema),
  /** Raccomandazioni per plugin noti, per `inventory.name`. */
  recommendations: pluginRecommendationsSchema.default({}),
});
export type PluginRegistry = z.infer<typeof pluginRegistrySchema>;

// --- Impostazioni d'istanza: lingua, budget, archiviazione (`/api/settings/instance`) ---

export const instanceSettingsViewSchema = z.object({
  contentLanguage: languageSchema,
  /** Tetto di spesa mensile (USD); null = nessuno. */
  monthlyBudgetUsd: z.number().nonnegative().nullable(),
  // L'archiviazione S3: i campi non segreti in chiaro; il secret MAI, solo il flag.
  s3Endpoint: z.string().nullable().default(null),
  s3Region: z.string().nullable().default(null),
  s3Bucket: z.string().nullable().default(null),
  s3AccessKey: z.string().nullable().default(null),
  s3SecretKeySet: z.boolean().default(false),
  attachmentsEnabled: z.boolean().default(false),
  // Slack: solo i flag (il web vecchio; fuori dall'app nuova).
  slackSigningSecretSet: z.boolean().default(false),
  slackBotTokenSet: z.boolean().default(false),
  slackEnabled: z.boolean().default(false),
});
export type InstanceSettingsView = z.infer<typeof instanceSettingsViewSchema>;

/**
 * Il corpo del `PUT`: `contentLanguage` obbligatorio; i campi S3 presenti
 * aggiornano ("" azzera), assenti restano; `s3SecretKey` presente sostituisce
 * o azzera il secret (chiede la riconferma).
 */
export const updateInstanceSettingsSchema = z.object({
  contentLanguage: languageSchema,
  monthlyBudgetUsd: z.number().nonnegative().nullable().default(null),
  s3Endpoint: z.string().optional(),
  s3Region: z.string().optional(),
  s3Bucket: z.string().optional(),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
  slackSigningSecret: z.string().optional(),
  slackBotToken: z.string().optional(),
});
export type UpdateInstanceSettingsInput = z.input<typeof updateInstanceSettingsSchema>;

// --- Automazione d'istanza (`/api/settings/automation`) ---

export const automationRuleSettingSchema = z.object({
  type: ticketTypeSchema,
  autoFix: z.boolean(),
  maxEffort: effortSchema,
  /** Effort dal quale il piano chiede l'approvazione; null = mai. */
  planApprovalMinEffort: effortSchema.nullable().default(null),
  /** Tetto di costo per ticket (USD); null = nessuno. */
  maxCostUsd: z.number().nonnegative().nullable().default(null),
});

export const prReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  maxCostUsd: z.number().nonnegative().nullable().default(null),
});

export const automationSettingsSchema = z.object({
  rules: z.array(automationRuleSettingSchema),
  prReview: prReviewSettingsSchema,
});
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;

export const updateAutomationSettingsSchema = z.object({
  rules: z.array(automationRuleSettingSchema).min(1),
  prReview: prReviewSettingsSchema,
});
export type UpdateAutomationSettingsInput = z.input<typeof updateAutomationSettingsSchema>;
