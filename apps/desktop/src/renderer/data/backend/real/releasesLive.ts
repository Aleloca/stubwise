import type * as Fake from "../../api";
import { createRealEnvironments } from "./environments";
import { appClient } from "./client";
import { projectCodes } from "./claude";
import { createRealPrs } from "./releasePrs";
import { createRealRepoSettings } from "./releaseRepos";
import { createRealExplain, createRealReleases } from "./releases";

// I rilasci e le PR della build app sul client vero (area 8, F1): gli
// adattatori di `releases.ts` e `releasePrs.ts` sopra `client.releases`
// (S12) e, per il merge e «Chiedi modifiche», `client.tickets`. Ciò che resta
// fuori (ambienti, impostazioni del repository, «Spiega», ricerca) resta
// «non integrato» (`partialNamespace` in `index.ts`).

/** Il codice di un progetto (`AUD`) dal suo id, per i link e i codici delle task. */
const codeOf = async (projectId: string): Promise<string> =>
  (await projectCodes()).get(projectId) ?? "";

/** Il client si prende a ogni chiamata (`appClient()` è pigro e i test lo cambiano). */
const releases = createRealReleases(
  {
    list: (projectId) => appClient().releases.list(projectId),
    get: (code) => appClient().releases.get(code),
    fix: (code, body) => appClient().releases.fix(code, body),
    search: (q) => appClient().releases.search(q),
  },
  codeOf,
);

const prs = createRealPrs(
  {
    pulls: (projectId) => appClient().releases.pulls(projectId),
    queue: () => appClient().releases.queue(),
    myReleases: () => appClient().releases.mine(),
    merge: (ticketId, repositoryId) => appClient().tickets.release(ticketId, repositoryId),
    requestCorrection: (ticketId, repositoryId, body) =>
      appClient().tickets.requestCorrection(ticketId, repositoryId, body),
    releaseNotes: (repositoryId, prNumber) =>
      appClient().releases.releaseNotes(repositoryId, prNumber),
    putReleaseNotes: (repositoryId, prNumber, body) =>
      appClient().releases.putReleaseNotes(repositoryId, prNumber, body),
    analysisOnly: (repositoryId, prNumber, on) =>
      appClient().releases.analysisOnly(repositoryId, prNumber, on),
  },
  codeOf,
  (code) => releases.getRelease(code),
  (row) => releases.fromRow(row),
);

const repoSettings = createRealRepoSettings({
  list: (projectId) => appClient().repositories.list(projectId),
  update: (slug, patch) => appClient().repositories.updateReleaseSettings(slug, patch),
});

// Gli ambienti (area 8, F4a): le rotte di F1, coi server che chi scrive vede.
const environments = createRealEnvironments({
  list: (projectId) => appClient().environments.list(projectId),
  repositories: async (projectId) =>
    (await appClient().repositories.list(projectId)).map((r) => ({ id: r.id, name: r.name })),
  servers: async () => (await appClient().servers.list()).map((s) => ({ id: s.id, code: s.code })),
  // `environments.manage` di chi guarda: i permessi che il server calcola (`/api/auth/me`).
  canManage: async (projectId) => {
    const me = await appClient().auth.me();
    return (
      me.instancePermissions.includes("instance.full_admin") ||
      (me.projectPermissions[projectId] ?? []).includes("environments.manage" as never)
    );
  },
  create: (projectId, body) => appClient().environments.create(projectId, body),
  update: (projectId, id, patch) => appClient().environments.update(projectId, id, patch),
  remove: (projectId, id) => appClient().environments.remove(projectId, id),
  setContainers: (projectId, id, body) =>
    appClient().environments.setContainers(projectId, id, body),
});

// «Spiega»: una conversazione con Claude col contesto del rilascio (il tool `read_release` di 72).
const explain = createRealExplain({
  mine: async () =>
    (await appClient().claude.conversations.list()).items.map((c) => ({
      id: c.id,
      context: c.context,
    })),
  create: (context) => appClient().claude.conversations.create({ context }),
});

export const liveReleases: Partial<typeof Fake.releases> = {
  // `releases-prs`: le PR aperte, la coda, il merge, le correzioni, «Solo analisi», le note.
  listOpenPrs: prs.listOpenPrs,
  listReleaseQueue: prs.listReleaseQueue,
  mergePr: prs.mergePr,
  requestPrCorrection: prs.requestPrCorrection,
  setPrAnalysisOnly: prs.setPrAnalysisOnly,
  setPrReleaseNotes: prs.setPrReleaseNotes,
  // `releases`: i rilasci, «Fai sistemare a Claude», la Home.
  listReleases: releases.listReleases,
  getRelease: releases.getRelease,
  fixRelease: releases.fixRelease,
  // `releases-search` (rimandi, lotto 5): la ricerca ⌘K.
  searchReleases: releases.searchReleases,
  // `releases-explain`.
  explainRelease: explain.explainRelease,
  listMyReleases: prs.listMyReleases,
  // `releases-repo-settings`: il ramo di rilascio, la pipeline, le PR dei colleghi.
  getRepositorySettings: repoSettings.getRepositorySettings,
  setRepoPrMode: repoSettings.setRepoPrMode,
  setReleasePipeline: repoSettings.setReleasePipeline,
  // `environments` (area 8, F4a): gli ambienti coi server per repository.
  listEnvironments: environments.listEnvironments,
  createEnvironment: environments.createEnvironment,
  updateEnvironment: environments.updateEnvironment,
  deleteEnvironment: environments.deleteEnvironment,
  // `environment-containers` (area 8, F4b, R0-D): i container di un ambiente su un suo server.
  setEnvironmentContainers: environments.setEnvironmentContainers,
};

/** Area 10, F6: una PR letta da chi guarda, per il contesto della conversazione. */
export const prRefOf = prs.prRef;

/** La bozza delle note della PR per il riquadro di Claude (calcolata dal server). */
export const releaseNotesDraftFromServer = prs.releaseNotesDraft;
