import { SEED_GIT_ACCOUNT_IDS } from "../../instance/seed";
import type { Repository } from "../../types";
import { daysFromToday } from "../dates";

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
// repository di CBV (e di ACQ, dal 9c), e gli altri contati.
//
// Area 9c (Progetto → Settings → Repositories): i repository di STW e AUD
// hanno indirizzo, comandi, rami protetti (`main`, `release/*`) e il webhook
// git configurato. ACQ ha `portale-utenti`, col webhook ancora da
// configurare ([RE 9]). RNC, l'archiviato, ha `shop-frontend`: un nome che
// non ricorda il progetto, su un account git che nessun altro usa (P25), così
// la prova R-G5 dei repository senza progetto è pulita.

const { bitbucketAudin, githubStubwise, githubShop } = SEED_GIT_ACCOUNT_IDS;

/** Il webhook configurato del seme: il secret non è nel caveau, solo le ultime 4. */
const configured = (last4: string, days: number): NonNullable<Repository["webhook"]> => ({
  state: "configured",
  configuredAt: `${daysFromToday(-days)}T10:00:00Z`,
  secretId: null,
  last4,
});

/** Le impostazioni 9c di un repository di STW o AUD. */
const settled = (
  fullName: string,
  host: "github.com" | "bitbucket.org",
  last4: string,
  commands: { install: string | null; test: string | null },
): Pick<
  Repository,
  "url" | "installCommand" | "testCommand" | "graphEnabled" | "protectedBranches" | "webhook"
> => ({
  url: `https://${host}/${fullName}`,
  installCommand: commands.install,
  testCommand: commands.test,
  graphEnabled: false,
  protectedBranches: ["main", "release/*"],
  webhook: configured(last4, 120),
});

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
    ...settled("stubwise/stubwise", "github.com", "7c1e", {
      install: "pnpm install --frozen-lockfile",
      test: "pnpm test",
    }),
    graphEnabled: true,
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
    ...settled("audin/audin-app", "bitbucket.org", "a3f9", { install: null, test: "npm test" }),
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
    ...settled("audin/audin-admin", "bitbucket.org", "5d20", { install: null, test: null }),
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
    ...settled("stubwise/guide", "github.com", "e81b", { install: null, test: null }),
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
    ...settled("audin/audin-scripts", "bitbucket.org", "0b6c", { install: null, test: null }),
  },
  // Area 9c, [RE 9]: il portale di ACQ, collegato ma col webhook da configurare.
  {
    id: "repo-acq",
    projectId: "prj-acq",
    name: "portale-utenti",
    fullName: "audin/portale-utenti",
    defaultBranch: "main",
    gitAccountId: bitbucketAudin,
    url: "https://bitbucket.org/audin/portale-utenti",
    installCommand: null,
    testCommand: null,
    graphEnabled: false,
    protectedBranches: ["main"],
    webhook: { state: "not_configured", configuredAt: null, secretId: null, last4: null },
  },
  // Area 9c: il repository di RNC, l'archiviato.
  {
    id: "repo-rnc",
    projectId: "prj-rnc",
    name: "shop-frontend",
    fullName: "vetrina-web/shop-frontend",
    defaultBranch: "main",
    gitAccountId: githubShop,
    url: "https://github.com/vetrina-web/shop-frontend",
    installCommand: null,
    testCommand: null,
    graphEnabled: false,
    protectedBranches: ["main"],
    webhook: configured("9f42", 200),
  },
];
