import { SEED_GIT_ACCOUNT_IDS } from "../../instance/seed";
import type { Repository } from "../../types";

// I repository collegati, il minimo per i Docs (uno spazio per repository):
// STW e AUD coi nomi di `repoFiles.ts` e `commits.ts`; CBV, progetto cliente
// col modulo Docs, ha un repository con le sole pagine scritte a mano.
// Gli altri progetti `software` non hanno un repository nel seme: i loro Docs
// sono vuoti.
//
// Area 8a: ogni repository dice cosa fa con le PR dei colleghi, il ramo di
// rilascio (distinto dal ramo di default, R-K20) e da dove si leggono le run. AUD ne ha due in più, senza spazio
// dei Docs: uno su «Solo analisi» e uno «Spento»; STW la guida (la PR #58
// di STW-3). STW non ha una pipeline
// (`ciProvider: null`): lo stato dei suoi rilasci lo dice l'ambiente.
// L'ordine conta: il primo repository di un progetto è il suo principale.
//
// Area 9b: ognuno è legato a un account git d'istanza. «Bitbucket Audin»
// lavora sui repository dei clienti (AUD e CBV), «GitHub Stubwise» su quelli
// di STW: chi non vede AUD trova «Bitbucket Audin» in uso con i soli
// repository di CBV, e gli altri contati.

const { bitbucketAudin, githubStubwise } = SEED_GIT_ACCOUNT_IDS;

export const REPOSITORIES: Repository[] = [
  {
    id: "repo-stw",
    projectId: "prj-stw",
    name: "stubwise",
    fullName: "stubwise/stubwise",
    colleaguePrs: "analyze_and_fix",
    defaultBranch: "main",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: null,
    gitAccountId: githubStubwise,
  },
  {
    id: "repo-aud",
    projectId: "prj-aud",
    name: "audin-app",
    fullName: "audin/audin-app",
    colleaguePrs: "analyze_and_fix",
    defaultBranch: "main",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: "github_actions",
    gitAccountId: bitbucketAudin,
  },
  { id: "repo-cbv", projectId: "prj-cbv", name: "bellavista-store", gitAccountId: bitbucketAudin },
  {
    id: "repo-aud-admin",
    projectId: "prj-aud",
    name: "audin-admin",
    fullName: "audin/audin-admin",
    colleaguePrs: "analyze_only",
    defaultBranch: "main",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: "github_actions",
    gitAccountId: bitbucketAudin,
  },
  // La guida di STW (PR #58 di STW-3): senza spazio dei Docs, senza pipeline.
  {
    id: "repo-stw-guide",
    projectId: "prj-stw",
    name: "guide",
    fullName: "stubwise/guide",
    colleaguePrs: "analyze_and_fix",
    defaultBranch: "main",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: null,
    gitAccountId: githubStubwise,
  },
  {
    id: "repo-aud-scripts",
    projectId: "prj-aud",
    name: "audin-scripts",
    fullName: "audin/audin-scripts",
    colleaguePrs: "off",
    defaultBranch: "main",
    releaseBranch: "main",
    releasePipeline: { mode: "auto" },
    ciProvider: "github_actions",
    gitAccountId: bitbucketAudin,
  },
];
