import {
  agentQuestions,
  agentSessions,
  aiJobs,
  aiProviders,
  prCorrections,
  prReviews,
  projectDecisions,
  repositories,
  planDigest,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import {
  actorAllows,
  canResumeCorrection,
  correctionActionAllowed,
  derivePrCycle,
  IN_FLIGHT_JOB_STATUSES,
  stateAllows,
} from "@stubwise/notifications";
import type { AiJobStatus, ProjectPermission, TaskWorkView } from "@stubwise/shared";
import { and, asc, eq, isNull, like, sql } from "drizzle-orm";

/**
 * Il lavoro di Claude su una task per la sezione Claude dell'app nuova
 * (integrazione area 3, fetta 3a): i campi che `GET /api/tasks/:id/work`
 * aggiunge al riassunto della fetta 1. Tutto in LETTURA.
 *
 * Le regole restano dove sono, e qui si CHIAMANO:
 * - vedere le sessioni chiede `repos.view` nel progetto (ruling R26,
 *   `docs/invariants/permissions.md`): senza, `runs` è vuoto e `hiddenRuns`
 *   dice che ce ne sono;
 * - le AZIONI (`start`, `relaunch`, `resume`, `requestChanges`) seguono le
 *   precondizioni delle scritture — `startRun` (`services/jobs.ts`: niente in
 *   volo, la task `review` non si avvia, una correzione ferma si riprende e
 *   NON si rilancia) e `derivePrCycle` (`canRequestCorrection`, `canResume`,
 *   coi permessi di chi guarda) — e i loro permessi (`runs.start`,
 *   `corrections.request`). `forbidden` = lo stato lo consente ma chi guarda
 *   no; `unavailable` = lo stato non lo consente. Il client le LEGGE
 *   (`docs/invariants/pr-corrections.md`, «il client non lo deduce»);
 * - `waitsOnViewer`: la domanda con `actorAllows`/`stateAllows` (le stesse di
 *   `answerQuestion`), il piano con `plans.approve` (il gate);
 * - `blocked` è sempre `null`: un avvio a mano scavalca il budget
 *   (`manualTrigger: true` in `startRun`), e il server non ha la «coda in
 *   pausa» del prototipo.
 */

type Extras = Omit<TaskWorkView, "claude" | "pullRequests" | "webHref">;
type Run = Extras["runs"][number];
type Availability = Extras["actions"]["start"];

const IN_FLIGHT: ReadonlySet<string> = new Set(IN_FLIGHT_JOB_STATUSES);

function runState(status: AiJobStatus): Run["state"] {
  switch (status) {
    case "queued":
    case "triaging":
    case "fixing":
      return "working";
    case "awaiting_input":
      return "awaiting_answer";
    case "awaiting_plan_approval":
      return "awaiting_approval";
    case "held":
      return "idle";
    default:
      return "finished";
  }
}

function runOutcome(status: AiJobStatus): Run["outcome"] {
  switch (status) {
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
      return "ok";
    case "failed":
      return "failed";
    case "skipped":
      return "stopped";
    default:
      return null;
  }
}

/** `owner/repo` dall'URL di una PR, altrimenti il nome della repository. */
function repoOf(prUrl: string | null, repoName: string): string {
  const match = prUrl ? /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\//.exec(prUrl) : null;
  return match?.[1] ?? repoName;
}

const pick = (allowedByState: boolean, permitted: boolean): Availability =>
  !allowedByState ? "unavailable" : permitted ? "allowed" : "forbidden";

/** Tutti i permessi di progetto: per chiedere a una regola «lo stato lo consentirebbe?». */
const EVERYONE: ReadonlySet<ProjectPermission> = new Set([
  "plans.approve",
  "prs.adopt",
  "runs.start",
  "corrections.request",
] as ProjectPermission[]);

export async function loadTaskWorkExtras(
  db: Db,
  input: { ticketId: string; viewerId: string; permissions: ReadonlySet<ProjectPermission> },
): Promise<Extras> {
  const { ticketId, viewerId, permissions } = input;
  const [ticket] = await db
    .select({ projectId: tickets.projectId, type: tickets.type, planApprovedDigest: tickets.planApprovedDigest })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  const [jobs, prRows, decisionRows, [repoCount]] = await Promise.all([
    db
      .select({
        id: aiJobs.id,
        status: aiJobs.status,
        createdAt: aiJobs.createdAt,
        startedAt: aiJobs.startedAt,
        requestedByUserId: aiJobs.requestedByUserId,
        correctionId: aiJobs.correctionId,
        heldReason: aiJobs.heldReason,
        planText: aiJobs.planText,
        planSummary: aiJobs.planSummary,
        failureSummary: aiJobs.failureSummary,
        cancelRequestedAt: aiJobs.cancelRequestedAt,
        providerKind: aiProviders.kind,
        providerLabel: aiProviders.label,
        sessionId: agentSessions.id,
        correctionPr: prCorrections.prNumber,
        correctionRepoName: repositories.name,
      })
      .from(aiJobs)
      .leftJoin(aiProviders, eq(aiProviders.id, aiJobs.providerId))
      .leftJoin(agentSessions, eq(agentSessions.aiJobId, aiJobs.id))
      .leftJoin(prCorrections, eq(prCorrections.id, aiJobs.correctionId))
      .leftJoin(repositories, eq(repositories.id, prCorrections.repositoryId))
      .where(eq(aiJobs.ticketId, ticketId))
      .orderBy(asc(aiJobs.createdAt), asc(aiJobs.id)),
    db
      .select({
        repositoryId: ticketRepositories.repositoryId,
        prUrl: ticketRepositories.prUrl,
        prNumber: ticketRepositories.prNumber,
        prState: ticketRepositories.prState,
        createdAt: ticketRepositories.createdAt,
        repoName: repositories.name,
      })
      .from(ticketRepositories)
      .innerJoin(repositories, eq(repositories.id, ticketRepositories.repositoryId))
      .where(and(eq(ticketRepositories.ticketId, ticketId), sql`${ticketRepositories.prNumber} is not null`))
      .orderBy(asc(ticketRepositories.id)),
    db
      .select({
        decidedById: projectDecisions.decidedByUserId,
        decidedAt: projectDecisions.decidedAt,
        decision: projectDecisions.decision,
        sourceRef: projectDecisions.sourceRef,
      })
      .from(projectDecisions)
      .where(
        and(
          eq(projectDecisions.ticketId, ticketId),
          eq(projectDecisions.source, "plan_review"),
          like(projectDecisions.sourceKey, "plan_review:%"),
        ),
      )
      .orderBy(asc(projectDecisions.decidedAt), asc(projectDecisions.id)),
    ticket
      ? db.select({ n: sql<number>`count(*)::int` }).from(repositories).where(eq(repositories.projectId, ticket.projectId))
      : Promise.resolve([{ n: 0 }]),
  ]);

  // I job il cui piano ha una decisione APPROVATA nel registro (`execute`).
  const approvedJobs = new Set(
    decisionRows.flatMap((d) => {
      const ref = (d.sourceRef ?? {}) as { jobId?: unknown; mode?: unknown };
      return ref.mode === "execute" && typeof ref.jobId === "string" ? [ref.jobId] : [];
    }),
  );
  /**
   * Lo stato del piano di un job, SOLO da un esito che si può verificare:
   * in attesa sul gate → `pending`; una decisione approvata per quel job nel
   * registro, o un job che ha ESEGUITO (è uscito dal gate verso il fix) →
   * `approved`; il digest della pre-approvazione del ticket uguale a quello del
   * piano → `pre_approved`; altrimenti `undecided` (fermo, annullato sul gate,
   * fallito prima di eseguire: nessuno l'ha deciso).
   */
  const planStatus = (j: (typeof jobs)[number]): NonNullable<Run["plan"]>["status"] => {
    if (j.status === "awaiting_plan_approval") return "pending";
    if (approvedJobs.has(j.id)) return "approved";
    if (j.status === "fixing" || j.status === "pr_opened" || j.status === "pr_merged" || j.status === "pr_closed") return "approved";
    if (j.planText && ticket?.planApprovedDigest && ticket.planApprovedDigest === planDigest(j.planText)) return "pre_approved";
    return "undecided";
  };
  const canSeeRuns = permissions.has("repos.view");
  const runs: Run[] = canSeeRuns
    ? jobs.map((j) => ({
        id: j.id,
        sessionId: j.sessionId ?? null,
        ownerId: j.requestedByUserId,
        createdAt: j.createdAt.toISOString(),
        state: runState(j.status),
        outcome: runOutcome(j.status),
        kind: j.correctionId ? ("correction" as const) : ("fix" as const),
        pr:
          j.correctionPr !== null && j.correctionRepoName !== null
            ? { repo: repoOf(prRows.find((p) => p.prNumber === j.correctionPr)?.prUrl ?? null, j.correctionRepoName), number: j.correctionPr }
            : null,
        provider: j.providerKind && j.providerLabel ? { kind: j.providerKind, name: j.providerLabel } : null,
        failureSummary: j.failureSummary,
        heldReason: j.heldReason,
        cancelRequested: j.cancelRequestedAt !== null && (j.status === "triaging" || j.status === "fixing"),
        // Il piano vive col job (`plan_text`, azzerato al rifiuto); lo stato
        // lo dice `planStatus`, mai per esclusione.
        plan: j.planText
          ? {
              text: j.planText,
              summary: j.planSummary ?? "",
              status: planStatus(j),
              digest: planDigest(j.planText),
              at: (j.startedAt ?? j.createdAt).toISOString(),
            }
          : null,
      }))
    : [];

  // --- PR: eventi, fatti, «Chiedi modifiche» -------------------------------
  const prs = prRows.map((p) => ({ ...p, repo: repoOf(p.prUrl, p.repoName), number: p.prNumber! }));
  const prEvents: Extras["prEvents"] = prs.flatMap((p): Extras["prEvents"] => {
    const opened: Extras["prEvents"][number] = { id: `${p.repositoryId}:${p.number}:opened`, kind: "pr_opened", at: p.createdAt.toISOString(), number: p.number, repo: p.repo };
    // Merge e chiusura non hanno una data affidabile (limite dichiarato della
    // storia del ticket): l'evento c'è, all'istante dell'apertura.
    if (p.prState === "merged") return [opened, { ...opened, id: `${p.repositoryId}:${p.number}:merged`, kind: "pr_merged" }];
    if (p.prState === "closed_unmerged") return [opened, { ...opened, id: `${p.repositoryId}:${p.number}:closed`, kind: "pr_closed" }];
    return [opened];
  });
  const cycles = await Promise.all(
    prs.map(async (p) => ({
      pr: p,
      viewer: await derivePrCycle(db, { ticketId, repositoryId: p.repositoryId, viewerPermissions: permissions }),
      anyone: await derivePrCycle(db, { ticketId, repositoryId: p.repositoryId, viewerPermissions: EVERYONE }),
    })),
  );
  // La data vera dell'ultima review completata di ogni PR (il ciclo dice il verdetto).
  const reviewRows = prs.length
    ? await db
        .select({
          repositoryId: prReviews.repositoryId,
          prNumber: prReviews.prNumber,
          at: sql<Date>`coalesce(${prReviews.finishedAt}, ${prReviews.createdAt})`,
        })
        .from(prReviews)
        .where(and(eq(prReviews.ticketId, ticketId), eq(prReviews.status, "completed")))
        .orderBy(asc(prReviews.createdAt))
    : [];
  const reviewedAt = new Map<string, string>();
  for (const r of reviewRows) reviewedAt.set(`${r.repositoryId}#${r.prNumber}`, new Date(r.at).toISOString());
  const reviewAt = (p: (typeof prs)[number]) =>
    reviewedAt.get(`${p.repositoryId}#${p.number}`) ?? p.createdAt.toISOString();
  const prFacts: Extras["prFacts"] = cycles
    .filter((c) => c.viewer !== null)
    .map(({ pr, viewer }) => ({
      repo: pr.repo,
      number: pr.number,
      review:
        viewer!.state === "approved"
          ? { verdict: "approved" as const, at: reviewAt(pr), byId: null, on: "stubwise" as const }
          : viewer!.state === "changes_requested" || viewer!.state === "stopped_at_cap"
            ? {
                verdict: "changes_requested" as const,
                at: viewer!.lastRequest?.at ?? pr.createdAt.toISOString(),
                byId: null,
                on: viewer!.lastRequest?.via === "provider" ? ("platform" as const) : ("stubwise" as const),
              }
            : viewer!.state === "reviewing"
              ? { verdict: "pending" as const, at: pr.createdAt.toISOString(), byId: null, on: "stubwise" as const }
              : null,
      branchProtected: viewer!.blockedReason === "adopted_branch_protected",
      queued: viewer!.pendingRequest,
    }));
  const correctionCap = cycles.find((c) => c.viewer !== null)?.viewer?.maxRounds ?? 3;
  const requestChangesPerPr: Extras["requestChangesPerPr"] = cycles.map(({ pr, viewer, anyone }) => ({
    repo: pr.repo,
    number: pr.number,
    availability: pick(
      anyone?.canRequestCorrection === true,
      viewer?.canRequestCorrection === true && permissions.has("corrections.request"),
    ),
  }));
  const requestByState = cycles.some((c) => c.anyone?.canRequestCorrection === true);
  const requestByViewer = cycles.some((c) => c.viewer?.canRequestCorrection === true) && permissions.has("corrections.request");

  // --- azioni sull'ultimo job (quello che `startRun` legge) ----------------
  const latest = jobs.at(-1);
  const runnable = ticket?.type !== "review";
  const heldCorrection = latest !== undefined && latest.correctionId !== null && latest.status === "held";
  const canStart = permissions.has("runs.start");
  let resume: Availability = "unavailable";
  if (heldCorrection) {
    const held = cycles.find((c) => c.anyone?.heldJobId === latest.id);
    const reason = latest.heldReason ?? "other";
    const byState = held ? held.anyone!.canResume : canResumeCorrection(reason, EVERYONE);
    const byViewer = held
      ? held.viewer?.canResume === true
      : canResumeCorrection(reason, permissions) && correctionActionAllowed(permissions, { adoptedAt: null, adoptionReleasedAt: null });
    resume = pick(byState, canStart && byViewer);
  }
  const actions: Extras["actions"] = {
    start: pick(latest === undefined && runnable, canStart),
    relaunch: pick(latest !== undefined && !IN_FLIGHT.has(latest.status) && !heldCorrection && runnable, canStart),
    resume,
    requestChanges: pick(requestByState, requestByViewer),
  };

  // --- Claude aspetta chi guarda? ------------------------------------------
  let waitsOnViewer = false;
  if (latest?.status === "awaiting_plan_approval") {
    waitsOnViewer = permissions.has("plans.approve");
  } else if (latest?.status === "awaiting_input") {
    const [open] = await db
      .select({ id: agentQuestions.id })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.jobId, latest.id), isNull(agentQuestions.answeredAt)))
      .limit(1);
    waitsOnViewer =
      open !== undefined &&
      actorAllows({ kind: "job.awaiting_input", requestedByUserId: latest.requestedByUserId }, "answer", { id: viewerId, permissions }) &&
      stateAllows("job.awaiting_input", "answer", latest.status);
  }

  return {
    runs,
    hiddenRuns: !canSeeRuns && jobs.length > 0,
    prEvents,
    prFacts,
    correctionCap,
    planDecisions: decisionRows.map((d) => {
      const ref = (d.sourceRef ?? {}) as { mode?: unknown; digest?: unknown };
      // `execute` (approvato) o la pre-approvazione (che ha il digest); `fix` = rifiutato con indicazioni.
      const approved = ref.mode === "execute" || typeof ref.digest === "string";
      return {
        decidedById: d.decidedById,
        decidedAt: d.decidedAt.toISOString(),
        decision: d.decision,
        status: approved ? ("approved" as const) : ("rejected" as const),
      };
    }),
    software: (repoCount?.n ?? 0) > 0,
    openPr: prs.some((p) => p.prState === "open"),
    waitsOnViewer,
    actions,
    requestChangesPerPr,
    blocked: null,
  };
}
