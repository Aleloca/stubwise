import {
  aiJobs,
  aiProviders,
  aiUsageSnapshots,
  automationRuns,
  automations,
  nightlyItems,
  prReviews,
  productDocJobs,
  projects,
  repositories,
  serverFixes,
  servers,
  tickets,
  users,
  workerHeartbeats,
  type Db,
} from "@stubwise/db";
import { aiBudgetState, CLOSED_TICKET_STATUSES } from "@stubwise/notifications";
import { type AiBlockView, type InstanceJob, type InstanceStatus } from "@stubwise/shared";
import { and, desc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { projectPermissionsMap } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";

/**
 * Area 9, F4: lo Stato dell'istanza. Cosa sta facendo Stubwise adesso, nei
 * progetti che chi guarda vede (`visibleProjectIds` per via di
 * `projectPermissionsMap`): i lavori di Claude in corso, in attesa e falliti
 * negli ultimi 7 giorni, i worker dall'heartbeat, la quota, gli errori, il
 * giro notturno, la pausa di ogni coda. R-G5: un lavoro di un progetto che
 * chi guarda non vede sta solo nei conteggi di `otherProjects`.
 *
 * SOLO letture: nessuna azione su un server, un ambiente o un processo
 * (CLAUDE.md, «Stubwise non fa deploy»). Il rilancio (Task 6) passa da
 * `startRun`; qui si calcola solo se è possibile (`retryCheck`).
 */

export const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKER_ACTIVE_MS = 2 * 60_000;
const MAX_ERRORS = 5;
const QUOTA_NEAR_PCT = 80;

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type Perms = ReadonlySet<string>;

/** Il fatto di un job fallito che decide il Retry (Task 6 lo rilegge dal DB, con la stessa funzione). */
export interface RetryFacts {
  status: string;
  isCorrection: boolean;
  finishedAt: Date | null;
  ticketClosed: boolean;
  /** Un job più recente sulla stessa task: null se non c'è; `live` se non è finito. */
  newer: { live: boolean } | null;
}

const LIVE_STATUSES = new Set(["queued", "triaging", "fixing", "held", "awaiting_plan_approval", "awaiting_input"]);

/** La disponibilità del Retry di un job, per chi guarda: UNA regola per la vista e per la rotta. */
export function retryCheck(
  facts: RetryFacts,
  perms: Perms | null,
  budgetReached: boolean,
  now: Date,
): Pick<InstanceJob, "retry" | "retryNeeds" | "retryBlock" | "retryStopsAtPlan"> & { reason: "not_retryable" | "conflict" | null } {
  const off = { retry: "unavailable" as const, retryNeeds: null, retryBlock: null, retryStopsAtPlan: false };
  // Il job è già ripartito (`startRun` ricicla l'ultimo job concluso): è in volo.
  if (LIVE_STATUSES.has(facts.status)) return { ...off, reason: "conflict" };
  const fresh = facts.finishedAt !== null && now.getTime() - facts.finishedAt.getTime() <= FAILED_WINDOW_MS;
  if (facts.status !== "failed" || facts.isCorrection || facts.ticketClosed || !fresh) return { ...off, reason: "not_retryable" };
  if (facts.newer) return { ...off, reason: facts.newer.live ? "conflict" : "not_retryable" };
  const manages = perms?.has("project.settings.manage") ?? false;
  const starts = perms?.has("runs.start") ?? false;
  if (!manages || !starts) return { retry: "forbidden", retryNeeds: manages ? "startRun" : "manageSettings", retryBlock: null, retryStopsAtPlan: false, reason: null };
  if (budgetReached) return { retry: "forbidden", retryNeeds: null, retryBlock: { reason: "monthly_budget" }, retryStopsAtPlan: false, reason: null };
  return { retry: "allowed", retryNeeds: null, retryBlock: null, retryStopsAtPlan: !(perms?.has("plans.approve") ?? false), reason: null };
}

/** La pausa della coda di un progetto come la dicono le letture: chi (col nome) e da quando. */
export type QueuePause = { byId: string | null; byName: string; since: string };

/**
 * J-6 (a), UNA regola per lo Stato dell'istanza e per la vista del lavoro di
 * una task: un job IN CODA su una coda in pausa è fermo per la pausa.
 */
export function queuedJobBlock(status: string, pause: QueuePause | null): AiBlockView | null {
  return status === "queued" && pause ? { reason: "queue_paused", byId: pause.byId, byName: pause.byName, since: pause.since } : null;
}

/** La pausa della coda di UN progetto, col nome di chi l'ha messa; null = la coda va. */
export async function queuePauseOf(db: Db, projectId: string): Promise<QueuePause | null> {
  const [p] = await db
    .select({ at: projects.queuePausedAt, by: projects.queuePausedByUserId, name: users.displayName, email: users.email })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.queuePausedByUserId))
    .where(eq(projects.id, projectId));
  return p?.at ? { byId: p.by, byName: p.name ?? p.email ?? "", since: p.at.toISOString() } : null;
}

/** La fase del giro notturno come la mostra la pagina; null = non si mostra (il daily report ha la sua pagina). */
export function nightlyPhaseOf(phase: string): "commit_summary" | "release_note" | "docs" | null {
  if (phase === "summary") return "commit_summary";
  if (phase === "release") return "release_note";
  if (phase === "page_update" || phase === "page_create") return "docs";
  return null;
}

type NightlyItemRow = { repositoryId: string; projectId: string | null; phase: string; status: string; claimedAt: Date | null; lastError: string | null; updatedAt: Date };

/** Le voci del giro notturno ridotte a UNA riga per repository e fase: fallita, in corso, in attesa, fatta. */
export function nightlyRows(items: NightlyItemRow[], now: Date, leaseMs: number) {
  const groups = new Map<string, NightlyItemRow[]>();
  for (const it of items) {
    const phase = nightlyPhaseOf(it.phase);
    if (!phase || !it.projectId) continue;
    const key = `${it.repositoryId}|${phase}`;
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [repositoryId, phase] = key.split("|") as [string, "commit_summary" | "release_note" | "docs"];
    const failed = rows.find((r) => r.status === "failed");
    const running = rows.some((r) => r.status === "pending" && r.claimedAt !== null && now.getTime() - r.claimedAt.getTime() < leaseMs);
    const waiting = rows.some((r) => r.status === "pending");
    const state = failed ? "failed" : running ? "running" : waiting ? "waiting" : "done";
    const at = rows.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), rows[0]!.updatedAt);
    return { repositoryId, projectId: rows[0]!.projectId!, phase, state, at: at.toISOString(), summary: failed?.lastError ?? null } as const;
  });
}

const NIGHTLY_LEASE_MS = 60 * 60_000;

/** Lo Stato dell'istanza per chi guarda. */
export async function instanceStatus(db: Db, viewer: Viewer, now = new Date()): Promise<InstanceStatus> {
  const permsRecord = await projectPermissionsMap(db, viewer);
  const permsMap = new Map(Object.entries(permsRecord).map(([id, list]) => [id, new Set<string>(list)]));
  // Area 9, F6: `permsMap` non ha gli archiviati, nemmeno per un full admin, e
  // un archiviato non sta nello Stato dell'istanza.
  const sees = (projectId: string | null) => projectId !== null && permsMap.has(projectId);
  const permsOf = (projectId: string | null): Perms | null => (projectId ? (permsMap.get(projectId) ?? null) : null);
  const budgetReached = (await aiBudgetState(db)).exhausted;
  const since7 = new Date(now.getTime() - FAILED_WINDOW_MS);

  // I progetti, coi nomi di chi ha messo in pausa.
  const projectRows = await db
    .select({ id: projects.id, code: projects.code, name: projects.name, pausedAt: projects.queuePausedAt, pausedBy: projects.queuePausedByUserId, pauserName: users.displayName, pauserEmail: users.email })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.queuePausedByUserId));
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const pauseOf = (projectId: string | null) => {
    const p = projectId ? projectById.get(projectId) : undefined;
    return p?.pausedAt ? { byId: p.pausedBy, byName: p.pauserName ?? p.pauserEmail ?? "", at: p.pausedAt.toISOString() } : null;
  };
  const pausedOf = (projectId: string | null): QueuePause | null => {
    const p = pauseOf(projectId);
    return p ? { byId: p.byId, byName: p.byName, since: p.at } : null;
  };
  const pausedBlock = (projectId: string | null): AiBlockView | null => queuedJobBlock("queued", pausedOf(projectId));
  const codeOf = (projectId: string | null) => (projectId ? (projectById.get(projectId)?.code ?? "") : "");

  type Raw = Omit<InstanceJob, "workerId" | "retry" | "retryNeeds" | "retryBlock" | "retryStopsAtPlan"> & { retryFacts?: RetryFacts };
  const raw: Raw[] = [];

  // 1. I job delle task (fix e correzioni): in corso, in coda, fermi, falliti negli ultimi 7 giorni.
  const jobs = await db
    .select({
      id: aiJobs.id,
      status: aiJobs.status,
      ticketId: aiJobs.ticketId,
      correctionId: aiJobs.correctionId,
      createdAt: aiJobs.createdAt,
      startedAt: aiJobs.startedAt,
      finishedAt: aiJobs.finishedAt,
      failureSummary: aiJobs.failureSummary,
      ticketTitle: tickets.title,
      ticketNumber: tickets.number,
      ticketStatus: tickets.status,
      projectId: tickets.projectId,
    })
    .from(aiJobs)
    .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
    // Un job fermo (`held`) è lavoro della coda solo se è una correzione ferma
    // (si riprende dalla task): gli altri aspettano una persona, e li dice l'inbox.
    .where(
      or(
        inArray(aiJobs.status, ["queued", "triaging", "fixing"]),
        and(eq(aiJobs.status, "held"), isNotNull(aiJobs.correctionId)),
        and(eq(aiJobs.status, "failed"), gte(aiJobs.finishedAt, since7)),
      ),
    );
  const ticketIds = [...new Set(jobs.filter((j) => j.status === "failed").map((j) => j.ticketId))];
  const laterJobs = ticketIds.length
    ? await db.select({ ticketId: aiJobs.ticketId, createdAt: aiJobs.createdAt, status: aiJobs.status }).from(aiJobs).where(inArray(aiJobs.ticketId, ticketIds))
    : [];
  const TERMINAL = new Set(["failed", "pr_opened", "pr_merged", "pr_closed", "skipped"]);
  const closed = new Set<string>(CLOSED_TICKET_STATUSES as readonly string[]);
  for (const j of jobs) {
    const code = `${codeOf(j.projectId)}-${j.ticketNumber}`;
    const kind = j.correctionId ? "correction" : "task_run";
    const state = j.status === "failed" ? "failed" : j.status === "queued" || j.status === "held" ? "waiting" : "running";
    const newer = laterJobs.filter((o) => o.ticketId === j.ticketId && o.createdAt > j.createdAt);
    raw.push({
      id: j.id,
      kind,
      projectId: j.projectId,
      projectCode: codeOf(j.projectId),
      title: j.ticketTitle,
      code,
      state,
      waiting: queuedJobBlock(j.status, pausedOf(j.projectId)),
      since: (state === "failed" ? (j.finishedAt ?? j.createdAt) : state === "running" ? (j.startedAt ?? j.createdAt) : j.createdAt).toISOString(),
      href: null,
      summary: state === "failed" ? j.failureSummary : null,
      startFailed: false,
      superseded: state === "failed" && kind === "task_run" && newer.length > 0,
      retryFacts: {
        status: j.status,
        isCorrection: kind === "correction",
        finishedAt: j.finishedAt,
        ticketClosed: closed.has(j.ticketStatus),
        newer: newer.length ? { live: newer.some((o) => !TERMINAL.has(o.status)) } : null,
      },
    });
  }

  // 2. Le esecuzioni delle automazioni di progetto ferme al passo di Claude (budget o pausa).
  const waitingRuns = await db
    .select({ id: automationRuns.id, n: automationRuns.n, title: automationRuns.title, cursor: automationRuns.cursor, dueAt: automationRuns.dueAt, startedAt: automationRuns.startedAt, code: automations.code, projectId: automations.projectId })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(eq(automationRuns.status, "running"), isNotNull(automations.projectId), sql`${automationRuns.cursor} -> 'aiWaiting' IS NOT NULL AND ${automationRuns.cursor} -> 'aiWaiting' <> 'null'::jsonb`));
  for (const r of waitingRuns) {
    const w = (r.cursor as { aiWaiting?: { reason: string; byId?: string | null; since?: string } }).aiWaiting;
    const block: AiBlockView | null = w?.reason === "monthly_budget" ? { reason: "monthly_budget", byId: null, byName: "", since: null } : w?.reason === "queue_paused" ? (pausedBlock(r.projectId) ?? { reason: "queue_paused", byId: w.byId ?? null, byName: "", since: w.since ?? now.toISOString() }) : null;
    raw.push({ id: r.id, kind: "automation", projectId: r.projectId, projectCode: codeOf(r.projectId), title: r.title, code: `${r.code} #${r.n}`, state: "waiting", waiting: block, since: (r.startedAt ?? now).toISOString(), href: null, summary: null, startFailed: false, superseded: false });
  }

  // 3. Le review delle PR in corso.
  const reviews = await db
    .select({ id: prReviews.id, prNumber: prReviews.prNumber, prTitle: prReviews.prTitle, startedAt: prReviews.startedAt, createdAt: prReviews.createdAt, projectId: repositories.projectId })
    .from(prReviews)
    .innerJoin(repositories, eq(repositories.id, prReviews.repositoryId))
    .where(and(eq(prReviews.status, "running"), isNotNull(prReviews.startedAt)));
  for (const r of reviews) {
    raw.push({ id: r.id, kind: "pr_review", projectId: r.projectId, projectCode: codeOf(r.projectId), title: r.prTitle ?? `#${r.prNumber}`, code: `#${r.prNumber}`, state: "running", waiting: null, since: (r.startedAt ?? r.createdAt).toISOString(), href: null, summary: null, startFailed: false, superseded: false });
  }

  // 4. Le correzioni dei server: la proposta in corso (una sessione aperta) o i passi in esecuzione.
  const fixes = await db
    .select({ id: serverFixes.id, status: serverFixes.status, projectId: serverFixes.projectId, updatedAt: serverFixes.updatedAt, number: servers.number, name: servers.name, sessionId: serverFixes.sessionId })
    .from(serverFixes)
    .innerJoin(servers, eq(servers.id, serverFixes.serverId))
    .where(inArray(serverFixes.status, ["running", "proposing"]));
  for (const f of fixes) {
    // `proposing` senza sessione = in coda (aspetta un worker, o la ripresa della coda).
    const queued = f.status === "proposing" && f.sessionId === null;
    raw.push({ id: f.id, kind: "server_fix", projectId: f.projectId, projectCode: codeOf(f.projectId), title: f.name, code: `SRV-${f.number}`, state: queued ? "waiting" : "running", waiting: queued ? pausedBlock(f.projectId) : null, since: f.updatedAt.toISOString(), href: null, summary: null, startFailed: false, superseded: false });
  }

  // 5. Area 11, F6, Task 4: i lavori della doc di prodotto in coda, in corso o
  // fermi (budget, pausa, quota, una sezione presa). Niente titolo: la fonte
  // (un'email, una riunione) non si nomina qui, e la riga la scrive il
  // renderer dal `kind`. Un gesto di chi l'ha chiesto (prima versione, bozza,
  // aggiornamento a mano) non si ferma sulla pausa.
  const docJobs = await db
    .select({ id: productDocJobs.id, projectId: productDocJobs.projectId, status: productDocJobs.status, heldReason: productDocJobs.heldReason, sourceKind: productDocJobs.sourceKind, createdAt: productDocJobs.createdAt, startedAt: productDocJobs.startedAt })
    .from(productDocJobs)
    .where(inArray(productDocJobs.status, ["queued", "running", "held"]));
  for (const j of docJobs) {
    const gesture = j.sourceKind === "first_version" || j.sourceKind === "wireframe" || j.sourceKind === "page_update";
    const block: AiBlockView | null =
      j.status === "running"
        ? null
        : j.heldReason === "budget" || (budgetReached && j.status === "queued")
          ? { reason: "monthly_budget", byId: null, byName: "", since: null }
          : !gesture && (j.heldReason === "paused" || j.status === "queued")
            ? pausedBlock(j.projectId)
            : null;
    raw.push({ id: j.id, kind: "product_doc_update", projectId: j.projectId, projectCode: codeOf(j.projectId), title: "", code: null, state: j.status === "running" ? "running" : "waiting", waiting: block, since: (j.status === "running" ? (j.startedAt ?? j.createdAt) : j.createdAt).toISOString(), href: null, summary: null, startFailed: false, superseded: false });
  }

  // In corso e in attesa dal più vecchio, i falliti dal più recente.
  const ORDER = { running: 0, waiting: 1, failed: 2 } as const;
  raw.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.state === "failed" ? b.since.localeCompare(a.since) : a.since.localeCompare(b.since)) || a.id.localeCompare(b.id));

  // I worker: uno slot per unità di concorrenza; un lavoro di un progetto invisibile è `hidden`, senza id.
  const beats = await db.select().from(workerHeartbeats).where(gte(workerHeartbeats.seenAt, new Date(now.getTime() - WORKER_ACTIVE_MS))).orderBy(workerHeartbeats.workerId);
  const byId = new Map(raw.map((j) => [j.id, j]));
  const workerOfJob = new Map<string, string>();
  const workers: InstanceStatus["workers"] = [];
  for (const b of beats) {
    const held = (b.running ?? []).map((r) => r.id);
    for (let i = 0; i < Math.max(b.concurrency, held.length); i++) {
      const slot = `${b.workerId}:${i + 1}`;
      const id = held[i] ?? null;
      const job = id ? byId.get(id) : undefined;
      const hidden = job !== undefined && !sees(job.projectId);
      if (job && !hidden) workerOfJob.set(job.id, slot);
      workers.push({ id: slot, jobId: job && !hidden ? job.id : null, hidden });
    }
  }

  const shown = raw.filter((j) => sees(j.projectId));
  const hidden = raw.filter((j) => !sees(j.projectId));
  const counts = (list: Raw[]) => ({
    running: list.filter((j) => j.state === "running").length,
    waiting: list.filter((j) => j.state === "waiting" && j.waiting !== null).length,
    failed: list.filter((j) => j.state === "failed").length,
  });

  const jobsView: InstanceJob[] = shown.map(({ retryFacts, ...j }) => {
    const r = retryFacts ? retryCheck(retryFacts, permsOf(j.projectId), budgetReached, now) : { retry: "unavailable" as const, retryNeeds: null, retryBlock: null, retryStopsAtPlan: false };
    return { ...j, workerId: workerOfJob.get(j.id) ?? null, retry: r.retry, retryNeeds: r.retryNeeds, retryBlock: r.retryBlock, retryStopsAtPlan: r.retryStopsAtPlan };
  });

  // Le code: i progetti visibili con lavoro o in pausa.
  const queueIds = new Set<string>([...shown.map((j) => j.projectId!), ...projectRows.filter((p) => p.pausedAt && sees(p.id)).map((p) => p.id)]);
  const queues = [...queueIds]
    .map((projectId) => {
      const p = projectById.get(projectId)!;
      const mine = shown.filter((j) => j.projectId === projectId);
      const paused = pauseOf(projectId);
      return {
        projectId,
        code: p.code,
        name: p.name,
        paused,
        ...counts(mine),
        pause: (permsOf(projectId)?.has("project.settings.manage") ? "allowed" : "forbidden") as "allowed" | "forbidden",
        budgetAfterResume: paused && budgetReached ? mine.filter((j) => j.state === "waiting" && j.waiting !== null).length : 0,
      };
    })
    .sort((a, b) => Number(b.paused !== null) - Number(a.paused !== null) || Number(b.failed > 0) - Number(a.failed > 0) || a.code.localeCompare(b.code));

  // La quota: gli account della catena; null per una chiave API o senza un campione.
  const providerRows = await db.select().from(aiProviders).orderBy(aiProviders.position, aiProviders.createdAt);
  const snaps = await db
    .selectDistinctOn([aiUsageSnapshots.providerId], { providerId: aiUsageSnapshots.providerId, session: aiUsageSnapshots.sessionRemaining, weekly: aiUsageSnapshots.weeklyRemaining, capturedAt: aiUsageSnapshots.capturedAt })
    .from(aiUsageSnapshots)
    .orderBy(aiUsageSnapshots.providerId, desc(aiUsageSnapshots.capturedAt));
  const pct = (w: unknown) => (w && typeof w === "object" && typeof (w as { percentUsed?: unknown }).percentUsed === "number" ? (w as { percentUsed: number }).percentUsed : 0);
  const quota = providerRows.map((p) => {
    const s = snaps.find((x) => x.providerId === p.id);
    const limited = p.limitedUntil !== null && p.limitedUntil > now;
    const five = s ? pct(s.session) : 0;
    const week = s ? pct(s.weekly) : 0;
    return {
      providerId: p.id,
      name: p.label,
      kind: p.kind === "account" ? "subscription" : p.kind,
      enabled: p.enabled,
      quota:
        p.kind === "account" && s
          ? { fiveHourPct: five, weeklyPct: week, readAt: s.capturedAt.toISOString(), band: limited ? ("limited" as const) : Math.max(five, week) >= QUOTA_NEAR_PCT ? ("near" as const) : ("ok" as const), limitedUntil: p.limitedUntil?.toISOString() ?? null }
          : null,
    };
  });

  const errors = jobsView
    .filter((j) => j.state === "failed")
    .slice(0, MAX_ERRORS)
    .map((j) => ({ jobId: j.id, at: j.since, summary: j.summary ?? "", startFailed: false, href: null }));

  // Il giro notturno: l'ultima notte, dei progetti visibili.
  const [{ night } = { night: null }] = (await db.select({ night: sql<string | null>`max(${nightlyItems.night})` }).from(nightlyItems)) as { night: string | null }[];
  const items = night ? await db.select().from(nightlyItems).where(eq(nightlyItems.night, night)) : [];
  const repoNames = new Map((await db.select({ id: repositories.id, name: repositories.name }).from(repositories)).map((r) => [r.id, r.name]));
  const nightly = nightlyRows(items, now, NIGHTLY_LEASE_MS)
    .filter((r) => sees(r.projectId))
    .map((r) => ({ id: `${r.repositoryId}:${r.phase}`, projectId: r.projectId, projectCode: codeOf(r.projectId), repositoryName: repoNames.get(r.repositoryId) ?? "", phase: r.phase, state: r.state, at: r.at, summary: r.summary }));

  return {
    queues,
    otherProjects: hidden.length > 0 ? counts(hidden) : null,
    jobs: jobsView,
    workers,
    quota,
    errors,
    nightly,
    refreshedAt: now.toISOString(),
  };
}

/**
 * Task 6: i fatti di UN job per il rilancio, letti dal DB con le stesse regole
 * della vista (`retryCheck` decide). null se il job non c'è.
 */
export async function retryFactsOf(db: Db, jobId: string): Promise<(RetryFacts & { ticketId: string; projectId: string; code: string }) | null> {
  const [j] = await db
    .select({ status: aiJobs.status, correctionId: aiJobs.correctionId, finishedAt: aiJobs.finishedAt, createdAt: aiJobs.createdAt, ticketId: aiJobs.ticketId, ticketStatus: tickets.status, ticketNumber: tickets.number, projectId: tickets.projectId, projectCode: projects.code })
    .from(aiJobs)
    .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(aiJobs.id, jobId));
  if (!j) return null;
  // Il confronto nel DB (microsecondi), mai con una data di JS (millisecondi).
  const later = await db
    .select({ status: aiJobs.status })
    .from(aiJobs)
    .where(and(eq(aiJobs.ticketId, j.ticketId), ne(aiJobs.id, jobId), sql`${aiJobs.createdAt} > (SELECT created_at FROM ai_jobs WHERE id = ${jobId})`));
  const TERMINAL = new Set(["failed", "pr_opened", "pr_merged", "pr_closed", "skipped"]);
  return {
    status: j.status,
    isCorrection: j.correctionId !== null,
    finishedAt: j.finishedAt,
    ticketClosed: (CLOSED_TICKET_STATUSES as readonly string[]).includes(j.ticketStatus),
    newer: later.length ? { live: later.some((o) => !TERMINAL.has(o.status)) } : null,
    ticketId: j.ticketId,
    projectId: j.projectId,
    code: `${j.projectCode}-${j.ticketNumber}`,
  };
}
