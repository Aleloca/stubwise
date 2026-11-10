import { backlogItemRequesters, backlogItemTickets, backlogItems, projects, type Db } from "@stubwise/db";
import { REQUEST_EXCERPT_LENGTH, sizeFromEffort, type ProjectRequestSummary, type ProjectRequestView } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { projectIdsWithPermission } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { backlogVisibleSql } from "./backlog-visibility.js";

/**
 * Le richieste dell'app nuova (integrazione area 2, fetta 4) sopra le voci
 * del backlog: la vista `ProjectRequest` del prototipo, caricata in blocco (una
 * query per lista, non una per riga). Chi le vede: la regola di
 * `backlog.view_all` (senza, solo quelle di cui si è richiedenti), nei progetti
 * visibili — la stessa di `GET /api/backlog`.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

/** La condizione di visibilità delle voci per chi guarda (oltre al progetto, che decide l'accesso). */
export async function requestVisibility(db: Db, viewer: Viewer): Promise<SQL | undefined> {
  return backlogVisibleSql(await projectIdsWithPermission(db, viewer, "backlog.view_all"), viewer.id);
}

type Level = "low" | "medium" | "high";
const levelOf = (urgency: string | null): { level: Level | null; urgent: boolean } =>
  urgency === "urgent" ? { level: "high", urgent: true } : { level: (urgency as Level | null) ?? null, urgent: false };

const COMMON = {
  id: backlogItems.id,
  number: backlogItems.number,
  projectId: backlogItems.projectId,
  projectCode: projects.code,
  title: backlogItems.title,
  status: backlogItems.status,
  effort: backlogItems.effort,
  risk: backlogItems.risk,
  riskNote: backlogItems.riskNote,
  urgency: backlogItems.urgency,
  similarToId: backlogItems.similarToId,
  mergedIntoId: backlogItems.mergedIntoId,
  suggested: backlogItems.suggested,
  createdAt: backlogItems.createdAt,
};

/** I testi interi: solo il dettaglio. */
const FULL = {
  document: backlogItems.document,
  originContent: backlogItems.originContent,
  implementationPlan: backlogItems.implementationPlan,
};

/** Al posto dei testi, nell'elenco: l'estratto lo taglia Postgres, così il documento non esce dal DB. */
const BRIEF = {
  excerpt: sql<string>`left(coalesce(${backlogItems.originContent}, ${backlogItems.document}), ${REQUEST_EXCERPT_LENGTH})`,
  hasDesign: sql<boolean>`${backlogItems.originContent} is not null`,
  hasPlan: sql<boolean>`${backlogItems.implementationPlan} is not null`,
};

type CommonRow = {
  id: string;
  number: number;
  projectId: string;
  projectCode: string;
  title: string;
  status: ProjectRequestView["status"];
  effort: number | null;
  risk: ProjectRequestView["risk"];
  riskNote: string | null;
  urgency: string | null;
  similarToId: string | null;
  mergedIntoId: string | null;
  suggested: (typeof backlogItems.$inferSelect)["suggested"];
  createdAt: Date;
};
type CommonView = Omit<ProjectRequestView, "description" | "design" | "plan">;

/** Le parti comuni a elenco e dettaglio, caricate in blocco: richiedenti, task nate, codice della fusa. */
async function decorate<R extends CommonRow>(db: Db, rows: R[]): Promise<{ row: R; view: CommonView }[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const mergedIds = [...new Set(rows.flatMap((r) => (r.mergedIntoId ? [r.mergedIntoId] : [])))];
  const [requesters, links, merged] = await Promise.all([
    db
      .select({ itemId: backlogItemRequesters.itemId, userId: backlogItemRequesters.userId })
      .from(backlogItemRequesters)
      .where(inArray(backlogItemRequesters.itemId, ids))
      .orderBy(asc(backlogItemRequesters.requestedAt), asc(backlogItemRequesters.userId)),
    db
      .select({ itemId: backlogItemTickets.itemId, ticketId: backlogItemTickets.ticketId })
      .from(backlogItemTickets)
      .where(inArray(backlogItemTickets.itemId, ids)),
    mergedIds.length
      ? db
          .select({ id: backlogItems.id, number: backlogItems.number, code: projects.code })
          .from(backlogItems)
          .innerJoin(projects, eq(projects.id, backlogItems.projectId))
          .where(inArray(backlogItems.id, mergedIds))
      : Promise.resolve([]),
  ]);
  const group = <T extends { itemId: string }, V>(list: T[], pick: (t: T) => V) => {
    const out = new Map<string, V[]>();
    for (const x of list) out.set(x.itemId, [...(out.get(x.itemId) ?? []), pick(x)]);
    return out;
  };
  const requestersOf = group(requesters, (r) => r.userId);
  const tasksOf = group(links, (l) => l.ticketId);
  const codeOf = new Map(merged.map((m) => [m.id, `${m.code}-R${m.number}`]));
  return rows.map((r) => {
    const urgency = levelOf(r.urgency);
    const suggested = r.suggested;
    const suggestedUrgency = suggested?.urgency ? levelOf(suggested.urgency).level : undefined;
    const view: CommonView = {
      id: r.id,
      code: `${r.projectCode}-R${r.number}`,
      projectId: r.projectId,
      title: r.title,
      requesterIds: requestersOf.get(r.id) ?? [],
      status: r.status,
      urgency: urgency.level,
      urgent: urgency.urgent,
      size: sizeFromEffort(r.effort),
      risk: r.risk,
      riskNote: r.riskNote,
      similarToId: r.similarToId,
      mergedIntoId: r.mergedIntoId,
      mergedIntoCode: r.mergedIntoId ? (codeOf.get(r.mergedIntoId) ?? null) : null,
      taskIds: tasksOf.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
      suggestions: suggested
        ? {
            ...(suggestedUrgency ? { urgency: suggestedUrgency } : {}),
            ...(suggested.effort != null ? { size: sizeFromEffort(suggested.effort)! } : {}),
            ...(suggested.risk ? { risk: suggested.risk } : {}),
            ...(suggested.riskNote ? { riskNote: suggested.riskNote } : {}),
            reason: suggested.reason ?? "",
          }
        : null,
      webHref: `/backlog/${r.id}`,
    };
    return { row: r, view };
  });
}

const whereAll = (conditions: (SQL | undefined)[]) => and(...conditions.filter((c): c is SQL => c !== undefined));
const newestFirst = [desc(backlogItems.createdAt), desc(backlogItems.id)];

/** Le richieste che rispondono a `conditions` (già filtrate per visibilità), dalla più recente, coi testi interi. */
export async function loadRequestViews(db: Db, conditions: (SQL | undefined)[]): Promise<ProjectRequestView[]> {
  const rows = await db
    .select({ ...COMMON, ...FULL })
    .from(backlogItems)
    .innerJoin(projects, eq(projects.id, backlogItems.projectId))
    .where(whereAll(conditions))
    .orderBy(...newestFirst);
  return (await decorate(db, rows)).map(({ row, view }) => ({
    ...view,
    // Quando un design ha sostituito il corpo, il corpo originale è la richiesta.
    description: row.originContent ?? row.document,
    design: row.originContent !== null ? row.document : null,
    plan: row.implementationPlan,
  }));
}

/** Come {@link loadRequestViews}, per l'ELENCO: un estratto al posto dei testi interi. */
export async function loadRequestSummaries(db: Db, conditions: (SQL | undefined)[]): Promise<ProjectRequestSummary[]> {
  const rows = await db
    .select({ ...COMMON, ...BRIEF })
    .from(backlogItems)
    .innerJoin(projects, eq(projects.id, backlogItems.projectId))
    .where(whereAll(conditions))
    .orderBy(...newestFirst);
  return (await decorate(db, rows)).map(({ row, view }) => ({
    ...view,
    excerpt: row.excerpt,
    hasDesign: row.hasDesign,
    hasPlan: row.hasPlan,
  }));
}

/** Una richiesta per id, se chi guarda la vede. */
export async function requestView(db: Db, viewer: Viewer, id: string): Promise<ProjectRequestView | null> {
  const [view] = await loadRequestViews(db, [eq(backlogItems.id, id), await requestVisibility(db, viewer)]);
  return view ?? null;
}
