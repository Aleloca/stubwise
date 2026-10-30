// L'istanza (area 9b) come la espone `api.ts`: `api.instance.<funzione>`.
// I Task 2–7 ci aggiungono le loro funzioni (consumi, AI, integrazioni,
// coda e Stato dell'istanza, repository). `changeTypes.ts` si importa per
// il suo effetto: registra i tipi di voce del registro prima della prima
// scrittura. Lo stato (`state.ts`) e il seme (`seed.ts`) non si esportano:
// li legge solo il livello dati.
import "./changeTypes";

export {
  getUsage,
  recordUsage,
  spentThisMonthUsd,
  type UsageDimension,
  type UsageRange,
  type UsageRow,
  type UsageView,
} from "./usage";
export {
  BACKGROUND_WEEKLY_THRESHOLD,
  QUOTA_NEAR_PCT,
  createProvider,
  deleteProvider,
  listProviders,
  moveProvider,
  pickProvider,
  replaceProviderCredential,
  setProviderEnabled,
  simulateNextTest,
  testProvider,
  type ProviderView,
  type QuotaView,
} from "./providers";
export {
  DEFAULT_MODELS,
  OPERATION_OF_KIND,
  listModels,
  modelFor,
  modelIdFor,
  setModel,
  type ModelRow,
  type ModelSource,
} from "./models";
export { getAutomation, saveAutomation, type AutomationSettings } from "./automation";
export {
  budgetReached,
  getBudget,
  saveBudget,
  simulateBudgetReached,
  type BudgetSaveEffect,
  type BudgetView,
  type ContentLanguage,
} from "./budget";
export {
  createGitAccount,
  deleteGitAccount,
  listGitAccounts,
  replaceGitToken,
  setDefaultReviewer,
  updateGitAccount,
  validateGitAccount,
  type GitAccountView,
} from "./git";
export {
  PLUGIN_STEP_MS,
  getNextPluginOutcome,
  getPlugin,
  listPlugins,
  registerPlugin,
  removePlugin,
  rerunSmoke,
  simulateNextPluginOutcome,
  updatePluginRef,
  type PluginView,
} from "./plugins";
export {
  createGoogleApp,
  deleteGoogleApp,
  listGoogleApps,
  replaceGoogleSecret,
  updateGoogleApp,
  type GoogleAppView,
} from "./google";
export {
  getStorage,
  saveStorage,
  setAttachments,
  storageAllowsUploads,
  testStorage,
  type StorageStatus,
  type StorageView,
} from "./storage";
export {
  WEBHOOK_EVENTS,
  getWebhook,
  previewWebhook,
  saveWebhook,
  testWebhook,
  type WebhookEventId,
  type WebhookFormat,
  type WebhookGroup,
  type WebhookView,
} from "./webhook";
export { getAiBlock, getQueuePause, getUploadsAllowed } from "./blocks";
export {
  aiBlockFor,
  dropHeld,
  holdJob,
  pauseQueue,
  queuePauseOf,
  releaseBudgetHolds,
  resumeQueue,
  type AiBlock,
  type HeldJob,
  type JobKind,
} from "./queue";
export {
  getInstanceStatus,
  type InstanceJob,
  type InstanceNightlyRow,
  type InstanceStatusView,
} from "./status";
export { retryJob } from "./retry";
export {
  listAllRepositories,
  type InstanceRepositoryGroup,
  type InstanceRepositoryRow,
} from "./repositories";
export type { InstanceRefusal, InstanceResult } from "./types";
export type {
  AiProvider,
  AutomationRule,
  GitAccount,
  NightlyRow,
  OutgoingWebhook,
  QueuePause,
  RegisteredPlugin,
  StorageSettings,
  TestOutcome,
  UsageRecord,
} from "./state";
