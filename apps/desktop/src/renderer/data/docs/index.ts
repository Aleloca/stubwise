// I Docs (area 5) come li espone `api.ts`: `api.docs.<funzione>`. Chi vede
// che cosa lo decide `docsAccess` (reads.ts), per letture e scritture.
export {
  DOC_KINDS,
  getDocPage,
  getDocSpace,
  getProjectDocsHome,
  listDocSpaces,
  listDocTree,
  searchDocs,
} from "./reads";
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
