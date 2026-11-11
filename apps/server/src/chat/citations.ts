import { backlogItems, chatMessageCitations, docPages, projects, repositories, tickets, users, type Db } from "@stubwise/db";
import type { ChatCitationKind, ChatCitationRef, ChatCitationView } from "@stubwise/shared";
import { and, eq, inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { projectIdsWithPermission, visibleProjectIds } from "../auth/access.js";
import { personName } from "../services/people.js";
import { requestVisibility } from "../services/project-requests.js";
import { visibleTasksCondition } from "../services/task-view.js";
import type { ChatViewer } from "./access.js";

/**
 * Le citazioni di un messaggio della Chat (area 4, fetta 2, F2.7; decisione
 * del maintainer del 10 nov 2026): task, richieste, progetti, persone e
 * pagine Docs. Le regole sono di `writes.ts` del prototipo (`canCite`,
 * `stillNamed`, `citationsOf`):
 * - alla SCRITTURA il server tiene solo ciò che chi scrive vede e che il testo
 *   nomina ancora, più i codici di task e richieste scritti a mano che vede (un
 *   codice diventa link da sé); alla modifica le ricalcola dal testo nuovo;
 * - alla LETTURA le filtra su ciò che chi legge vede, con le regole di sempre
 *   (task: `tickets.view_all` o richiedente; richieste: `backlog.view_all` o
 *   richiedente; progetti: chi li vede; pagine: `docs.view`; persone: chi
 *   esiste). Un oggetto che non c'è più non esce.
 */

/** Ciò che chi guarda vede di un oggetto citabile: l'etichetta e come il testo lo nomina. */
interface Citeable {
  kind: ChatCitationKind;
  id: string;
  label: string;
  projectId: string | null;
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

/** `@Nome` finisce dove finisce il nome (come `mentions.ts` del prototipo). */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text);
}

/**
 * Il testo nomina ancora l'oggetto, col suo confine (review della fetta 2):
 * - il codice di una task o di una richiesta come lo trova `codesIn`
 *   («AUD-1» non vive dentro «AUD-12» né dentro «XAUD-1»);
 * - il codice di un progetto da solo, non come prefisso di un codice
 *   («AUD» non è citato da «AUD-12» né da «AUDIT»);
 * - il titolo di una pagina col confine di parola;
 * - «@Nome» della persona come le menzioni.
 */
export function stillNamed(c: Citeable, text: string): boolean {
  if (c.kind === "person") return mentions(text, c.label);
  if (c.kind === "task" || c.kind === "request") return codesIn(text).some((found) => found.code === c.label);
  const escaped = c.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = c.kind === "project" ? "(?![\\p{L}\\p{N}_]|-R?\\d)" : "(?![\\p{L}\\p{N}_])";
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}${tail}`, "u").test(text);
}

/**
 * I codici di task e richieste scritti nel testo (`findCodes` del prototipo):
 * maiuscoli, come li scrive il Catalogo, così «utf-8» non diventa un codice.
 */
export function codesIn(text: string): { projectCode: string; number: number; kind: "task" | "request"; code: string }[] {
  const out: { projectCode: string; number: number; kind: "task" | "request"; code: string }[] = [];
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,5})-(R?)(\d{1,9})\b/g)) {
    const code = m[0];
    if (out.some((c) => c.code === code)) continue;
    out.push({ projectCode: m[1]!, number: Number(m[3]), kind: m[2] ? "request" : "task", code });
  }
  return out;
}

/** Gli oggetti fra `refs` che chi guarda VEDE, con l'etichetta (una query per tipo). */
export async function citeablesFor(
  db: Db,
  viewer: ChatViewer,
  refs: readonly { kind: ChatCitationKind; id: string }[],
): Promise<Map<string, Citeable>> {
  const out = new Map<string, Citeable>();
  const ids = (kind: ChatCitationKind) => [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
  const put = (c: Citeable) => out.set(keyOf(c.kind, c.id), c);

  const taskIds = ids("task");
  if (taskIds.length > 0) {
    const rows = await db
      .select({ id: tickets.id, projectId: tickets.projectId, code: sql<string>`${projects.code} || '-' || ${tickets.number}` })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(and(inArray(tickets.id, taskIds), await visibleTasksCondition(db, viewer)));
    for (const r of rows) put({ kind: "task", id: r.id, label: r.code, projectId: r.projectId });
  }

  // I progetti visibili solo se servono (richieste, progetti): niente query per una lista senza.
  const visible = ids("request").length > 0 || ids("project").length > 0 ? await visibleProjectIds(db, viewer) : [];
  const inVisible = (column: typeof backlogItems.projectId | typeof projects.id): SQL | undefined =>
    visible === "all" ? undefined : visible.length === 0 ? sql`false` : inArray(column, visible);

  const requestIds = ids("request");
  if (requestIds.length > 0) {
    const rows = await db
      .select({ id: backlogItems.id, projectId: backlogItems.projectId, code: sql<string>`${projects.code} || '-R' || ${backlogItems.number}` })
      .from(backlogItems)
      .innerJoin(projects, eq(projects.id, backlogItems.projectId))
      .where(and(inArray(backlogItems.id, requestIds), inVisible(backlogItems.projectId), await requestVisibility(db, viewer)));
    for (const r of rows) put({ kind: "request", id: r.id, label: r.code, projectId: r.projectId });
  }

  const projectIds = ids("project");
  if (projectIds.length > 0) {
    const rows = await db
      .select({ id: projects.id, code: projects.code })
      .from(projects)
      .where(and(inArray(projects.id, projectIds), inVisible(projects.id)));
    for (const r of rows) put({ kind: "project", id: r.id, label: r.code, projectId: r.id });
  }

  const personIds = ids("person");
  if (personIds.length > 0) {
    const rows = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(and(inArray(users.id, personIds), eq(users.isAgent, false)));
    for (const r of rows) put({ kind: "person", id: r.id, label: personName(r), projectId: null });
  }

  const docIds = ids("doc");
  if (docIds.length > 0) {
    const readable = await projectIdsWithPermission(db, viewer, "docs.view");
    if (readable === "all" || readable.length > 0) {
      const rows = await db
        .select({ id: docPages.id, title: docPages.title, projectId: repositories.projectId })
        .from(docPages)
        .innerJoin(repositories, eq(repositories.id, docPages.repositoryId))
        .where(and(inArray(docPages.id, docIds), readable === "all" ? undefined : inArray(repositories.projectId, readable)));
      for (const r of rows) put({ kind: "doc", id: r.id, label: r.title, projectId: r.projectId });
    }
  }
  return out;
}

/**
 * Il messaggio `messageId` ha almeno una citazione che chi guarda VEDE, in SQL
 * (review della fetta 2): il filtro «con citazioni» sta nella WHERE, prima del
 * limite, con le stesse regole di `citeablesFor`. Una citazione di un oggetto
 * nascosto non conta, così il filtro non conferma che esiste.
 */
export async function hasVisibleCitationSql(db: Db, viewer: ChatViewer, messageId: AnyColumn): Promise<SQL> {
  const visible = await visibleProjectIds(db, viewer);
  const inVisible = (column: AnyColumn): SQL =>
    visible === "all" ? sql`true` : visible.length === 0 ? sql`false` : inArray(column, visible);
  const readable = await projectIdsWithPermission(db, viewer, "docs.view");
  const inReadable: SQL =
    readable === "all" ? sql`true` : readable.length === 0 ? sql`false` : inArray(repositories.projectId, readable);
  const tasks = (await visibleTasksCondition(db, viewer)) ?? sql`true`;
  const requests = (await requestVisibility(db, viewer)) ?? sql`true`;
  return sql`exists (
    select 1 from ${chatMessageCitations} c
    where c.message_id = ${messageId}
      and (
        (c.kind = 'task' and exists (select 1 from ${tickets} where ${tickets.id} = c.ref_id and ${tasks}))
        or (c.kind = 'request' and exists (
          select 1 from ${backlogItems} where ${backlogItems.id} = c.ref_id and ${inVisible(backlogItems.projectId)} and ${requests}
        ))
        or (c.kind = 'project' and exists (select 1 from ${projects} where ${projects.id} = c.ref_id and ${inVisible(projects.id)}))
        or (c.kind = 'person' and exists (select 1 from ${users} where ${users.id} = c.ref_id and ${users.isAgent} = false))
        or (c.kind = 'doc' and exists (
          select 1 from ${docPages} inner join ${repositories} on ${repositories.id} = ${docPages.repositoryId}
          where ${docPages.id} = c.ref_id and ${inReadable}
        ))
      )
  )`;
}

/** Le task e le richieste che chi guarda vede, dai codici scritti nel testo. */
async function citeablesFromCodes(db: Db, viewer: ChatViewer, text: string): Promise<Citeable[]> {
  const codes = codesIn(text);
  if (codes.length === 0) return [];
  const byCode = (kind: "task" | "request") =>
    codes.filter((c) => c.kind === kind).map((c) => and(eq(projects.code, c.projectCode), eq(kind === "task" ? tickets.number : backlogItems.number, c.number))!);
  const found: { kind: "task" | "request"; id: string }[] = [];
  const tasks = byCode("task");
  if (tasks.length > 0) {
    const rows = await db
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(or(...tasks));
    found.push(...rows.map((r) => ({ kind: "task" as const, id: r.id })));
  }
  const requests = byCode("request");
  if (requests.length > 0) {
    const rows = await db
      .select({ id: backlogItems.id })
      .from(backlogItems)
      .innerJoin(projects, eq(projects.id, backlogItems.projectId))
      .where(or(...requests));
    found.push(...rows.map((r) => ({ kind: "request" as const, id: r.id })));
  }
  // La visibilità la decide `citeablesFor`, la stessa della lettura.
  const visible = await citeablesFor(db, viewer, found);
  return [...visible.values()];
}

/**
 * Le citazioni da salvare per un messaggio (`citationsOf` del prototipo):
 * quelle scelte che chi scrive vede e che il testo nomina ancora, poi i codici
 * scritti a mano che vede. Lo stesso oggetto una volta sola, nell'ordine.
 */
export async function citationsToStore(
  db: Db,
  viewer: ChatViewer,
  text: string,
  picked: readonly ChatCitationRef[],
): Promise<{ kind: ChatCitationKind; id: string; label: string }[]> {
  const seen = await citeablesFor(db, viewer, picked);
  const out: Citeable[] = [];
  const has = (kind: string, id: string) => out.some((c) => c.kind === kind && c.id === id);
  for (const ref of picked) {
    const c = seen.get(keyOf(ref.kind, ref.id));
    if (!c || has(c.kind, c.id) || !stillNamed(c, text)) continue;
    out.push(c);
  }
  for (const c of await citeablesFromCodes(db, viewer, text)) if (!has(c.kind, c.id)) out.push(c);
  return out.map(({ kind, id, label }) => ({ kind, id, label }));
}

/** Le citazioni di più messaggi come le legge chi guarda: solo ciò che vede, in ordine. */
export async function citationViews(
  db: Db,
  viewer: ChatViewer,
  rows: readonly { messageId: string; kind: ChatCitationKind; refId: string }[],
): Promise<Map<string, ChatCitationView[]>> {
  const visible = await citeablesFor(db, viewer, rows.map((r) => ({ kind: r.kind, id: r.refId })));
  const out = new Map<string, ChatCitationView[]>();
  for (const r of rows) {
    const c = visible.get(keyOf(r.kind, r.refId));
    if (!c) continue;
    out.set(r.messageId, [...(out.get(r.messageId) ?? []), { kind: c.kind, id: c.id, label: c.label, projectId: c.projectId }]);
  }
  return out;
}
