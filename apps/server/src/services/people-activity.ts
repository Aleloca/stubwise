import {
  backlogItemRequesters,
  backlogItems,
  comments,
  commitSummaries,
  decisionRequests,
  departmentMembers,
  gitIdentities,
  projectDecisions,
  projectStatuses,
  projects,
  repositories,
  ticketEvents,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { legacyFamilyOf, ticketStatusSchema, type PersonDayActivityView } from "@stubwise/shared";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { inProjects, projectIdsWithPermission, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { backlogVisibleSql } from "./backlog-visibility.js";
import { personName } from "./people.js";

/**
 * L'attività del giorno per persona (integrazione area 3, fetta 3d: lo
 * standup), aggregata sul server — decisione del maintainer — dai fatti già
 * registrati, nella forma `PersonDayActivity` del prototipo
 * (`listPeopleActivity` di `apps/desktop/src/renderer/data/api.ts`). Il
 * permesso (`people.activity.view`) lo dichiara la rotta.
 *
 * Il GIORNO è nel fuso Europe/Rome, in SQL (`AT TIME ZONE`), come la
 * settimana corrente (`docs/invariants/tasks.md`).
 *
 * Visibilità: ogni fatto passa dalla regola di lettura della sua cosa, non
 * solo dal progetto, perché lo standup mostra titoli e testi:
 * - task, loro eventi, commenti e risposte alle richieste di decisione: la
 *   task visibile (`tickets.view_all` nel progetto, o chi l'ha chiesta);
 * - registro decisioni: il progetto visibile;
 * - richieste: `backlog.view_all` nel progetto, o chi ne è richiedente;
 * - commit: `repos.view` nel progetto.
 *
 * Attribuzione come il prototipo: una task CHIUSA va all'assegnataria (o a chi
 * l'ha chiesta), uno spostamento a chi l'ha fatto, una richiesta al primo
 * richiedente, un commit alla persona con la stessa email (altrimenti una riga
 * senza persona, col nome dell'autore).
 *
 * Limiti dichiarati: il server non tiene le task eliminate (`tasksDeleted`
 * vuoto) né dice se un cambio l'ha fatto Claude per una persona (`viaClaude`
 * falso).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type Row = PersonDayActivityView;

/** Lo username GitHub di un'email noreply (`123+login@users.noreply.github.com` o `login@…`), altrimenti null. */
function githubUsernameOf(email: string): string | null {
  const match = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email);
  return match?.[1] ?? null;
}

// Un INTERVALLO sulla colonna, non una funzione della colonna (review
// dell'area 3, punto 7): `[mezzanotte di Roma del giorno, mezzanotte del
// giorno dopo)`, così un indice su `created_at` resta usabile. Le due
// mezzanotti le calcola Postgres nel fuso, quindi un giorno di 23 o 25 ore
// (cambio dell'ora) resta giusto.
const onDay = (column: AnyColumn | SQL, date: string) =>
  sql`(${column} >= (${date}::date::timestamp at time zone 'Europe/Rome') and ${column} < ((${date}::date + 1)::timestamp at time zone 'Europe/Rome'))`;

export async function peopleActivity(db: Db, viewer: Viewer, date: string, departmentId?: string): Promise<Row[]> {
  const [visible, viewAll, backlogAll, reposView] = await Promise.all([
    visibleProjectIds(db, viewer),
    projectIdsWithPermission(db, viewer, "tickets.view_all"),
    projectIdsWithPermission(db, viewer, "backlog.view_all"),
    projectIdsWithPermission(db, viewer, "repos.view"),
  ]);
  const ticketVisible = and(
    inProjects(tickets.projectId, visible),
    viewAll === "all" ? undefined : or(inProjects(tickets.projectId, viewAll), eq(tickets.requestedByUserId, viewer.id)),
  );
  const taskCols = {
    taskId: tickets.id,
    number: tickets.number,
    title: tickets.title,
    projectId: tickets.projectId,
    projectCode: projects.code,
  };

  const [events, commentRows, logRows, answerRows, requestRows, commitRows] = await Promise.all([
    db
      .select({
        ...taskCols,
        id: ticketEvents.id,
        kind: ticketEvents.kind,
        payload: ticketEvents.payload,
        at: ticketEvents.createdAt,
        actorId: ticketEvents.actorId,
        assigneeId: tickets.assigneeId,
        requestedBy: tickets.requestedByUserId,
      })
      .from(ticketEvents)
      .innerJoin(tickets, eq(tickets.id, ticketEvents.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(
        and(
          inArray(ticketEvents.kind, ["status_changed", "planned_week_changed"]),
          onDay(ticketEvents.createdAt, date),
          ticketVisible,
        ),
      )
      .orderBy(asc(ticketEvents.createdAt), asc(ticketEvents.id)),
    db
      .select({ ...taskCols, id: comments.id, body: comments.body, at: comments.createdAt, authorId: comments.authorId })
      .from(comments)
      .innerJoin(tickets, eq(tickets.id, comments.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(
        and(
          eq(comments.authorType, "user"),
          isNotNull(comments.authorId),
          isNull(comments.deletedAt),
          onDay(comments.createdAt, date),
          ticketVisible,
        ),
      )
      .orderBy(asc(comments.createdAt), asc(comments.id)),
    db
      .select({
        id: projectDecisions.id,
        projectId: projectDecisions.projectId,
        taskId: projectDecisions.ticketId,
        title: projectDecisions.title,
        at: projectDecisions.decidedAt,
        by: projectDecisions.decidedByUserId,
      })
      .from(projectDecisions)
      .where(
        and(
          isNotNull(projectDecisions.decidedByUserId),
          onDay(projectDecisions.decidedAt, date),
          inProjects(projectDecisions.projectId, visible),
        ),
      ),
    db
      .select({
        ...taskCols,
        id: decisionRequests.id,
        question: decisionRequests.question,
        at: decisionRequests.answeredAt,
        by: decisionRequests.answeredByUserId,
      })
      .from(decisionRequests)
      .innerJoin(tickets, eq(tickets.id, decisionRequests.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(
        and(
          isNotNull(decisionRequests.answeredByUserId),
          isNull(decisionRequests.withdrawnAt),
          onDay(decisionRequests.answeredAt, date),
          ticketVisible,
        ),
      ),
    db
      .select({
        id: backlogItems.id,
        number: backlogItems.number,
        title: backlogItems.title,
        projectId: backlogItems.projectId,
        projectCode: projects.code,
        at: backlogItems.createdAt,
        firstRequester: sql<string | null>`(
          select r.user_id from ${backlogItemRequesters} r where r.item_id = ${backlogItems.id}
          order by r.requested_at, r.user_id limit 1
        )`,
      })
      .from(backlogItems)
      .innerJoin(projects, eq(projects.id, backlogItems.projectId))
      .where(
        and(
          onDay(backlogItems.createdAt, date),
          inProjects(backlogItems.projectId, visible),
          backlogVisibleSql(backlogAll, viewer.id),
        ),
      ),
    db
      .select({
        sha: commitSummaries.sha,
        repo: repositories.name,
        projectId: repositories.projectId,
        authorName: commitSummaries.authorName,
        authorEmail: commitSummaries.authorEmail,
        message: commitSummaries.subject,
        aiSummary: commitSummaries.summary,
        at: commitSummaries.committedAt,
      })
      .from(commitSummaries)
      .innerJoin(repositories, eq(repositories.id, commitSummaries.repositoryId))
      .where(
        and(
          onDay(commitSummaries.committedAt, date),
          inProjects(repositories.projectId, visible),
          inProjects(repositories.projectId, reposView),
        ),
      )
      .orderBy(asc(commitSummaries.committedAt), asc(commitSummaries.sha)),
  ]);

  // Stati per nome (e famiglia) dei progetti degli eventi: UNA query.
  const statusProjects = [...new Set(events.map((e) => e.projectId))];
  const statuses = statusProjects.length
    ? await db
        .select({
          id: projectStatuses.id,
          projectId: projectStatuses.projectId,
          name: projectStatuses.name,
          family: projectStatuses.family,
          legacy: projectStatuses.legacyStatus,
          position: projectStatuses.position,
        })
        .from(projectStatuses)
        .where(inArray(projectStatuses.projectId, statusProjects))
        .orderBy(asc(projectStatuses.position))
    : [];
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const statusName = (projectId: string, id: unknown, legacy: unknown): string | null => {
    if (typeof id === "string" && statusById.has(id)) return statusById.get(id)!.name;
    if (typeof legacy === "string") return statuses.find((s) => s.projectId === projectId && s.legacy === legacy)?.name ?? legacy;
    return null;
  };
  const closesTask = (payload: Record<string, unknown>): boolean => {
    const id = payload["toStatusId"];
    if (typeof id === "string" && statusById.has(id)) return statusById.get(id)!.family === "closed";
    const legacy = ticketStatusSchema.safeParse(payload["to"]);
    return legacy.success && legacyFamilyOf(legacy.data) === "closed";
  };

  const rows = new Map<string, Row>();
  const row = (personId: string | null, name = "", authorEmail: string | null = null): Row => {
    // Senza persona la riga è per EMAIL (due autori omonimi restano distinti).
    const key = personId ?? `unlinked:${authorEmail ?? name}`;
    let entry = rows.get(key);
    if (!entry) {
      entry = {
        personId,
        name,
        authorEmail: personId ? null : authorEmail,
        authorUsername: personId || !authorEmail ? null : githubUsernameOf(authorEmail),
        departmentIds: [],
        tasksClosed: [],
        tasksMoved: [],
        tasksDeleted: [],
        comments: [],
        decisions: [],
        requestsCreated: [],
        commits: [],
      };
      rows.set(key, entry);
    }
    return entry;
  };
  const code = (r: { projectCode: string; number: number }) => `${r.projectCode}-${r.number}`;

  const closedOnce = new Set<string>();
  for (const e of events) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const ref = { taskId: e.taskId, code: code(e), title: e.title, projectId: e.projectId, at: e.at.toISOString() };
    if (e.actorId) {
      const status = e.kind === "status_changed";
      row(e.actorId).tasksMoved.push({
        ...ref,
        field: status ? "status" : "week",
        from: status ? statusName(e.projectId, payload["fromStatusId"], payload["from"]) : ((payload["from"] as string | null) ?? null),
        to: status ? statusName(e.projectId, payload["toStatusId"], payload["to"]) : ((payload["to"] as string | null) ?? null),
        viaClaude: false,
      });
    }
    const owner = e.assigneeId ?? e.requestedBy;
    if (e.kind === "status_changed" && owner && closesTask(payload) && !closedOnce.has(e.taskId)) {
      closedOnce.add(e.taskId);
      row(owner).tasksClosed.push(ref);
    }
  }
  for (const c of commentRows) {
    row(c.authorId!).comments.push({
      id: c.id,
      taskId: c.taskId,
      code: code(c),
      projectId: c.projectId,
      body: c.body,
      at: c.at.toISOString(),
      viaClaude: false,
    });
  }
  for (const d of logRows) {
    row(d.by!).decisions.push({ id: d.id, source: "log", projectId: d.projectId, taskId: d.taskId, title: d.title, at: d.at.toISOString() });
  }
  for (const d of answerRows) {
    row(d.by!).decisions.push({ id: d.id, source: "answer", projectId: d.projectId, taskId: d.taskId, title: d.question, at: d.at!.toISOString() });
  }
  for (const r of requestRows) {
    if (!r.firstRequester) continue;
    row(r.firstRequester).requestsCreated.push({
      requestId: r.id,
      code: `${r.projectCode}-R${r.number}`,
      title: r.title,
      projectId: r.projectId,
      at: r.at.toISOString(),
    });
  }
  // Un commit va alla persona con la stessa email — quella dell'account, o una
  // collegata a lei («Link a person», `git_identities`) —; altrimenti una riga
  // senza persona, con l'email da collegare.
  const emails = [...new Set(commitRows.map((c) => c.authorEmail.toLowerCase()))];
  const [accountRows, identityRows] = emails.length
    ? await Promise.all([
        db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(inArray(sql`lower(${users.email})`, emails), eq(users.isAgent, false))),
        db
          .select({ id: gitIdentities.userId, email: gitIdentities.email })
          .from(gitIdentities)
          .where(inArray(sql`lower(${gitIdentities.email})`, emails)),
      ])
    : [[], []];
  const byEmail = new Map<string, string>();
  for (const r of identityRows) byEmail.set(r.email.toLowerCase(), r.id);
  // L'email dell'account vince su un alias (lo stesso indirizzo non può essere di due persone).
  for (const r of accountRows) byEmail.set(r.email.toLowerCase(), r.id);
  for (const c of commitRows) {
    const authorId = byEmail.get(c.authorEmail.toLowerCase()) ?? null;
    row(authorId, c.authorName, c.authorEmail.toLowerCase()).commits.push({
      sha: c.sha,
      repo: c.repo,
      authorId,
      authorName: c.authorName,
      message: c.message,
      aiSummary: c.aiSummary,
      at: c.at.toISOString(),
      projectId: c.projectId,
    });
  }

  // Nomi e reparti delle persone: UNA query ciascuno.
  const personIds = [...rows.values()].flatMap((r) => (r.personId ? [r.personId] : []));
  if (personIds.length > 0) {
    const [people, memberships] = await Promise.all([
      db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, personIds)),
      db
        .select({ userId: departmentMembers.userId, departmentId: departmentMembers.departmentId })
        .from(departmentMembers)
        .where(inArray(departmentMembers.userId, personIds))
        .orderBy(asc(departmentMembers.position), asc(departmentMembers.departmentId)),
    ]);
    const nameOf = new Map(people.map((p) => [p.id, personName(p)]));
    for (const r of rows.values()) {
      if (!r.personId) continue;
      r.name = nameOf.get(r.personId) ?? r.name;
      r.departmentIds = memberships.filter((m) => m.userId === r.personId).map((m) => m.departmentId);
    }
  }

  return [...rows.values()]
    .filter((r) => !departmentId || r.departmentIds.includes(departmentId))
    .sort((a, b) => a.name.localeCompare(b.name));
}
