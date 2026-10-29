import { alertTypeOf } from "../../domain/alerts/catalog";
import { fold } from "../../domain/textSearch";
import { releaseMandatory } from "../alerts/publish";
import { currentChannels } from "../alerts/reads";
import { gate, state } from "../store";
import type { ProjectEnvironment, Repository } from "../types";
import {
  holds,
  isReady,
  openFixTask,
  openPrViews,
  queueItem,
  releaseHref,
  releaseView,
  sees,
  statusOf,
  type OpenPrView,
  type QueueItem,
  type ReleaseView,
} from "./visibility";

// Le letture di Rilasci, PR e ambienti. Le liste di un progetto che chi
// guarda non vede sono vuote, il dettaglio di un rilascio invisibile è
// `null`, come uno che non esiste (R-G5). Gli stati si derivano a lettura.

/** Il numero di un codice `<PRJ>-V<n>`. */
const codeNumber = (code: string): number => Number(code.slice(code.search(/\d+$/)));

/** Dal più recente; a parità d'ora (orologio fermo) il numero più alto: V10 prima di V9. */
const byRecency = (a: { mergedAt: string; code: string }, b: { mergedAt: string; code: string }) =>
  b.mergedAt.localeCompare(a.mergedAt) || codeNumber(b.code) - codeNumber(a.code);

/** Le PR aperte del progetto: di Stubwise e dei colleghi, stessa forma. */
export async function listOpenPrs(projectId: string): Promise<OpenPrView[]> {
  const me = await gate("releases.listOpenPrs");
  return openPrViews(me, projectId);
}

/** «Pronte per il rilascio»: il primo gruppo della stessa lista, con chi può mergiare. */
export async function listReleaseQueue(projectId: string): Promise<QueueItem[]> {
  const me = await gate("releases.listReleaseQueue");
  return openPrViews(me, projectId)
    .filter(isReady)
    .map((v) => queueItem(me, v));
}

/** I rilasci del progetto, dal più recente, col loro stato. */
export async function listReleases(projectId: string): Promise<ReleaseView[]> {
  const me = await gate("releases.listReleases");
  if (!sees(me, projectId)) return [];
  return state.releases
    .filter((r) => r.projectId === projectId)
    .sort(byRecency)
    .map((r) => releaseView(me, r));
}

/** Il dettaglio di un rilascio (`AUD-V3`): stato, run, task di riparazione. */
export async function getRelease(code: string): Promise<ReleaseView | null> {
  const me = await gate("releases.getRelease");
  const r = state.releases.find((x) => x.code === code);
  if (!r || !sees(me, r.projectId)) return null;
  return releaseView(me, r);
}

export interface EnvironmentList {
  /** `environments.manage`: aggiungere, modificare, togliere. */
  canManage: boolean;
  environments: ProjectEnvironment[];
  /** Le repository del progetto, per dire su quale server gira ognuna (R-L2). */
  repositories: { id: string; name: string }[];
  /**
   * I server dei suoi ambienti che nessun altro progetto usa: togliendone
   * l'ultima riga il server resta orfano, e lo ricollega solo chi ha
   * `monitor.manage` (R-L7). La UI lo dice prima di salvare.
   */
  onlyHere: string[];
}

/** Gli ambienti del progetto: pura anagrafica (anti-obiettivo 1). */
export async function listEnvironments(projectId: string): Promise<EnvironmentList> {
  const me = await gate("releases.listEnvironments");
  if (!sees(me, projectId))
    return { canManage: false, environments: [], repositories: [], onlyHere: [] };
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  for (const e of state.environments)
    for (const s of e.servers) (e.projectId === projectId ? here : elsewhere).add(s.serverCode);
  return {
    canManage: holds(me, "environments.manage", projectId),
    environments: state.environments
      .filter((e) => e.projectId === projectId)
      .map((e) => structuredClone(e)),
    repositories: state.repositories
      .filter((r) => r.projectId === projectId)
      .map((r) => ({ id: r.id, name: r.name })),
    onlyHere: [...here]
      .filter((c) => !elsewhere.has(c))
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))),
  };
}

export interface MyReleases {
  /** Le PR pronte nei progetti dove chi guarda ha `release.merge`. */
  ready: QueueItem[];
  /**
   * I rilasci falliti che lo riguardano (obbligatorio per il merge, o iscritto
   * adesso), finché non c'è una task di riparazione CHIUSA: uno in
   * riparazione resta (lo shape: «finché la task non si chiude»). È una
   * domanda diversa da `waitsOnViewer` (il punto «ti aspetta»), che con una
   * riparazione aperta tace: qualcuno ci sta già lavorando.
   */
  failed: ReleaseView[];
}

/** Il blocco «Rilasci» della Home. */
export async function listMyReleases(): Promise<MyReleases> {
  const me = await gate("releases.listMyReleases");
  const ready: QueueItem[] = [];
  const failed: ReleaseView[] = [];
  const failedType = alertTypeOf("release.failed");
  for (const p of state.projects) {
    if (!sees(me, p.id)) continue;
    if (holds(me, "release.merge", p.id)) {
      for (const v of openPrViews(me, p.id)) if (isReady(v)) ready.push(queueItem(me, v));
    }
    for (const r of state.releases) {
      if (r.projectId !== p.id || statusOf(r).kind !== "failed") continue;
      if (r.fixTaskId && !openFixTask(r)) continue;
      const mine = releaseMandatory(r).some((m) => m.personId === me);
      const subscribed = failedType ? currentChannels(me, p.id, failedType).app : false;
      if (mine || subscribed) failed.push(releaseView(me, r));
    }
  }
  failed.sort(byRecency);
  return { ready, failed };
}

export interface RepositorySettings {
  /** `repos.manage`: modo delle PR dei colleghi, pipeline e ramo di rilascio. */
  canManage: boolean;
  repositories: Required<
    Pick<
      Repository,
      | "id"
      | "name"
      | "fullName"
      | "colleaguePrs"
      | "releaseBranch"
      | "releasePipeline"
      | "ciProvider"
    >
  >[];
}

/** Settings → repository del progetto (`null`: progetto che non si vede, o inesistente). */
export async function getRepositorySettings(projectId: string): Promise<RepositorySettings | null> {
  const me = await gate("releases.getRepositorySettings");
  if (!sees(me, projectId)) return null;
  return {
    canManage: holds(me, "repos.manage", projectId),
    repositories: state.repositories
      .filter((r) => r.projectId === projectId)
      .map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.fullName ?? r.name,
        colleaguePrs: r.colleaguePrs ?? "analyze_and_fix",
        releaseBranch: r.releaseBranch ?? "main",
        releasePipeline: structuredClone(r.releasePipeline ?? { mode: "auto" as const }),
        ciProvider: r.ciProvider ?? null,
      })),
  };
}

export interface ReleaseSearchResult {
  kind: "release";
  id: string;
  code: string;
  label: string;
  route: string;
  status: ReleaseView["status"]["kind"];
}

/** ⌘K: i rilasci per codice (o titolo), solo nei progetti che chi cerca vede. */
export async function searchReleases(q: string): Promise<ReleaseSearchResult[]> {
  const me = await gate("releases.searchReleases");
  const needle = fold(q.trim());
  if (!needle) return [];
  return state.releases
    .filter((r) => sees(me, r.projectId))
    .filter((r) => fold(r.code).includes(needle) || fold(r.title).includes(needle))
    .map((r) => ({
      kind: "release" as const,
      id: r.id,
      code: r.code,
      label: r.title,
      route: releaseHref(state.projectsById.get(r.projectId)!.code, r.code),
      status: statusOf(r).kind,
    }));
}
