import type * as Fake from "../../api";
import { chatAiBlock } from "./claudeChat";
import { partialNamespace } from "./notIntegrated";

/**
 * L'istanza nella build app: della sua area (9) c'è solo ciò che la chat con
 * Claude legge, il budget AI del mese (`getAiBlock(null)`). La pausa della
 * coda e tutto il resto restano «in arrivo».
 */
export const instance: typeof Fake.instance = partialNamespace<typeof Fake.instance>("instance", {
  getAiBlock: chatAiBlock,
});
