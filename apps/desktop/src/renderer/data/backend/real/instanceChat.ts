import type * as Fake from "../../api";
import { chatAiBlock } from "./claudeChat";
import { partialNamespace } from "./notIntegrated";
import { liveModels } from "./aiModels";
import { liveProviders } from "./aiProviders";
import { liveAutomation } from "./automation";
import { liveWebhooks } from "./webhooks";

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
});
