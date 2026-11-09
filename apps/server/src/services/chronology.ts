import { projectBriefs, projectDecisions, projects, tickets, type Db } from "@stubwise/db";
import {
  briefHeadline,
  buildProjectTimeline,
  type TimelineViewer,
} from "@stubwise/notifications";
import type { ChronologyEvent, ChronologyPage, ProjectTimelineEntry, WeeklyBriefView } from "@stubwise/shared";
import { and, desc, eq, inArray, min, sql } from "drizzle-orm";

/**
 * La cronologia dell'Overview e l'attività del portafoglio dell'app nuova
 * (integrazione area 2, fetta 4), sopra la timeline di progetto del server
 * (`buildProjectTimeline` di `@stubwise/notifications`, la stessa della
 * Roadmap del web vecchio, coi suoi permessi di lettura). Qui solo:
 * - la PAGINA: 28 giorni all'indietro da `before` (escluso), con l'inizio
 *   incluso — l'intervallo è semiaperto e il filtro sta sullo stesso `at`, così
 *   un evento al bordo sta in una pagina sola;
 * - i kind e la forma del prototipo (la mappa è nel docblock di
 *   `schemas/overview.ts`);
 * - `nextBefore`: l'inizio della pagina se prima c'è ancora storia.
 */

export const CHRONOLOGY_PAGE_DAYS = 28;
const PAGE_MS = CHRONOLOGY_PAGE_DAYS * 86_400_000;

/** Il numero di una pull request dal suo URL (`…/pull/123`); undefined se non si legge. */
function prNumberOf(url: string): number | undefined {
  const match = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
  return match ? Number(match[1]) : undefined;
}

/** Una voce della timeline del server nella forma del prototipo; null se il prototipo non ha quel kind. */
export function toChronologyEvent(e: ProjectTimelineEntry): ChronologyEvent | null {
  switch (e.kind) {
    case "ticket_opened":
      return { kind: "task_opened", at: e.at, taskId: e.id };
    case "ticket_done":
      return { kind: "task_closed", at: e.at, taskId: e.ticketId };
    case "milestone_due":
      return { kind: "milestone", at: e.at, milestoneId: e.id };
    case "milestone_closed":
      return null;
    case "pr_opened":
    case "pr_merged":
    case "pr_closed": {
      const number = prNumberOf(e.prUrl);
      return { kind: e.kind, at: e.at, prId: e.id, taskId: e.ticketId, ...(number !== undefined ? { number } : {}) };
    }
    case "report_day":
      return { kind: "daily_report", at: e.at, reportId: e.id, summary: e.summary };
    case "decision":
      return { kind: "decision", at: e.at, decisionId: e.id, title: e.title };
    case "brief":
      return { kind: "brief", at: e.at, briefId: e.id, headline: e.headline ?? "" };
  }
}

/** L'istante più vecchio da cui un progetto può avere storia: la sua nascita, o un ticket o una decisione più vecchi. */
async function historyStartOf(db: Db, projectIds: string[]): Promise<Date | null> {
  if (projectIds.length === 0) return null;
  const [[p], [t], [d]] = await Promise.all([
    db.select({ at: min(projects.createdAt) }).from(projects).where(inArray(projects.id, projectIds)),
    db.select({ at: min(tickets.createdAt) }).from(tickets).where(inArray(tickets.projectId, projectIds)),
    db
      .select({ at: min(projectDecisions.decidedAt) })
      .from(projectDecisions)
      .where(inArray(projectDecisions.projectId, projectIds)),
  ]);
  const ats = [p?.at, t?.at, d?.at].filter((x): x is Date => x instanceof Date);
  return ats.length ? new Date(Math.min(...ats.map((x) => x.getTime()))) : null;
}

const byNewest = (a: ChronologyEvent, b: ChronologyEvent) => b.at.localeCompare(a.at);

async function pageEvents(
  db: Db,
  projectId: string,
  viewer: TimelineViewer,
  from: Date,
  before: Date,
): Promise<ChronologyEvent[]> {
  const entries = await buildProjectTimeline(db, projectId, { from, to: before }, undefined, viewer);
  const fromIso = from.toISOString();
  const beforeIso = before.toISOString();
  return entries
    .map(toChronologyEvent)
    .filter((e): e is ChronologyEvent => e !== null && e.at >= fromIso && e.at < beforeIso);
}

/** Una pagina della cronologia di un progetto. Senza `before`, la prima: fino a ora, più i traguardi futuri. */
export async function projectChronology(
  db: Db,
  projectId: string,
  viewer: TimelineViewer,
  before: Date | undefined,
  now: Date = new Date(),
): Promise<ChronologyPage> {
  const end = before ?? new Date(now.getTime() + 1);
  const from = new Date(end.getTime() - PAGE_MS);
  const events = await pageEvents(db, projectId, viewer, from, end);
  if (!before) {
    const future = await buildProjectTimeline(
      db,
      projectId,
      { from: end, to: new Date("9999-12-31T00:00:00Z") },
      new Set(["milestone_due"]),
      viewer,
    );
    for (const e of future) {
      const view = toChronologyEvent(e);
      if (view) events.push(view);
    }
  }
  const start = await historyStartOf(db, [projectId]);
  return {
    events: events.sort(byNewest),
    nextBefore: start && start.getTime() < from.getTime() ? from.toISOString() : null,
  };
}

/**
 * L'attività di tutti i progetti visibili, a pagine come la cronologia, col
 * progetto accanto. Solo ciò che è già successo: i traguardi futuri non sono
 * attività. Ogni progetto coi PERMESSI di chi guarda in quel progetto.
 */
export async function portfolioActivity(
  db: Db,
  viewerId: string,
  permissionsByProject: Record<string, readonly string[]>,
  before: Date | undefined,
  now: Date = new Date(),
): Promise<ChronologyPage> {
  const end = before ?? new Date(now.getTime() + 1);
  const from = new Date(end.getTime() - PAGE_MS);
  const projectIds = Object.keys(permissionsByProject);
  const pages = await Promise.all(
    projectIds.map(async (projectId) =>
      (
        await pageEvents(db, projectId, { userId: viewerId, permissions: new Set(permissionsByProject[projectId]) }, from, end)
      ).map((e) => ({ ...e, projectId })),
    ),
  );
  const start = await historyStartOf(db, projectIds);
  return {
    events: pages.flat().sort(byNewest),
    nextBefore: start && start.getTime() < from.getTime() ? from.toISOString() : null,
  };
}

/**
 * Il brief più recente PRONTO (`done` e con testo) nella forma dell'Overview:
 * `headline` è la stessa riga della card d'inbox e della roadmap
 * (`briefHeadline`), `summary` il markdown intero o le sezioni ricomposte.
 */
export async function latestWeeklyBrief(db: Db, projectId: string): Promise<WeeklyBriefView | null> {
  const [row] = await db
    .select()
    .from(projectBriefs)
    .where(
      and(
        eq(projectBriefs.projectId, projectId),
        eq(projectBriefs.status, "done"),
        sql`(${projectBriefs.summary} is not null or ${projectBriefs.sections} is not null)`,
      ),
    )
    .orderBy(desc(projectBriefs.periodEnd), desc(projectBriefs.createdAt))
    .limit(1);
  if (!row) return null;
  const summary = row.summary ?? Object.values(row.sections ?? {}).join("\n\n");
  return {
    id: row.id,
    projectId: row.projectId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    headline: briefHeadline(row.sections, row.summary) ?? "",
    summary,
    createdAt: row.createdAt.toISOString(),
    generated: true,
  };
}
