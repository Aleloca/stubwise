import {
  agentSessions,
  aiJobs,
  automationRunInputs,
  automationRuns,
  automations,
  backlogItems,
  chatChannels,
  claudeConversationProjects,
  deletedProjectMembers,
  deletedProjects,
  docAutoUpdateJobs,
  docChatSessions,
  docChunks,
  docGenerationJobs,
  docGenerations,
  docNodes,
  docPageCodes,
  docPages,
  driveFiles,
  environmentServers,
  graphJobs,
  nightlyItems,
  prCorrections,
  prReleaseNotes,
  prReviewJobs,
  prReviews,
  projectEnvFiles,
  projectEnvironments,
  projectMembers,
  projects,
  releases,
  repositories,
  roles,
  servers,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import type { ArchivedProjectRow, ArchivedProjectView, ArchivePreview, BusyReason, DeletionCounts, DeletionPreview, ProjectPermission } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { projectPermissionsMap } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { OPEN_RUN_STATUSES } from "../automations/runs.js";
import { LIVE_HEARTBEAT_SECONDS, visibleTo } from "./agent-sessions.js";
import { recordChange } from "./change-log.js";
import { personName } from "./people.js";
import { projectObject, SWITCHES } from "./project-settings-log.js";

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
    readonly status: 400 | 403 | 409,
    readonly code: "busy" | "already_archived" | "not_archived" | "code_mismatch" | "forbidden",
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

// ---------------------------------------------------------------------------
// Le letture di un archiviato (Task 4): per i membri di allora e i full admin.
// ---------------------------------------------------------------------------

/**
 * Gli archiviati che `viewer` vede, coi suoi permessi lì: quelli in cui ne
 * era membro, tutti per un full admin. È la regola di «chi lo legge di
 * proposito» (`archivedProjectIdsFor` del prototipo), in UN posto.
 */
export async function archivedPermissionsFor(db: Db, viewer: Viewer): Promise<Map<string, ReadonlySet<ProjectPermission>>> {
  const [withArchived, open] = await Promise.all([
    projectPermissionsMap(db, viewer, { includeArchived: true }),
    projectPermissionsMap(db, viewer),
  ]);
  const out = new Map<string, ReadonlySet<ProjectPermission>>();
  for (const [id, perms] of Object.entries(withArchived)) if (!(id in open)) out.set(id, new Set(perms));
  return out;
}

async function rowsFor(db: Db, viewer: Viewer, perms: Map<string, ReadonlySet<ProjectPermission>>, ids: string[]): Promise<ArchivedProjectRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ p: projects, byEmail: users.email, byName: users.displayName })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.archivedByUserId))
    .where(and(inArray(projects.id, ids), isNotNull(projects.archivedAt)))
    .orderBy(desc(projects.archivedAt), asc(projects.code));
  const fullAdmin = viewer.instancePermissions.has("instance.full_admin");
  return rows.map(({ p, byEmail, byName }) => ({
    projectId: p.id,
    code: p.code,
    name: p.name,
    clientName: p.clientName ?? null,
    archivedAt: p.archivedAt!.toISOString(),
    archivedBy: byEmail ? personName({ email: byEmail, displayName: byName }) : null,
    canReopen: perms.get(p.id)?.has("project.settings.manage") ?? false,
    canDelete: fullAdmin,
  }));
}

/** La scheda «Archived»: dal più recente. */
export async function listArchivedProjects(db: Db, viewer: Viewer): Promise<ArchivedProjectRow[]> {
  const perms = await archivedPermissionsFor(db, viewer);
  return rowsFor(db, viewer, perms, [...perms.keys()]);
}

const count = async (db: Db, from: SQL): Promise<number> => {
  const res = (await db.execute(sql`select count(*)::int as n from ${from}`)) as unknown as { rows?: { n: number }[] } & { n: number }[];
  return (res.rows ?? res)[0]?.n ?? 0;
};

/** I conteggi del progetto: COUNT nella WHERE, mai letture intere. */
export async function projectCounts(db: Db, projectId: string): Promise<DeletionCounts> {
  const repos = sql`(select r.id from ${repositories} r where r.project_id = ${projectId})`;
  const [tasks, requests, pages, conversations, channels, files, autos, envs, envFiles, rels] = await Promise.all([
    count(db, sql`${tickets} where ${tickets.projectId} = ${projectId}`),
    count(db, sql`${backlogItems} where ${backlogItems.projectId} = ${projectId}`),
    // Le pagine della generazione CORRENTE di ogni repository del progetto.
    count(db, sql`${docPages} join ${repositories} on ${repositories.id} = ${docPages.repositoryId} where ${repositories.projectId} = ${projectId} and ${docPages.generationId} = ${repositories.currentDocGenerationId}`),
    count(db, sql`${claudeConversationProjects} where ${claudeConversationProjects.projectId} = ${projectId}`),
    count(db, sql`${chatChannels} where ${chatChannels.projectId} = ${projectId}`),
    count(db, sql`${driveFiles} where ${driveFiles.projectId} = ${projectId} and ${driveFiles.deletedAt} is null`),
    count(db, sql`${automations} where ${automations.projectId} = ${projectId}`),
    count(db, sql`${projectEnvironments} where ${projectEnvironments.projectId} = ${projectId}`),
    count(db, sql`${projectEnvFiles} where ${projectEnvFiles.repositoryId} in ${repos}`),
    count(db, sql`${releases} where ${releases.projectId} = ${projectId}`),
  ]);
  return { tasks, requests, docPages: pages, conversations, channels, driveFiles: files, automations: autos, environments: envs, envFiles, releases: rels };
}

/** I nomi dei repository del progetto, in ordine alfabetico. */
export async function projectRepositoryNames(db: Db, projectId: string): Promise<string[]> {
  return (await db.select({ name: repositories.name }).from(repositories).where(eq(repositories.projectId, projectId)).orderBy(asc(repositories.name))).map((r) => r.name);
}

/** La pagina dell'archiviato; `null` per chi non lo vede da archiviato (o per un progetto aperto). */
export async function archivedProjectView(db: Db, viewer: Viewer, projectId: string): Promise<ArchivedProjectView | null> {
  const perms = await archivedPermissionsFor(db, viewer);
  if (!perms.has(projectId)) return null;
  const [row] = await rowsFor(db, viewer, perms, [projectId]);
  if (!row) return null;
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  const members = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName, role: roles.name })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(and(eq(projectMembers.projectId, projectId), eq(users.isAgent, false)));
  const switches = Object.fromEntries(SWITCHES.map(([column, name]) => [name, p![column] === true])) as ArchivedProjectView["switchesOnReopen"];
  return {
    ...row,
    description: p!.description ?? "",
    members: members
      .map((m) => ({ personId: m.id, name: personName(m), role: m.role }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    counts: await projectCounts(db, projectId),
    repositories: await projectRepositoryNames(db, projectId),
    switchesOnReopen: switches,
    pulseEveryDays: p!.pulseEveryDays,
  };
}

// ---------------------------------------------------------------------------
// Elimina (Task 5): solo un archiviato, solo un full admin.
// ---------------------------------------------------------------------------

/** I server che resterebbero senza ambienti: li usano SOLO ambienti del progetto (R-L7). */
async function orphanServers(db: Db, projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ number: servers.number })
    .from(servers)
    .innerJoin(environmentServers, eq(environmentServers.serverId, servers.id))
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
    .where(
      and(
        eq(projectEnvironments.projectId, projectId),
        sql`not exists (
          select 1 from ${environmentServers} es2
          join ${projectEnvironments} pe2 on pe2.id = es2.environment_id
          where es2.server_id = ${servers.id} and pe2.project_id <> ${projectId}
        )`,
      ),
    )
    .orderBy(asc(servers.number));
  return rows.map((r) => `SRV-${r.number}`);
}

export async function deletionPreview(db: Db, projectId: string): Promise<DeletionPreview> {
  const [row] = await db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId));
  if (!row?.archivedAt) throw new ArchiveError(409, "not_archived", "Only an archived project can be deleted");
  return {
    counts: await projectCounts(db, projectId),
    orphanServers: await orphanServers(db, projectId),
    detachedRepositories: await projectRepositoryNames(db, projectId),
  };
}

/**
 * Stacca i repository del progetto (L-2, il prototipo `purge.ts`): tengono
 * nome, account, comandi, grafo e storia dei commit; perdono i Docs, le PR
 * (review, correzioni, note di rilascio), il giro notturno e i file
 * d'ambiente; il webhook va riconfigurato. Rilasci, ambienti e task se ne
 * vanno col progetto (cascata).
 */
async function detachRepositories(tx: Db, projectId: string): Promise<number> {
  const repos = (await tx.select({ id: repositories.id }).from(repositories).where(eq(repositories.projectId, projectId))).map((r) => r.id);
  if (repos.length === 0) return 0;
  // In SQL: un ciclo tipato su quattordici tabelle Drizzle fa esplodere il typecheck.
  const ids = sql`array[${sql.join(repos.map((id) => sql`${id}::uuid`), sql`, `)}]`;
  // Anche i job del grafo ancora in coda (review F6): senza progetto finirebbero `failed`.
  const leafFirst: PgTable[] = [docChatSessions, docChunks, docNodes, docPageCodes, docPages, docGenerationJobs, docAutoUpdateJobs, docGenerations, prCorrections, prReleaseNotes, prReviewJobs, prReviews, nightlyItems, projectEnvFiles, graphJobs];
  for (const table of leafFirst) await tx.execute(sql`delete from ${table} where repository_id = any(${ids})`);
  await tx
    .update(repositories)
    .set({ detachedAt: new Date(), detachedFromProjectId: projectId, currentDocGenerationId: null, webhookConfiguredAt: null })
    .where(inArray(repositories.id, repos));
  return repos.length;
}

/**
 * Elimina un archiviato. Nella transazione, col progetto FOR UPDATE: il
 * codice scritto esatto, la memoria del progetto (codice, nome, membri:
 * `deleted_projects`), i repository staccati, le chiavi dello storage da
 * togliere dopo il commit, la cancellazione (le cascate fanno il resto) e la
 * voce `project.deleted` d'istanza.
 */
export async function deleteArchivedProject(
  db: Db,
  viewer: Viewer,
  projectId: string,
  confirmCode: string,
  storageKeysOf: (tx: Db, projectId: string) => Promise<string[]>,
): Promise<{ storageKeys: string[] }> {
  if (!viewer.instancePermissions.has("instance.full_admin")) throw new ArchiveError(403, "forbidden", "Only a full admin can delete a project");
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!row) throw new Error(`progetto ${projectId} sparito sotto il lock`);
    if (!row.archivedAt) throw new ArchiveError(409, "not_archived", "Only an archived project can be deleted");
    if (confirmCode !== row.code) throw new ArchiveError(400, "code_mismatch", "The code does not match the project's code");
    const storageKeys = await storageKeysOf(tx, projectId);
    await tx.insert(deletedProjects).values({ id: row.id, code: row.code, name: row.name });
    const formerMembers = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, projectId), eq(users.isAgent, false)));
    if (formerMembers.length > 0) {
      await tx.insert(deletedProjectMembers).values(formerMembers.map((m) => ({ projectId: row.id, userId: m.userId })));
    }
    const detached = await detachRepositories(tx, projectId);
    await tx.delete(projects).where(eq(projects.id, projectId));
    await recordChange(tx, {
      type: "project.deleted",
      actor: viewer,
      projectId: null,
      // L'etichetta la risolve la lettura (`CODICE · Nome` a chi lo conosceva).
      data: { object: { type: "project", id: row.id, label: "" }, params: { detachedRepositories: String(detached) } },
    });
    return { storageKeys };
  });
}
