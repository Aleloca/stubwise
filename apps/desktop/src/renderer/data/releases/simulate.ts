import { environmentServerFor } from "../../domain/releases/environmentServer";
import { shortRepo } from "../../domain/releases/repo";
import { publishAlert, releaseMandatory } from "../alerts/publish";
import { CLAUDE_ID } from "../seed/people";
import { newId, now, state } from "../store";
import type { OpenPullRequest, PrAutoCorrection } from "../types";
import { invalid, writer } from "../writer";
import {
  prFor,
  prView,
  releaseFor,
  prHref,
  releaseHref,
  releaseView,
  repositoryById,
  productionOf,
  stateOfPr,
  statusOf,
  type OpenPrView,
  type ReleaseView,
} from "./visibility";
import { fakeSha } from "./writes";

// SOLO PROTOTIPO: ciò che nel motore arriva da fuori (la piattaforma git,
// la CI, l'agente di monitoraggio) e che qui si simula a mano, coi «Simula …»
// della UI. Nessuna di queste funzioni avvia, rilancia o promuove una
// pipeline (anti-obiettivo 1): fanno arrivare l'ESITO che Stubwise legge.
// Gli avvisi passano tutti da `publishAlert`.

const projectCodeOf = (projectId: string) => state.projectsById.get(projectId)!.code;

/**
 * Gli obbligatori «autore della PR»: una persona collegata. Claude (autore
 * delle PR di Stubwise) non si scrive nemmeno, oltre a essere escluso a
 * lettura (R-K5).
 */
const authorMandatory = (pr: OpenPullRequest) =>
  pr.authorId && pr.authorId !== CLAUDE_ID
    ? [{ personId: pr.authorId, reason: "pr_author" as const }]
    : [];

/** Le righe finte del log di una run fallita dal prototipo. */
const simulatedLog = (name: string) =>
  [
    `Run ${name}`,
    "Simulated by the prototype: no pipeline ran.",
    "Error: Process completed with exit code 1.",
    `##[error]${name} failed`,
  ].join("\n");

/**
 * «Simula esito»: una run in corso finisce riuscita o fallita. Se il
 * rilascio diventa fallito o riuscito, parte l'avviso (fallito: obbligatorio
 * per chi ha fatto il merge, `releaseMandatory`).
 */
export async function simulateRunOutcome(
  code: string,
  runId: string,
  outcome: "success" | "failed",
): Promise<ReleaseView> {
  const me = await writer("releases.simulateRunOutcome");
  const r = releaseFor(me, code);
  const run = r.runs.find((x) => x.id === runId);
  if (!run) throw invalid("run");
  if (run.status !== "running") throw invalid("status");
  if (outcome !== "success" && outcome !== "failed") throw invalid("outcome");
  const before = statusOf(r).kind;
  run.status = outcome;
  run.endedAt = now();
  if (outcome === "failed") {
    run.failedStep = run.name;
    run.log = simulatedLog(run.name);
  }
  const after = statusOf(r).kind;
  const link = releaseHref(projectCodeOf(r.projectId), r.code);
  if (after !== before && after === "failed") {
    publishAlert({
      kind: "release.failed",
      projectId: r.projectId,
      objectCode: r.code,
      title: "Release failed",
      body: `${r.code} failed in ${run.name}.`,
      link,
      mandatory: releaseMandatory(r),
    });
  } else if (after !== before && after === "succeeded") {
    publishAlert({
      kind: "release.succeeded",
      projectId: r.projectId,
      objectCode: r.code,
      title: "Release succeeded",
      body: `${r.code} succeeded: ${r.title}.`,
      link,
    });
  }
  return releaseView(me, r);
}

/**
 * «Simula comparsa sul server»: l'agente dell'ambiente di produzione
 * riporta il commit del merge. Senza un ambiente di produzione con server
 * non c'è nessuno che lo riporti.
 */
export async function simulateSeenOnServer(code: string): Promise<ReleaseView> {
  const me = await writer("releases.simulateSeenOnServer");
  const r = releaseFor(me, code);
  const env = productionOf(r.projectId);
  // Il server della repository del rilascio (R-L2), non uno qualunque dell'ambiente.
  const server = env && environmentServerFor(env, r.repositoryId);
  if (!server) throw invalid("environment");
  const at = now();
  server.reportedSha = r.mergeSha;
  server.reportedAt = at;
  r.seenInProductionAt ??= at;
  return releaseView(me, r);
}

/**
 * «Simula push dell'autore»: una testa nuova sulla PR. Una correzione di
 * Claude in volo si scarta (il suo push sarebbe rifiutato, non conta nel
 * tetto) e l'analisi riparte sulla testa nuova.
 */
export async function simulateAuthorPush(prId: string): Promise<OpenPrView> {
  const me = await writer("releases.simulateAuthorPush");
  const pr = prFor(me, prId);
  if (pr.state !== "open") throw invalid("state");
  pr.headSha = fakeSha(pr.id);
  for (const c of pr.corrections) if (c.state === "running") c.state = "discarded";
  const repo = repositoryById(pr.repositoryId);
  const off = pr.origin === "colleague" && repo?.colleaguePrs === "off";
  if (!off && pr.analysis) {
    pr.analysis = { ...pr.analysis, sha: pr.headSha, status: "running", at: now() };
  } else if (!off) {
    pr.analysis = {
      sha: pr.headSha,
      status: "running",
      summary: "",
      risk: "low",
      issues: [],
      at: now(),
    };
  }
  return prView(me, pr);
}

/** Chiude la correzione in volo al momento del push, ricontrollando modo e testa. */
function settleCorrection(pr: OpenPullRequest, c: PrAutoCorrection): void {
  const st = stateOfPr(pr);
  // «Solo analisi» acceso (o repository «Spento») nel frattempo: si ferma
  // prima del push. Un ramo diventato vietato: idem.
  if (st.state === "analysis_only" || st.state === "analysis_off" || st.notFixable) {
    c.state = "stopped";
    return;
  }
  // L'autore ha spinto nel frattempo: il push sarebbe rifiutato, si scarta.
  if (pr.headSha !== c.fromSha) {
    c.state = "discarded";
    return;
  }
  const sha = fakeSha(pr.id);
  c.state = "pushed";
  c.commitSha = sha;
  pr.headSha = sha;
  // L'analisi riparte sulla testa nuova; il commit ha chiuso il primo problema.
  if (pr.analysis) {
    pr.analysis = {
      ...pr.analysis,
      sha,
      status: "running",
      issues: pr.analysis.issues.slice(1),
      at: now(),
    };
  }
  publishAlert({
    kind: "pr.corrected",
    projectId: pr.projectId,
    objectCode: `${pr.repo}#${pr.number}`,
    title: "Claude fixed your pull request",
    body: `Claude pushed a fix on ${shortRepo(pr.repo)}#${pr.number}: ${c.why}`,
    link: prHref(projectCodeOf(pr.projectId), pr.id),
    mandatory: authorMandatory(pr),
  });
}

/**
 * Un passo del lavoro automatico su una PR: chiude la correzione in volo
 * (push, fermata o scartata); altrimenti finisce l'analisi della testa
 * (con l'avviso dei problemi all'autore); altrimenti, se si può, fa partire
 * la correzione automatica sul ramo di un collega. Le PR di Stubwise si
 * correggono dalle sessioni della task: qui solo l'analisi.
 */
export async function advancePrWork(prId: string): Promise<OpenPrView> {
  const me = await writer("releases.advancePrWork");
  const pr = prFor(me, prId);
  if (pr.state !== "open") return prView(me, pr);
  // La correzione in volo si chiude per prima: anche su un repository messo
  // su «Spento» (si ferma prima del push, I1).
  const inFlight = pr.corrections.find((c) => c.state === "running");
  if (inFlight) {
    settleCorrection(pr, inFlight);
    return prView(me, pr);
  }
  const repo = repositoryById(pr.repositoryId);
  if (pr.origin === "colleague" && repo?.colleaguePrs === "off") return prView(me, pr);

  const a = pr.analysis;
  if (!a || a.status === "running" || a.sha !== pr.headSha) {
    const issues = a?.issues ?? [];
    pr.analysis = {
      sha: pr.headSha,
      status: "done",
      summary: a?.summary ?? "",
      risk: a?.risk ?? "low",
      issues,
      at: now(),
    };
    if (issues.length > 0) {
      publishAlert({
        kind: "pr.analysis_issues",
        projectId: pr.projectId,
        objectCode: `${pr.repo}#${pr.number}`,
        title: "Problems in a pull request",
        body: `The analysis of ${shortRepo(pr.repo)}#${pr.number} found ${issues.length} problems.`,
        link: prHref(projectCodeOf(pr.projectId), pr.id),
        mandatory: authorMandatory(pr),
      });
    }
    return prView(me, pr);
  }

  if (pr.origin === "colleague" && stateOfPr(pr).canAutoCorrect) {
    pr.corrections.push({
      id: newId("pcor"),
      trigger: "auto",
      byId: null,
      fromSha: pr.headSha,
      state: "running",
      commitSha: null,
      why: a.issues[0]?.title ?? "",
      at: now(),
    });
  }
  return prView(me, pr);
}
