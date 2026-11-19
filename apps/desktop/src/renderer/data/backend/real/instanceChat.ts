import type * as Fake from "../../api";
import { chatAiBlock } from "./claudeChat";
import { partialNamespace } from "./notIntegrated";
import { liveModels } from "./aiModels";
import { liveGitAccounts } from "./gitAccounts";
import { liveGoogleApps } from "./googleApps";
import { liveInstanceStatus } from "./instanceStatus";
import { livePlugins } from "./plugins";
import { liveStorage } from "./storage";
import { liveUsage } from "./usage";
import { liveProviders } from "./aiProviders";
import { liveAutomation } from "./automation";
import { liveBudget } from "./budget";
import { liveWebhooks } from "./webhooks";
import { liveInstanceRepositories } from "./instanceRepositories";

/**
 * L'istanza nella build app: il budget AI del mese che la chat con Claude
 * legge (`getAiBlock(null)`) e, dall'area 9 F3, Outgoing webhooks sulle rotte
 * del server. La pausa della coda e il resto della 9b restano «in arrivo».
 */
export const instance: typeof Fake.instance = partialNamespace<typeof Fake.instance>("instance", {
  getAiBlock: chatAiBlock,
  ...liveWebhooks,
  // Area 9, F3: AI → Automation.
  ...liveAutomation,
  // Area 9, F3: AI → Providers (8c di 72).
  ...liveProviders,
  // Area 9, F3: AI → Models.
  ...liveModels,
  // Area 9, F3: Google Workspace.
  ...liveGoogleApps,
  // Area 9, F3: Git accounts.
  ...liveGitAccounts,
  // Area 9, F3: Plugins.
  ...livePlugins,
  // Area 9, F3: Storage.
  ...liveStorage,
  // Area 9, F4: AI → Budget & language.
  ...liveBudget,
  // Area 9, F4: lo Stato dell'istanza (la voce si accende con pausa e rilancio).
  ...liveInstanceStatus,
  // Area 9, F4: AI → Usage.
  ...liveUsage,
  // Area 9, F6: Repositories (collegati, staccati, collega, elimina).
  ...liveInstanceRepositories,
});
