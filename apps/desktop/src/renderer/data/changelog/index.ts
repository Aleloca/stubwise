// Il registro delle modifiche (area 9a). Le scritture d'amministrazione e
// d'impostazione importano `recordChange` e dichiarano i loro tipi con
// `registerChangeTypes`; le pagine leggono da `api.changelog` (solo le due
// letture) attraverso `data/queries.ts`. Nessuna funzione modifica o
// cancella una voce (test sui nomi esportati).
export { changeTypeOf, changeTypes, recordChange, registerChangeTypes } from "./record";
export { listChanges, listProjectChanges } from "./reads";
export type {
  ChangeEntry,
  ChangeEntryView,
  ChangeFilter,
  ChangeInput,
  ChangeObject,
  ChangeType,
} from "./types";
