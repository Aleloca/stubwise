import { backlogItemTickets, backlogItems, backlogJobs, productPages, productRequestOrigins, projects, tickets, type Db } from "@stubwise/db";
import { backlogCandidatesOf, productBlockSchema, type ProductBacklogCandidates, type ProductBlock, type ProductLinkedRequest } from "@stubwise/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { proposedAnchors } from "./product-origins.js";
import { ProductDocsError } from "./product-docs.js";
import { requestVisibility } from "./project-requests.js";
import { visibleTasksCondition } from "./task-view.js";

/**
 * Area 11, F6 — dalla pagina al backlog (il prototipo:
 * `data/productDocs/backlog.ts`): le voci che una pagina propone, e «From this
 * page», le richieste nate dalla pagina che chi guarda vede (filtrate nella
 * WHERE). L'origine stessa sta in `product-origins.ts`.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/** La pagina con i permessi di chi guarda: 404 a chi non la legge. */
async function readablePage(db: Db, viewer: Viewer, pageId: string) {
  const [page] = await db.select().from(productPages).where(eq(productPages.id, pageId));
  const perms = page ? await projectPermissionsFor(db, viewer, page.projectId) : null;
  if (!page || !perms?.has("docs.view")) throw new ProductDocsError(404, "not_found", "Not found");
  return { page, perms };
}

/** «From this page» (`GET /api/product-pages/:id/requests`): le richieste nate dalla pagina che chi guarda vede, nell'ordine di nascita. */
export async function listProductLinkedRequests(db: Db, viewer: Viewer, pageId: string): Promise<ProductLinkedRequest[]> {
  await readablePage(db, viewer, pageId);
  const visible = await requestVisibility(db, viewer);
  const rows = await db
    .select({ id: backlogItems.id, number: backlogItems.number, code: projects.code, title: backlogItems.title, status: backlogItems.status })
    .from(productRequestOrigins)
    .innerJoin(backlogJobs, and(eq(backlogJobs.id, productRequestOrigins.intakeJobId), eq(backlogJobs.status, "done")))
    .innerJoin(backlogItems, eq(backlogItems.id, backlogJobs.resultItemId))
    .innerJoin(projects, eq(projects.id, backlogItems.projectId))
    .where(and(eq(productRequestOrigins.pageId, pageId), ...(visible ? [visible] : [])))
    .orderBy(asc(productRequestOrigins.createdAt), asc(productRequestOrigins.id));
  const seen = new Set<string>();
  const items = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  if (items.length === 0) return [];
  const tasksVisible = await visibleTasksCondition(db, viewer);
  const links = await db
    .select({ itemId: backlogItemTickets.itemId, number: tickets.number, code: projects.code })
    .from(backlogItemTickets)
    .innerJoin(tickets, eq(tickets.id, backlogItemTickets.ticketId))
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(inArray(backlogItemTickets.itemId, items.map((i) => i.id)), eq(backlogItemTickets.role, "converted_to"), ...(tasksVisible ? [tasksVisible] : [])))
    .orderBy(asc(tickets.number));
  return items.map((i) => ({
    id: i.id,
    code: `${i.code}-R${i.number}`,
    title: i.title,
    status: i.status,
    taskCodes: links.filter((l) => l.itemId === i.id).map((l) => `${l.code}-${l.number}`),
  }));
}

/**
 * «Turn into backlog items» (`GET /api/product-pages/:id/backlog-candidates`):
 * le voci che chi ha `docs.edit` può proporre dalla pagina, o dalla sola
 * sezione del titolo `fromAnchorId` (422 `invalid_anchor` se non è un titolo
 * della pagina). Le frasi già proposte non tornano: la nota coi codici che chi
 * guarda vede, e quante altre.
 */
export async function productBacklogCandidates(db: Db, viewer: Viewer, pageId: string, fromAnchorId: string | null): Promise<ProductBacklogCandidates> {
  const { page, perms } = await readablePage(db, viewer, pageId);
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  const blocks = readBlocks(page.blocks);
  if (fromAnchorId !== null && blocks.find((b) => b.id === fromAnchorId)?.type !== "heading") throw new ProductDocsError(422, "invalid_anchor", "The anchor is not a heading of the page");
  const all = backlogCandidatesOf(blocks, fromAnchorId);
  const proposed = await proposedAnchors(db, pageId);
  const taken = new Set(proposed.map((p) => p.anchorId));
  const order = new Map(all.map((c, i) => [c.anchorId, i] as const));
  // Le richieste già nate dalle frasi fra le candidate (senza doppioni), nell'ordine della pagina.
  const seen = new Set<string>();
  const already = proposed
    .filter((p) => p.itemId !== null && order.has(p.anchorId) && (seen.has(p.itemId) ? false : (seen.add(p.itemId), true)))
    .sort((a, b) => order.get(a.anchorId)! - order.get(b.anchorId)!);
  const visible = await requestVisibility(db, viewer);
  const shownIds =
    already.length > 0
      ? new Set((await db.select({ id: backlogItems.id }).from(backlogItems).where(and(inArray(backlogItems.id, already.map((a) => a.itemId!)), ...(visible ? [visible] : [])))).map((r) => r.id))
      : new Set<string>();
  const shown = already.filter((a) => shownIds.has(a.itemId!));
  return {
    candidates: all.filter((c) => !taken.has(c.anchorId)),
    alreadyProposed: { codes: shown.map((a) => `${a.code}-R${a.number}`), hidden: already.length - shown.length },
  };
}
