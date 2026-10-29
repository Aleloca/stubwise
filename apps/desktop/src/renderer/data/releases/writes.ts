// Le scritture usano `createTaskAs`/`startRunAs`/`createConversationAs` solo
// dentro le funzioni: l'import circolare con `api-mutations` è innocuo.
import {
  addCommentAs,
  createConversationAs,
  createTaskAs,
  requestChangesAs,
  startRunAs,
} from "../api-mutations";
import { shortRepo } from "../../domain/releases/repo";
import { publishAlert } from "../alerts/publish";
import { PEOPLE } from "../seed/people";
import { copy, latestRunOf, newId, now, state, storeGeneration } from "../store";
import type {
  ColleaguePrMode,
  Conversation,
  EnvironmentServer,
  PrAutoCorrection,
  ProjectEnvironment,
  Release,
  Repository,
  Task,
} from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { assertServerCodesVisible } from "../servers/visibility";
import {
  canRequestCorrection,
  canSetAnalysisOnly,
  capOf,
  environmentFor,
  holds,
  fixPreviewOf,
  fixTitle,
  openFixTask,
  overStubwiseCap,
  prTaskOf,
  prFor,
  productionOf,
  prView,
  releaseBranchOf,
  releaseFor,
  releaseHref,
  releaseView,
  repositoryById,
  repositoryFor,
  sees,
  stateOfPr,
  statusOf,
  type OpenPrView,
  type ReleaseView,
} from "./visibility";

// Le scritture di Rilasci, PR e ambienti. Il merge è l'UNICA azione su un
// rilascio (anti-obiettivo 1): nessuna funzione avvia, rilancia o promuove
// una pipeline. Gli errori: `not_found` per ciò che chi agisce non vede
// (R-G5), `forbidden` per ciò che vede ma non può fare, `invalid: <cosa>`
// per un input sbagliato; il merge e la correzione chiesta restituiscono i
// loro esiti come codici, come sul web.

const personName = (id: string): string => PEOPLE.find((p) => p.id === id)?.name ?? id;

/** Uno sha finto ma stabile (40 esadecimali), da un seme e dal contatore dello store. */
export function fakeSha(seed: string): string {
  const salt = `${seed}:${++state.counter}`;
  let out = "";
  for (let k = 0; out.length < 40; k++) {
    let h = 0x811c9dc5 ^ k;
    for (const ch of salt) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

// --- merge ------------------------------------------------------------------

export type MergeError =
  | "forbidden"
  | "not_found"
  | "already_closed"
  | "checks_failed"
  | "checks_unreadable"
  | "not_mergeable"
  | "merge_forbidden";

/**
 * `release`: il rilascio nato dal merge; `null` se la PR non era sul ramo
 * di rilascio del repository (un merge, ma non un rilascio).
 */
export type MergeResult =
  | { ok: true; release: ReleaseView | null }
  | { ok: false; error: MergeError };

/**
 * Le run che il merge farà partire sulla piattaforma (nel prototipo: in
 * corso da adesso). Senza pipeline nessuna; con un elenco scelto, quelle;
 * altrimenti quelle dell'ultimo rilascio del repository. Stubwise le LEGGE:
 * nel motore arrivano dalla piattaforma, mai avviate da qui.
 */
function runsAfterMerge(repo: Repository | undefined, at: string): Release["runs"] {
  if (!repo?.ciProvider) return [];
  const last = state.releases
    .filter((r) => r.repositoryId === repo.id && r.runs.length > 0)
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
  const names =
    repo.releasePipeline?.mode === "named"
      ? repo.releasePipeline.names
      : (last?.runs.map((r) => r.name) ?? ["CI"]);
  return names.map((name) => {
    const n = 80000 + ++state.counter;
    return {
      id: `run-${n}`,
      name,
      status: "running" as const,
      url: `https://github.com/${repo.fullName ?? repo.name}/actions/runs/${n}`,
      failedStep: null,
      log: null,
      startedAt: at,
      endedAt: null,
    };
  });
}

/** «Rilascia»: il merge esplicito di una PR aperta (`release.merge`). */
export async function mergePr(prId: string): Promise<MergeResult> {
  const me = await writer("releases.mergePr");
  const pr = state.openPrs.find((p) => p.id === prId);
  if (!pr || !sees(me, pr.projectId)) return { ok: false, error: "not_found" };
  if (!holds(me, "release.merge", pr.projectId)) return { ok: false, error: "forbidden" };
  if (pr.state !== "open") return { ok: false, error: "already_closed" };
  // Come sul web: rossi bloccano, illeggibili bloccano, in corso passano.
  if (pr.checks === "failing") return { ok: false, error: "checks_failed" };
  if (pr.checks === "unreadable") return { ok: false, error: "checks_unreadable" };
  if (!pr.mergeable) return { ok: false, error: "not_mergeable" };
  if (pr.platformMergeForbidden) return { ok: false, error: "merge_forbidden" };

  const at = now();
  pr.state = "merged";
  if (pr.taskId) {
    state.pullRequests.push({
      id: newId("pr"),
      projectId: pr.projectId,
      taskId: pr.taskId,
      kind: "pr_merged",
      at,
      number: pr.number,
      repo: pr.repo,
    });
  }
  const repo = repositoryById(pr.repositoryId);
  if (pr.baseBranch !== releaseBranchOf(repo)) return { ok: true, release: null };

  const project = state.projectsById.get(pr.projectId)!;
  const n = (state.releaseCodeSeq.get(project.id) ?? 0) + 1;
  state.releaseCodeSeq.set(project.id, n);
  const release: Release = {
    id: newId("rel8"),
    code: `${project.code}-V${n}`,
    projectId: project.id,
    repositoryId: pr.repositoryId,
    pr: { repo: pr.repo, number: pr.number },
    title: pr.title,
    mergeSha: fakeSha(pr.id),
    mergedAt: at,
    mergedById: me,
    mergedGitName: personName(me),
    viaStubwise: true,
    runs: runsAfterMerge(repo, at),
    seenInProductionAt: null,
    fixTaskId: null,
  };
  state.releases.push(release);
  publishAlert({
    kind: "release.merged",
    projectId: project.id,
    objectCode: release.code,
    title: "New release",
    body: `${personName(me)} merged ${shortRepo(pr.repo)}#${pr.number}: ${pr.title}.`,
    link: releaseHref(project.code, release.code),
  });
  return { ok: true, release: releaseView(me, release) };
}

// --- impostazioni del repository ---------------------------------------------

const PR_MODES: readonly ColleaguePrMode[] = ["analyze_and_fix", "analyze_only", "off"];

/** Settings → repository: cosa fa Stubwise sulle PR dei colleghi (`repos.manage`). */
export async function setRepoPrMode(repositoryId: string, mode: ColleaguePrMode): Promise<void> {
  const me = await writer("releases.setRepoPrMode");
  const repo = repositoryFor(me, repositoryId);
  if (!holds(me, "repos.manage", repo.projectId)) throw forbidden();
  if (!PR_MODES.includes(mode)) throw invalid("mode");
  repo.colleaguePrs = mode;
  // «Spento» e «Solo analisi» valgono subito: una correzione in volo sulle
  // PR dei colleghi si ferma prima del push (non conta nel tetto, R-K8, e
  // non riparte alla riaccensione).
  if (mode === "analyze_and_fix") return;
  for (const pr of state.openPrs) {
    if (pr.repositoryId !== repo.id || pr.origin !== "colleague") continue;
    for (const c of pr.corrections) if (c.state === "running") c.state = "stopped";
  }
}

/** Settings → repository: quali run fanno lo stato del rilascio, e il ramo (`repos.manage`). */
export async function setReleasePipeline(
  repositoryId: string,
  pipeline: NonNullable<Repository["releasePipeline"]>,
  branch: string,
): Promise<void> {
  const me = await writer("releases.setReleasePipeline");
  const repo = repositoryFor(me, repositoryId);
  if (!holds(me, "repos.manage", repo.projectId)) throw forbidden();
  if (!branch.trim()) throw invalid("branch");
  let next: NonNullable<Repository["releasePipeline"]>;
  if (pipeline.mode === "auto") next = { mode: "auto" };
  else if (pipeline.mode === "named") {
    const names = [...new Set(pipeline.names.map((x) => x.trim()).filter(Boolean))];
    if (names.length === 0) throw invalid("names");
    next = { mode: "named", names };
  } else throw invalid("pipeline");
  repo.releasePipeline = next;
  repo.releaseBranch = branch.trim();
}

// --- PR ---------------------------------------------------------------------

/**
 * «Solo analisi» sulla singola PR di un collega (su una di Stubwise non c'è:
 * `invalid: origin`): l'autore (una persona) o chi ha `prs.adopt`. Restringe soltanto: su un repository «Spento» non si
 * accende (non riaccenderebbe l'analisi).
 */
export async function setPrAnalysisOnly(prId: string, on: boolean): Promise<OpenPrView> {
  const me = await writer("releases.setPrAnalysisOnly");
  const pr = prFor(me, prId);
  if (pr.origin !== "colleague") throw invalid("origin");
  if (!canSetAnalysisOnly(me, pr)) throw forbidden();
  if (pr.state !== "open") throw invalid("state");
  const repo = repositoryById(pr.repositoryId);
  if (on && pr.origin === "colleague" && repo?.colleaguePrs === "off")
    throw invalid("analysis_off");
  pr.analysisOnly = on ? (pr.analysisOnly ?? { byId: me, at: now() }) : null;
  return prView(me, pr);
}

export type CorrectionRequestResult =
  | {
      ok: true;
      /** La correzione sul ramo di un collega; `null` per una PR di Stubwise. */
      correction: PrAutoCorrection | null;
      /** La sessione di correzione della task (solo PR di Stubwise). */
      sessionId: string | null;
    }
  | {
      ok: false;
      error: "needs_maintainer" | "already_closed" | "in_flight" | "not_fixable" | "analysis_only";
    };

/**
 * «Chiedi modifiche» su una PR di un collega: un commit sopra, push in
 * avanti. Il tetto è uno solo, il `correctionCap` del progetto (R-K2):
 * oltre, solo chi ha `plans.approve` (`needs_maintainer` per gli altri, e
 * nessuna correzione nasce).
 */
export async function requestPrCorrection(
  prId: string,
  text: string,
): Promise<CorrectionRequestResult> {
  const gen = storeGeneration();
  const me = await writer("releases.requestPrCorrection");
  const pr = prFor(me, prId);
  if (!canRequestCorrection(me, pr)) throw forbidden();
  if (!text.trim()) throw invalid("text");
  if (pr.state !== "open") return { ok: false, error: "already_closed" };
  const st = stateOfPr(pr);
  if (pr.origin === "stubwise") {
    // Una PR di Stubwise si corregge con una sessione della sua task (il
    // percorso di «Chiedi modifiche», area 3), sotto lo stesso tetto (R-K2).
    const task = state.tasksById.get(pr.taskId!)!;
    if (st.notFixable) return { ok: false, error: "not_fixable" };
    if (overStubwiseCap(me, task, pr)) return { ok: false, error: "needs_maintainer" };
    const live = latestRunOf(task.id);
    if (live && live.state !== "finished") return { ok: false, error: "in_flight" };
    const session = await requestChangesAs(me, task, text, gen, {
      repo: pr.repo,
      number: pr.number,
    });
    return { ok: true, correction: null, sessionId: session.id };
  }
  if (pr.corrections.some((c) => c.state === "running")) return { ok: false, error: "in_flight" };
  if (st.notFixable) return { ok: false, error: "not_fixable" };
  if (st.state === "analysis_only" || st.state === "analysis_off") {
    return { ok: false, error: "analysis_only" };
  }
  if (st.autoRound >= capOf(pr.projectId) && !holds(me, "plans.approve", pr.projectId)) {
    return { ok: false, error: "needs_maintainer" };
  }
  const correction: PrAutoCorrection = {
    id: newId("pcor"),
    trigger: "person",
    byId: me,
    fromSha: pr.headSha,
    state: "running",
    commitSha: null,
    why: text.trim(),
    at: now(),
  };
  pr.corrections.push(correction);
  return { ok: true, correction: copy(correction), sessionId: null };
}

// --- rilascio fallito ---------------------------------------------------------

/**
 * Il testo della task di riparazione: la run fallita, il passo, il link. Il
 * log NON entra (ruling del Task 5): a chi ha `repos.view` la task rimanda
 * alle sue ultime 40 righe, che si leggono solo da lì.
 */
function fixDescription(r: Release, logLines: boolean, note?: string): string {
  const failed = r.runs.filter((x) => x.status === "failed");
  const lines = [
    `Release ${r.code} failed after the merge of ${r.pr.repo}#${r.pr.number}: ${r.title}.`,
    "",
    ...failed.map((x) => `- ${x.name}${x.failedStep ? `, step “${x.failedStep}”` : ""}: ${x.url}`),
  ];
  if (logLines) lines.push("", "The last 40 lines of the log are on the release page.");
  // La nota facoltativa di chi la chiede («Anything Claude should know?», [R 16]).
  if (note?.trim()) lines.push("", note.trim());
  return lines.join("\n");
}

/**
 * «Fai sistemare a Claude» (`tickets.create`): una task `bug` collegata al
 * rilascio (e «correlata» alla task della PR, se c'era), con l'errore della
 * run. Un rilascio fallito ha al massimo una task di riparazione aperta: un
 * secondo clic restituisce quella (`existing`), e la sua nota, se c'è, entra
 * come commento della task (`noteAdded`; senza `tickets.comment` non entra, e
 * la pagina lo dice). Con `runs.start` Claude parte col
 * percorso normale di «Avvia» (gate del piano per chi non ha `plans.approve`);
 * senza, la task aspetta qualcuno che la avvii.
 */
export type FixResult = Task & { existing: boolean; noteAdded: boolean };

export async function fixRelease(code: string, note?: string): Promise<FixResult> {
  const gen = storeGeneration();
  const me = await writer("releases.fixRelease");
  const r = releaseFor(me, code);
  if (!holds(me, "tickets.create", r.projectId)) throw forbidden();
  const existing = openFixTask(r);
  if (existing) {
    const noteAdded = !!note?.trim() && holds(me, "tickets.comment", r.projectId);
    if (noteAdded) addCommentAs(me, existing.id, note!);
    return { ...copy(existing), existing: true, noteAdded };
  }
  if (statusOf(r).kind !== "failed") throw invalid("status");
  const prTask = prTaskOf(r);
  const task = createTaskAs(
    me,
    {
      projectId: r.projectId,
      title: fixTitle(r),
      description: fixDescription(r, fixPreviewOf(me, r).logLines, note),
      type: "bug",
      priority: "high",
    },
    {
      releaseRef: { releaseId: r.id },
      links: prTask ? [{ kind: "relates", taskId: prTask.id }] : [],
    },
  );
  r.fixTaskId = task.id;
  if (holds(me, "runs.start", r.projectId)) await startRunAs(me, task, gen);
  return { ...copy(task), existing: false, noteAdded: false };
}

/**
 * «Chiedi a Claude di spiegarlo»: una conversazione libera di chi la apre,
 * col rilascio come oggetto di contesto (privacy dell'area 3: è sua). Un
 * secondo clic della stessa persona riapre la SUA conversazione su quel
 * rilascio invece di crearne un'altra ([R 17]): `reused` lo dice, così la
 * pagina manda la prima domanda solo a una conversazione nuova.
 */
export async function explainRelease(code: string): Promise<Conversation & { reused: boolean }> {
  const me = await writer("releases.explainRelease");
  const r = releaseFor(me, code);
  const mine = state.conversations.find(
    (c) =>
      c.kind === "free" &&
      c.ownerId === me &&
      !c.archived &&
      c.context?.kind === "release" &&
      c.context.releaseId === r.id,
  );
  if (mine) return { ...copy(mine), reused: true };
  const created = createConversationAs(me, { context: { kind: "release", releaseId: r.id } });
  return { ...copy(created), reused: false };
}

// --- ambienti -----------------------------------------------------------------

/** Su quale server gira una repository (`null` = tutto il progetto): R-L2. */
export interface EnvironmentServerInput {
  repositoryId: string | null;
  serverCode: string;
}

export interface EnvironmentInput {
  name: string;
  kind: ProjectEnvironment["kind"];
  url: string | null;
  /** L'insieme completo dei server dell'ambiente; vuoto = nessuno. */
  servers: EnvironmentServerInput[];
}

const ENV_KINDS: readonly ProjectEnvironment["kind"][] = ["test", "staging", "production"];

const serverCodeOf = (s: EnvironmentServerInput) => s.serverCode.trim().toUpperCase();

function checkEnvironment(me: string, projectId: string, input: Partial<EnvironmentInput>): void {
  if (input.name !== undefined && !input.name.trim()) throw invalid("name");
  if (input.kind !== undefined && !ENV_KINDS.includes(input.kind)) throw invalid("kind");
  if (input.url && !/^https?:\/\/\S+$/.test(input.url.trim())) throw invalid("url");
  if (input.servers === undefined) return;
  for (const s of input.servers) {
    if (!/^SRV-\d+$/.test(serverCodeOf(s))) throw invalid("serverCode");
    if (s.repositoryId !== null && repositoryById(s.repositoryId)?.projectId !== projectId) {
      throw invalid("repository");
    }
  }
  // Solo server che esistono e che chi scrive vede (R-G5, R-L2): un codice
  // nascosto risponde come uno inesistente.
  assertServerCodesVisible(me, input.servers.map(serverCodeOf));
  // Una riga per repository, e una sola per tutto il progetto.
  const keys = input.servers.map((s) => s.repositoryId);
  if (new Set(keys).size !== keys.length) throw invalid("repository");
}

/**
 * Le righe dei server dopo una modifica: una riga che resta sulla stessa
 * repository e sullo stesso server tiene il commit riportato; le altre
 * ripartono senza (il commit era del vecchio agente).
 */
function serverRows(
  before: EnvironmentServer[],
  input: EnvironmentServerInput[],
): EnvironmentServer[] {
  return input.map((s) => {
    const serverCode = serverCodeOf(s);
    const same = before.find(
      (b) => b.repositoryId === s.repositoryId && b.serverCode === serverCode,
    );
    return same ?? { repositoryId: s.repositoryId, serverCode, reportedSha: null, reportedAt: null };
  });
}

export async function createEnvironment(
  projectId: string,
  input: EnvironmentInput,
): Promise<ProjectEnvironment> {
  const me = await writer("releases.createEnvironment");
  if (!sees(me, projectId)) throw notFound();
  if (!holds(me, "environments.manage", projectId)) throw forbidden();
  checkEnvironment(me, projectId, input);
  if (input.kind === "production" && productionOf(projectId)) throw invalid("production_exists");
  const env: ProjectEnvironment = {
    id: newId("env"),
    projectId,
    name: input.name.trim(),
    kind: input.kind,
    url: input.url?.trim() || null,
    servers: serverRows([], input.servers),
  };
  state.environments.push(env);
  return copy(env);
}

/** Cambia nome, tipo, URL o server collegati; il commit riportato lo scrive solo l'agente. */
export async function updateEnvironment(
  id: string,
  patch: Partial<EnvironmentInput>,
): Promise<ProjectEnvironment> {
  const me = await writer("releases.updateEnvironment");
  const env = environmentFor(me, id);
  if (!holds(me, "environments.manage", env.projectId)) throw forbidden();
  checkEnvironment(me, env.projectId, patch);
  // Un solo ambiente di produzione: lo stato dei rilasci legge quello.
  const prod = productionOf(env.projectId);
  if (patch.kind === "production" && prod && prod.id !== env.id) {
    throw invalid("production_exists");
  }
  if (patch.name !== undefined) env.name = patch.name.trim();
  if (patch.kind !== undefined) env.kind = patch.kind;
  if (patch.url !== undefined) env.url = patch.url?.trim() || null;
  if (patch.servers !== undefined) env.servers = serverRows(env.servers, patch.servers);
  return copy(env);
}

export async function deleteEnvironment(id: string): Promise<void> {
  const me = await writer("releases.deleteEnvironment");
  const env = environmentFor(me, id);
  if (!holds(me, "environments.manage", env.projectId)) throw forbidden();
  state.environments = state.environments.filter((e) => e.id !== id);
}
