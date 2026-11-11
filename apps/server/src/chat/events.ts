import { backlogItems, chatMessages, milestones, projectBriefs, projects, repositories, ticketRepositories, tickets, type Db } from "@stubwise/db";
import type { ChatEventView } from "@stubwise/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { ChatViewer } from "./access.js";
import { citeablesFor } from "./citations.js";

type MessageRow = typeof chatMessages.$inferSelect;

/**
 * La scheda degli eventi dei progetti (fetta 4), derivata a lettura per chi
 * guarda: il messaggio salvato ha solo il tipo e l'oggetto (li scrivono i
 * trigger della 0141). Le regole sono quelle delle citazioni (`citeablesFor`):
 * - task e richiesta: il codice esce sempre (come una citazione invisibile),
 *   il titolo solo a chi vede l'oggetto;
 * - traguardo e brief: dal progetto, che chi legge un canale di progetto vede;
 * - la PR (numero, URL, repository) solo a chi vede la task: l'URL porta il
 *   branch, il numero la ritrova sulla piattaforma;
 * - un oggetto che non c'è più: `object` null, la scheda dice solo il tipo.
 * `release_page` non ha ancora una fonte (area 8): resta senza oggetto.
 */
export async function eventViews(db: Db, viewer: ChatViewer, rows: readonly MessageRow[]): Promise<Map<string, ChatEventView>> {
  const out = new Map<string, ChatEventView>();
  const evented = rows.filter((r) => r.kind === "system" && r.eventKind !== null && r.eventRefKind !== null && r.eventRefId !== null);
  if (evented.length === 0) return out;
  const idsOf = (kind: string) => [...new Set(evented.filter((r) => r.eventRefKind === kind).map((r) => r.eventRefId!))];

  const taskIds = idsOf("task");
  const requestIds = idsOf("request");
  const milestoneIds = idsOf("milestone");
  const briefIds = idsOf("brief");

  const taskRows =
    taskIds.length > 0
      ? await db
          .select({ id: tickets.id, projectId: tickets.projectId, title: tickets.title, code: sql<string>`${projects.code} || '-' || ${tickets.number}` })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(inArray(tickets.id, taskIds))
      : [];
  const requestRows =
    requestIds.length > 0
      ? await db
          .select({
            id: backlogItems.id,
            projectId: backlogItems.projectId,
            title: backlogItems.title,
            code: sql<string>`${projects.code} || '-R' || ${backlogItems.number}`,
          })
          .from(backlogItems)
          .innerJoin(projects, eq(projects.id, backlogItems.projectId))
          .where(inArray(backlogItems.id, requestIds))
      : [];
  const milestoneRows =
    milestoneIds.length > 0
      ? await db.select({ id: milestones.id, projectId: milestones.projectId, name: milestones.name }).from(milestones).where(inArray(milestones.id, milestoneIds))
      : [];
  const briefRows =
    briefIds.length > 0
      ? await db
          .select({ id: projectBriefs.id, projectId: projectBriefs.projectId, start: projectBriefs.periodStart, end: projectBriefs.periodEnd })
          .from(projectBriefs)
          .where(inArray(projectBriefs.id, briefIds))
      : [];
  const prIds = [...new Set(evented.flatMap((r) => (r.eventPrId ? [r.eventPrId] : [])))];
  const prRows =
    prIds.length > 0
      ? await db
          .select({ id: ticketRepositories.id, number: ticketRepositories.prNumber, url: ticketRepositories.prUrl, repository: repositories.name })
          .from(ticketRepositories)
          .innerJoin(repositories, eq(repositories.id, ticketRepositories.repositoryId))
          .where(inArray(ticketRepositories.id, prIds))
      : [];

  // Chi guarda cosa vede: task e richieste con le loro regole, i progetti di traguardi e brief.
  const seen = await citeablesFor(db, viewer, [
    ...taskRows.map((r) => ({ kind: "task" as const, id: r.id })),
    ...requestRows.map((r) => ({ kind: "request" as const, id: r.id })),
    ...[...new Set([...milestoneRows, ...briefRows].map((r) => r.projectId))].map((id) => ({ kind: "project" as const, id })),
  ]);
  const sees = (kind: "task" | "request" | "project", id: string) => seen.has(`${kind}:${id}`);

  type Obj = NonNullable<ChatEventView["object"]>;
  const objects = new Map<string, Obj>();
  for (const r of taskRows) {
    const visible = sees("task", r.id);
    objects.set(`task:${r.id}`, { label: r.code, title: visible ? r.title : null, visible, projectId: r.projectId });
  }
  for (const r of requestRows) {
    const visible = sees("request", r.id);
    objects.set(`request:${r.id}`, { label: r.code, title: visible ? r.title : null, visible, projectId: r.projectId });
  }
  for (const r of milestoneRows) {
    const visible = sees("project", r.projectId);
    objects.set(`milestone:${r.id}`, { label: visible ? r.name : "", title: null, visible, projectId: r.projectId });
  }
  for (const r of briefRows) {
    const visible = sees("project", r.projectId);
    objects.set(`brief:${r.id}`, { label: `${r.start}/${r.end}`, title: null, visible, projectId: r.projectId });
  }
  const prOf = new Map(prRows.map((p) => [p.id, p]));

  for (const r of evented) {
    const object = objects.get(`${r.eventRefKind}:${r.eventRefId}`) ?? null;
    const pr = r.eventPrId && r.eventRefKind === "task" && object?.visible ? prOf.get(r.eventPrId) : undefined;
    out.set(r.id, {
      kind: r.eventKind!,
      ref: { kind: r.eventRefKind!, id: r.eventRefId! },
      object,
      pr: pr ? { number: pr.number, url: pr.url, repository: pr.repository } : null,
    });
  }
  return out;
}
