// Le impostazioni di progetto (area 9c) come le espone `api.ts`:
// `api.projectSettings.<funzione>`. I Task 2–5 ci aggiungono le loro
// funzioni (General, AI, Automations, Usage, Repositories, file
// d'ambiente, Integration, Plugins, Archive). `changeTypes.ts` si importa per
// il suo effetto: registra i tipi di voce del registro prima della prima
// scrittura (P5). Lo stato (`state.ts`) e il seme (`seed.ts`) non si
// esportano come valori: li legge solo il livello dati.
import "./changeTypes";

export {
  CORRECTION_CAP_MAX,
  CORRECTION_CAP_MIN,
  PROJECT_SWITCHES,
  PULSE_DAYS_MAX,
  PULSE_DAYS_MIN,
  type DeletedProject,
  type ProjectPluginChoices,
  type ProjectSettings,
  type ProjectSwitch,
} from "./state";
export type { BusyReason, ProjectRefusal, ProjectResult } from "./types";
