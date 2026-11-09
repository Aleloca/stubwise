// Il seme delle Automations (area 7): sorgenti, tabella cliente → progetto,
// automazioni ed esecuzioni.
import {
  AUTOMATION_CLIENT_DATA,
  AUTOMATION_DRAFT,
  AUTOMATION_NEW_CONTRACT,
  AUTOMATION_PAUSED,
} from "./automations";
import {
  RUN_DONE,
  RUN_FAILED,
  RUN_WAITING_APPROVAL,
  RUN_WAITING_EVENT,
  RUN_WAITING_PROJECT,
} from "./runs";
import { SOURCE_AUDIN, SOURCE_HUBSPOT, SOURCE_WEBHOOK } from "./sources";

export { AUTOMATIONS } from "./automations";
export { AUTOMATION_RUNS } from "./runs";
export { AUTOMATION_SOURCES, CLIENT_PROJECT_LINKS } from "./sources";

/** L'id di ogni caso del seme, per i test e i task successivi. */
export const AUTOMATION_CASES = {
  sources: { audin: SOURCE_AUDIN, hubspot: SOURCE_HUBSPOT, webhook: SOURCE_WEBHOOK },
  automations: {
    newContract: AUTOMATION_NEW_CONTRACT,
    clientData: AUTOMATION_CLIENT_DATA,
    draft: AUTOMATION_DRAFT,
    paused: AUTOMATION_PAUSED,
  },
  runs: {
    done: RUN_DONE,
    waitingProject: RUN_WAITING_PROJECT,
    waitingApproval: RUN_WAITING_APPROVAL,
    waitingEvent: RUN_WAITING_EVENT,
    failed: RUN_FAILED,
  },
} as const;
