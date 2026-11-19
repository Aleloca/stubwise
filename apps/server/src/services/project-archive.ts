import {
  agentSessions,
  aiJobs,
  automationRunInputs,
  automationRuns,
  automations,
  docGenerations,
  prReviews,
  projects,
  releases,
  repositories,
  tickets,
  type Db,
} from "@stubwise/db";
import type { ArchivePreview, BusyReason, ProjectPermission } from "@stubwise/shared";
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { OPEN_RUN_STATUSES } from "../automations/runs.js";
import { LIVE_HEARTBEAT_SECONDS, visibleTo } from "./agent-sessions.js";
import { recordChange } from "./change-log.js";
import { projectObject } from "./project-settings-log.js";

/**
 * Area 9, F6 (D-8): archivia e riapri un progetto (`design §F6`, il prototipo
 * `projectSettings/archive.ts`).
 *
 * - Archiviare non tocca interruttori, appartenenze, notifiche né fissati:
 *   riaprendo tutto torna com'era, perché niente è stato riscritto. Cosa
 *   sparisce lo decide la lettura (`projectPermissionsFor`, `ProjectScope`).
 * - Lo impedisce solo il lavoro IN ESECUZIONE (L-5 = a): un job dell'agente
 *   che triagia o corregge, una review di PR in corso, una sessione dal vivo,
 *   una generazione Docs in corso o in pausa, un rilascio con le run non
 *   concluse. Il lavoro fermo in attesa di una persona riparte riaprendo.
 * - Le esecuzioni aperte delle automazioni del progetto si annullano con la
 *   ragione «Project archived» (il prototipo, domanda 4 (a) del 31 ott
 *   2026): l'annullamento è un input di controllo che l'esecutore applica
 *   sotto il suo lease, come «Annulla».
 */

type Viewer = Pick<SessionUser, "id" | "email" | "role" | "instancePermissions">;

export class ArchiveError extends Error {
  constructor(
    readonly status: 409,
    readonly code: "busy" | "already_archived" | "not_archived",
    message: string,
    readonly reasons: BusyReason[] = [],
  ) {
    super(message);
  }
}

/** I job che fanno lavorare l'agente adesso (non quelli in coda o in attesa di una persona). */
const RUNNING_JOB_STATUSES = ["triaging", "fixing"] as const;

/** I kind delle sessioni già contati dalle loro tabelle (job, review, generazione Docs). */
const COUNTED_SESSION_KINDS = ["ai_job", "pr_review", "doc_generation"] as const;

/**
 * Le ragioni di `busy`, viste da chi chiede: una sessione che non vede ha
 * codice e titolo `null`. `db` può essere una transazione (si ricontrolla
 * sotto il lock del progetto).
 */
export async function busyReasons(
  db: Db,
  projectId: string,
  viewer: Viewer,
  permissions: ReadonlySet<ProjectPermission>,
): Promise<BusyReason[]> {
  const reasons: BusyReason[] = [];
  const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  const code = project?.code ?? "";

  // I job dell'agente al lavoro: il ticket, se chi archivia lo vede.
  const jobs = await db
    .select({ number: tickets.number, title: tickets.title, requestedBy: tickets.requestedByUserId })
    .from(aiJobs)
    .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
    .where(and(eq(tickets.projectId, projectId), inArray(aiJobs.status, [...RUNNING_JOB_STATUSES])))
    .orderBy(asc(tickets.number));
  for (const j of jobs) {
    const seen = permissions.has("tickets.view_all") || j.requestedBy === viewer.id;
    reasons.push({ kind: "claude_session", code: seen ? `${code}-${j.number}` : null, title: seen ? j.title : null, waiting: false, repository: null, paused: false });
  }

  // Le review di PR in corso sui repository del progetto.
  const reviews = await db
    .select({ prNumber: prReviews.prNumber, prTitle: prReviews.prTitle })
    .from(prReviews)
    .innerJoin(repositories, eq(repositories.id, prReviews.repositoryId))
    .where(and(eq(repositories.projectId, projectId), eq(prReviews.status, "running")))
    .orderBy(asc(prReviews.prNumber));
  for (const r of reviews) {
    const seen = permissions.has("repos.view");
    reasons.push({ kind: "claude_session", code: null, title: seen ? `#${r.prNumber} ${r.prTitle}` : null, waiting: false, repository: null, paused: false });
  }

  // Le altre sessioni dal vivo del progetto (conversazioni, refinement…),
  // con la visibilità delle sessioni in UN posto (`visibleTo`).
  const live = await db
    .select({ title: agentSessions.title, seen: sql<boolean>`${visibleTo(viewer)}` })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        notInArray(agentSessions.kind, [...COUNTED_SESSION_KINDS]),
        sql`cardinality(${agentSessions.liveSegmentIds}) > 0`,
        sql`${agentSessions.heartbeatAt} > now() - make_interval(secs => ${LIVE_HEARTBEAT_SECONDS}::int)`,
      ),
    )
    .orderBy(asc(agentSessions.startedAt));
  for (const s of live) {
    reasons.push({ kind: "claude_session", code: null, title: s.seen ? s.title : null, waiting: false, repository: null, paused: false });
  }

  // Le generazioni Docs vive (in pausa compresa: una pausa per limite è viva).
  const gens = await db
    .select({ repository: repositories.name, status: docGenerations.status })
    .from(docGenerations)
    .innerJoin(repositories, eq(repositories.id, docGenerations.repositoryId))
    .where(and(eq(repositories.projectId, projectId), inArray(docGenerations.status, ["running", "paused"])))
    .orderBy(asc(repositories.name));
  for (const g of gens) {
    reasons.push({ kind: "doc_generation", code: null, title: null, waiting: false, repository: g.repository, paused: g.status === "paused" });
  }

  // I rilasci con le run non concluse.
  const rel = await db
    .select({ code: releases.code })
    .from(releases)
    .where(and(eq(releases.projectId, projectId), isNull(releases.runsSettledAt)))
    .orderBy(asc(releases.code));
  for (const r of rel) reasons.push({ kind: "release", code: r.code, title: null, waiting: false, repository: null, paused: false });
  return reasons;
}

/** Le esecuzioni aperte delle automazioni del progetto: quelle che archiviare annulla. */
function openRunsWhere(projectId: string) {
  return and(eq(automations.projectId, projectId), inArray(automationRuns.status, [...OPEN_RUN_STATUSES]));
}

export async function archivePreview(
  db: Db,
  projectId: string,
  viewer: Viewer,
  permissions: ReadonlySet<ProjectPermission>,
): Promise<ArchivePreview> {
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(openRunsWhere(projectId));
  return { openAutomationRuns: open?.n ?? 0, busy: await busyReasons(db, projectId, viewer, permissions) };
}

/**
 * Archivia. Nella transazione, col progetto FOR UPDATE: si ricontrolla lo
 * stato e `busy` (due archiviazioni insieme: la seconda trova l'archiviato),
 * si accoda l'annullamento delle esecuzioni aperte, si scrivono le colonne e
 * la voce.
 */
export async function archiveProject(
  db: Db,
  viewer: Viewer,
  projectId: string,
  permissions: ReadonlySet<ProjectPermission>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!row) throw new Error(`progetto ${projectId} sparito sotto il lock`);
    if (row.archivedAt) throw new ArchiveError(409, "already_archived", "The project is already archived");
    const busy = await busyReasons(tx as unknown as Db, projectId, viewer, permissions);
    if (busy.length > 0) throw new ArchiveError(409, "busy", "Claude is working on this project, or a release is in progress", busy);
    const open = await tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(openRunsWhere(projectId));
    if (open.length > 0) {
      await tx.insert(automationRunInputs).values(
        open.map((r) => ({ runId: r.id, input: { control: "cancel", byId: viewer.id, reason: "project_archived" }, byId: viewer.id })),
      );
    }
    await tx.update(projects).set({ archivedAt: new Date(), archivedByUserId: viewer.id }).where(eq(projects.id, projectId));
    await recordChange(tx, { type: "project.archived", actor: viewer, projectId, data: { object: projectObject(row) } });
  });
}

/** Riapre: azzera le due colonne, e tutto il resto si rilegge com'era. */
export async function reopenProject(db: Db, viewer: Viewer, projectId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!row) throw new Error(`progetto ${projectId} sparito sotto il lock`);
    if (!row.archivedAt) throw new ArchiveError(409, "not_archived", "The project is not archived");
    await tx.update(projects).set({ archivedAt: null, archivedByUserId: null }).where(and(eq(projects.id, projectId), isNotNull(projects.archivedAt)));
    await recordChange(tx, { type: "project.reopened", actor: viewer, projectId, data: { object: projectObject(row) } });
  });
}
