// I Docs (area 5) come li espone `api.ts`: `api.docs.<funzione>`. Chi vede
// che cosa lo decide `docsAccess` (reads.ts), per letture e scritture.
export {
  DOC_KINDS,
  getDocPage,
  getDocSpace,
  getProjectDocsHome,
  getRepoBrief,
  listDocSpaces,
  listDocTree,
  searchDocs,
} from "./reads";
export { askDocs } from "./chat";
export {
  createManualPage,
  deleteManualPage,
  generationHistory,
  graphAction,
  recordDocView,
  resumeGeneration,
  startGeneration,
  updateManualPage,
  whenDocsIdle,
} from "./writes";
