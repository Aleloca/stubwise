import { correctionsOf, prKey } from "../../domain/claude/taskWork";
import {
  correctionsFromRecords,
  countedRound,
  DEFAULT_CORRECTION_CAP,
  isReadyForRelease,
  prState,
  type PrCorrectionInput,
  type PrState,
} from "../../domain/releases/prState";
import { releaseStatus, type ReleaseStatus } from "../../domain/releases/releaseStatus";
import { releaseMandatory } from "../alerts/publish";
import { holds, sees } from "../access";
import { eventsOf, now, state } from "../store";
import type {
  CiRun,
  OpenPullRequest,
  PrRef,
  ProjectEnvironment,
  Release,
  Repository,
  Task,
} from "../types";
import { notFound } from "../writer";

// Chi vede che cosa in Rilasci, PR e ambienti (area 8a) — l'unica regola,
// per letture e scritture. PR, rilasci e ambienti li vedono i membri del
// progetto (chi lo vede); il log di una run solo chi ha `repos.view` (i log
// di CI possono dire più del codice). Un oggetto di un progetto invisibile
// risponde come uno che non esiste (R-G5). Lo stato di una PR e di un
// rilascio si DERIVA qui, con le regole pure di `domain/releases`.

export { holds, sees };

export const capOf = (projectId: string): number =>
  state.projectsById.get(projectId)?.correctionCap ?? DEFAULT_CORRECTION_CAP;

export const repositoryById = (id: string): Repository | undefined =>
  state.repositories.find((r) => r.id === id);

/** Il ramo di default di un repository sulla piattaforma, o `main`. */
export const defaultBranchOf = (repo: Repository | undefined): string =>
  repo?.defaultBranch ?? "main";

/** Il ramo di rilascio di un repository: quello scelto, o `main`. */
export const releaseBranchOf = (repo: Repository | undefined): string =>
  repo?.releaseBranch ?? "main";

/** L'ambiente di produzione del progetto: il primo di tipo produzione. */
export const productionOf = (projectId: string): ProjectEnvironment | null =>
  state.environments.find((e) => e.projectId === projectId && e.kind === "production") ?? null;

export function prFor(me: string, prId: string): OpenPullRequest {
  const pr = state.openPrs.find((p) => p.id === prId);
  if (!pr || !sees(me, pr.projectId)) throw notFound();
  return pr;
}

export function releaseFor(me: string, code: string): Release {
  const r = state.releases.find((x) => x.code === code);
  if (!r || !sees(me, r.projectId)) throw notFound();
  return r;
}

export function repositoryFor(me: string, id: string): Repository {
  const repo = repositoryById(id);
  if (!repo || !sees(me, repo.projectId)) throw notFound();
  return repo;
}

export function environmentFor(me: string, id: string): ProjectEnvironment {
  const env = state.environments.find((e) => e.id === id);
  if (!env || !sees(me, env.projectId)) throw notFound();
  return env;
}

// --- PR ---------------------------------------------------------------------

/**
 * Le correzioni di una PR di Stubwise (`key`, `owner/repo#n`), dalle sessioni
 * della task (tutte: lo stato della PR lo vedono i membri, anche chi non
 * legge le sessioni).
 */
function taskPrCorrections(taskId: string, key: string): PrCorrectionInput[] {
  const runs = state.conversations
    .filter((c) => c.kind === "task_run" && c.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      ownerId: c.ownerId,
      createdAt: c.createdAt,
      state: c.state,
      outcome: c.outcome,
      events: eventsOf(c.id),
      provider: c.provider ?? null,
      failureSummary: null,
    }));
  const pullRequests = state.pullRequests.filter((p) => p.taskId === taskId);
  return correctionsFromRecords(correctionsOf({ runs, pullRequests }), key);
}

const sessionCorrections = (pr: OpenPullRequest): PrCorrectionInput[] =>
  pr.taskId ? taskPrCorrections(pr.taskId, prKey(pr.repo, pr.number)) : [];

/**
 * Il tetto R-K2, lo stesso su ogni porta che apre una correzione su una PR
 * di Stubwise (la task, area 3; il pannello dei Rilasci): al giro
 * `countedRound` pari al `correctionCap` del progetto, va solo chi ha
 * `plans.approve` (`needs_maintainer` per gli altri).
 */
export function overStubwiseCap(me: string, task: Task, pr: PrRef): boolean {
  const round = countedRound(taskPrCorrections(task.id, prKey(pr.repo, pr.number)));
  return round >= capOf(task.projectId) && !holds(me, "plans.approve", task.projectId);
}

/** Lo stato della PR adesso (un motore per tutte). */
export function stateOfPr(pr: OpenPullRequest): PrState {
  const repo = repositoryById(pr.repositoryId);
  const task = pr.taskId ? state.tasksById.get(pr.taskId) : undefined;
  return prState({
    origin: pr.origin,
    headSha: pr.headSha,
    analysis: pr.analysis,
    corrections: pr.origin === "stubwise" ? sessionCorrections(pr) : pr.corrections,
    cap: capOf(pr.projectId),
    repoMode: repo?.colleaguePrs ?? "analyze_and_fix",
    prAnalysisOnly: pr.analysisOnly !== null,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    defaultBranch: defaultBranchOf(repo),
    releaseBranch: releaseBranchOf(repo),
    fromFork: pr.fromFork,
    branchProtected: pr.branchProtected,
    ownTaskCode: task?.code ?? null,
  });
}

/** Chi è l'autore della PR, come persona di Stubwise (mai Claude). */
export const isAuthor = (me: string, pr: OpenPullRequest): boolean => pr.authorId === me;

/**
 * «Solo analisi» sulla PR di un collega: l'autore (una persona) o chi ha
 * `prs.adopt`. Su una PR di Stubwise non c'è: le sue correzioni sono
 * sessioni della task, sotto il tetto (R-K2).
 */
export const canSetAnalysisOnly = (me: string, pr: OpenPullRequest): boolean =>
  pr.origin === "colleague" && (isAuthor(me, pr) || holds(me, "prs.adopt", pr.projectId));

/**
 * Chiedere una correzione. Su una PR di un collega: l'autore con
 * `corrections.request`, gli altri con `prs.adopt`. Su una PR di Stubwise:
 * il permesso di oggi, `corrections.request` (come «Chiedi modifiche» sulla
 * task, area 3), purché la task si veda — la correzione è una sua sessione.
 */
export const canRequestCorrection = (me: string, pr: OpenPullRequest): boolean => {
  if (pr.origin === "stubwise") {
    const task = pr.taskId ? state.tasksById.get(pr.taskId) : undefined;
    return !!task && sees(me, task.projectId) && holds(me, "corrections.request", pr.projectId);
  }
  return isAuthor(me, pr)
    ? holds(me, "corrections.request", pr.projectId)
    : holds(me, "prs.adopt", pr.projectId);
};

export type OpenPrView = OpenPullRequest & {
  prState: PrState;
  /** Il tetto delle correzioni del progetto (R-K2): la UI lo legge, non lo deduce. */
  cap: number;
  taskCode: string | null;
  /** Cosa può fare chi guarda, deciso qui (il client non lo deduce). */
  actions: { analysisOnly: boolean; requestCorrection: boolean };
};

export function prView(me: string, pr: OpenPullRequest): OpenPrView {
  const task = pr.taskId ? state.tasksById.get(pr.taskId) : undefined;
  return {
    ...structuredClone(pr),
    prState: stateOfPr(pr),
    cap: capOf(pr.projectId),
    taskCode: task && sees(me, task.projectId) ? task.code : null,
    actions: {
      analysisOnly: canSetAnalysisOnly(me, pr),
      requestCorrection: canRequestCorrection(me, pr),
    },
  };
}

export type QueueItem = OpenPrView & { canMerge: boolean };

/** Pronta per il rilascio (R-K4, R-K7): la regola sta in `isReadyForRelease`. */
export const isReady = (view: OpenPrView): boolean => isReadyForRelease(view, view.prState);

export const queueItem = (me: string, view: OpenPrView): QueueItem => ({
  ...view,
  canMerge: holds(me, "release.merge", view.projectId),
});

// --- rilasci ----------------------------------------------------------------

/** Una run come la legge chi guarda: senza `repos.view` il log non c'è. */
export type RunView = CiRun & { logHidden: boolean };

export interface ReleaseView extends Omit<Release, "runs"> {
  projectCode: string;
  status: ReleaseStatus;
  runs: RunView[];
  /** La task di «Fai sistemare a Claude», se chi guarda la vede. */
  fixTask: { id: string; code: string; title: string; open: boolean } | null;
  /**
   * L'anteprima della task di «Fai sistemare a Claude», con gli stessi dati
   * di `fixRelease` (il titolo lo scrive la pagina col suo template i18n):
   * il passo fallito, la task della PR (se chi guarda la vede) e se la task
   * rimanda alle ultime righe del log (solo con `repos.view`).
   */
  fixPreview: FixPreview;
  /** «Fai sistemare a Claude»: `tickets.create` (e `runs.start` per far partire Claude). */
  canFix: boolean;
  canStartFix: boolean;
  /**
   * Aspetta chi guarda ([R 6], il punto sulla voce della colonna): fallito,
   * senza task di riparazione aperta, e chi guarda ne è destinatario
   * obbligatorio (`releaseMandatory`: il merge è suo).
   */
  waitsOnViewer: boolean;
}

export interface FixPreview {
  step: string | null;
  relatedTaskCode: string | null;
  logLines: boolean;
}

/** La prima run fallita del rilascio (quella che la task racconta). */
export const firstFailedRun = (r: Release): CiRun | undefined =>
  r.runs.find((x) => x.status === "failed");

/** La task della PR del rilascio (dalla cronologia delle PR), se c'era. */
export function prTaskOf(r: Release) {
  const ev = state.pullRequests.find(
    (p) => p.projectId === r.projectId && p.repo === r.pr.repo && p.number === r.pr.number,
  );
  return ev ? state.tasksById.get(ev.taskId) : undefined;
}

/** Il titolo della task di riparazione: dal passo fallito, se c'è (template di `releases.fix.taskTitle`). */
export function fixTitle(r: Release): string {
  const step = firstFailedRun(r)?.failedStep;
  return step ? `Fix release ${r.code}: “${step}” failed` : `Fix release ${r.code}: ${r.title}`;
}

export function fixPreviewOf(me: string, r: Release): FixPreview {
  const run = firstFailedRun(r);
  const related = prTaskOf(r);
  return {
    step: run?.failedStep ?? null,
    relatedTaskCode: related && sees(me, related.projectId) ? related.code : null,
    logLines: !!run?.log && holds(me, "repos.view", r.projectId),
  };
}

export function statusOf(r: Release): ReleaseStatus {
  return releaseStatus(r, {
    now: now(),
    production: productionOf(r.projectId),
    pipeline: repositoryById(r.repositoryId)?.releasePipeline,
  });
}

/** La task di riparazione aperta di un rilascio, se c'è. */
export function openFixTask(r: Release) {
  const task = r.fixTaskId ? state.tasksById.get(r.fixTaskId) : undefined;
  return task && task.closedAt === null ? task : undefined;
}

export function releaseView(me: string, r: Release): ReleaseView {
  const viewLog = holds(me, "repos.view", r.projectId);
  const task = r.fixTaskId ? state.tasksById.get(r.fixTaskId) : undefined;
  const { runs, ...rest } = structuredClone(r);
  return {
    ...rest,
    projectCode: state.projectsById.get(r.projectId)!.code,
    status: statusOf(r),
    runs: runs.map((run) => ({
      ...run,
      log: viewLog ? run.log : null,
      logHidden: !viewLog && run.log !== null,
    })),
    fixTask: task
      ? { id: task.id, code: task.code, title: task.title, open: !task.closedAt }
      : null,
    fixPreview: fixPreviewOf(me, r),
    canFix: holds(me, "tickets.create", r.projectId),
    canStartFix: holds(me, "runs.start", r.projectId),
    waitsOnViewer:
      statusOf(r).kind === "failed" &&
      !openFixTask(r) &&
      releaseMandatory(r).some((m) => m.personId === me),
  };
}

/** L'indirizzo di un rilascio (notifiche, ⌘K): il suo dettaglio. */
export const releaseHref = (projectCode: string, code: string): string =>
  `#/p/${projectCode}/releases/${code}`;

/** L'indirizzo di una PR aperta (avvisi `pr.*`): la sezione col suo pannello. */
export const prHref = (projectCode: string, prId: string): string =>
  `#/p/${projectCode}/releases?pr=${prId}`;

/** Le PR aperte di un progetto, viste da `me` (vuoto se non lo vede). */
export function openPrViews(me: string, projectId: string): OpenPrView[] {
  if (!sees(me, projectId)) return [];
  return state.openPrs
    .filter((p) => p.projectId === projectId && p.state === "open")
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .map((p) => prView(me, p));
}
