import type { Repository } from "../../types";

// I repository collegati, il minimo per i Docs (uno spazio per repository):
// STW e AUD coi nomi di `repoFiles.ts` e `commits.ts`; CBV, progetto cliente
// col modulo Docs, ha un repository con le sole pagine scritte a mano.
// Gli altri progetti `software` non hanno un repository nel seme: i loro Docs
// sono vuoti.
//
// Area 8a: ogni repository dice cosa fa con le PR dei colleghi, il ramo di
// rilascio e da dove si leggono le run. AUD ne ha due in più, senza spazio
// dei Docs: uno su «Solo analisi» e uno «Spento». STW non ha una pipeline
// (`ciProvider: null`): lo stato dei suoi rilasci lo dice l'ambiente.
// L'ordine conta: il primo repository di un progetto è il suo principale.

export const REPOSITORIES: Repository[] = [
  {
    id: "repo-stw",
    projectId: "prj-stw",
    name: "stubwise",
    fullName: "stubwise/stubwise",
    colleaguePrs: "analyze_and_fix",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: null,
  },
  {
    id: "repo-aud",
    projectId: "prj-aud",
    name: "audin-app",
    fullName: "audin/audin-app",
    colleaguePrs: "analyze_and_fix",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: "github_actions",
  },
  { id: "repo-cbv", projectId: "prj-cbv", name: "bellavista-store" },
  {
    id: "repo-aud-admin",
    projectId: "prj-aud",
    name: "audin-admin",
    fullName: "audin/audin-admin",
    colleaguePrs: "analyze_only",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: "github_actions",
  },
  {
    id: "repo-aud-scripts",
    projectId: "prj-aud",
    name: "audin-scripts",
    fullName: "audin/audin-scripts",
    colleaguePrs: "off",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: "github_actions",
  },
];
