/**
 * Dagli ID ai LINK DELLA NUOVA APP (ritiro del web vecchio, design
 * `docs/plans/2026-11-27-link-nuova-app-design.md`). La forma del link sta in
 * `@stubwise/shared` (`app-links.ts`); qui si leggono dal DB i codici che la
 * nuova app vuole (codice del progetto, `<CODE>-<n>` della task, `SRV-<n>`,
 * slug del repository), per chi ha in mano solo l'id: worker, server, SDK.
 * Condiviso fra server e worker, come la timeline e i segnali del progetto.
 *
 * Un oggetto che non c'è più non fa fallire chi scrive il link: si ripiega
 * sulla Home della nuova app (mai su un percorso del web vecchio).
 */
import { backlogItems, projects, repositories, servers, tickets } from "@stubwise/db";
import { appUrl, type AppTarget } from "@stubwise/shared/app-links";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "./dispatch.js";

const HOME: AppTarget = { to: "home" };

/** Il codice di un progetto, o `null` se non c'è. */
export async function projectCodeOf(db: DbOrTx, projectId: string): Promise<string | null> {
  const [row] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return row?.code ?? null;
}

/** La task (`?task=<CODE>-<n>` nel suo progetto), o `null`. */
export async function taskTarget(db: DbOrTx, ticketId: string): Promise<AppTarget | null> {
  const [row] = await db
    .select({ number: tickets.number, code: projects.code })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, ticketId));
  return row ? { to: "task", projectCode: row.code, taskCode: `${row.code}-${row.number}` } : null;
}

/** L'indirizzo della task nella nuova app; la Home se la task non c'è. */
export async function ticketAppUrl(db: DbOrTx, publicUrl: string | null | undefined, ticketId: string): Promise<string> {
  return appUrl(publicUrl, (await taskTarget(db, ticketId)) ?? HOME);
}

/** La panoramica del progetto (col brief aperto, se c'è); la Home se il progetto non c'è. */
export async function projectAppUrl(
  db: DbOrTx,
  publicUrl: string | null | undefined,
  projectId: string,
  opts: { briefId?: string } = {},
): Promise<string> {
  const code = await projectCodeOf(db, projectId);
  return appUrl(publicUrl, code ? { to: "project", projectCode: code, ...(opts.briefId ? { briefId: opts.briefId } : {}) } : HOME);
}

/** Le richieste (il backlog) di un progetto; la Home se il progetto non c'è. */
export async function requestsAppUrl(db: DbOrTx, publicUrl: string | null | undefined, projectId: string): Promise<string> {
  const code = await projectCodeOf(db, projectId);
  return appUrl(publicUrl, code ? { to: "requests", projectCode: code } : HOME);
}

/** Una voce di backlog nelle richieste del suo progetto (`?request=<id>`); la Home se non c'è. */
export async function backlogItemAppUrl(db: DbOrTx, publicUrl: string | null | undefined, itemId: string): Promise<string> {
  const [row] = await db
    .select({ code: projects.code })
    .from(backlogItems)
    .innerJoin(projects, eq(projects.id, backlogItems.projectId))
    .where(eq(backlogItems.id, itemId));
  return appUrl(publicUrl, row ? { to: "requests", projectCode: row.code, requestId: itemId } : HOME);
}

/**
 * I Docs di un repository (per slug, nel suo progetto), o una sua pagina. Un
 * repository senza progetto non ha uno spazio Docs nella nuova app: la Home.
 */
export async function repositoryDocsAppUrl(
  db: DbOrTx,
  publicUrl: string | null | undefined,
  repositoryId: string,
  pageSlug?: string,
): Promise<string> {
  const [row] = await db
    .select({ slug: repositories.slug, code: projects.code })
    .from(repositories)
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(repositories.id, repositoryId));
  return appUrl(
    publicUrl,
    row ? { to: "docs", projectCode: row.code, repositorySlug: row.slug, ...(pageSlug ? { pageSlug } : {}) } : HOME,
  );
}

/**
 * Un server monitorato: nel progetto quando il legame è univoco (`projectId`,
 * come lo decide il monitor), altrimenti dall'Amministrazione, come l'app apre
 * le card del monitor. La Home se il server non c'è.
 */
export async function serverAppUrl(
  db: DbOrTx,
  publicUrl: string | null | undefined,
  serverId: string,
  projectId?: string | null,
): Promise<string> {
  const [row] = await db.select({ number: servers.number }).from(servers).where(eq(servers.id, serverId));
  if (!row) return appUrl(publicUrl, HOME);
  const serverCode = `SRV-${row.number}`;
  const code = projectId ? await projectCodeOf(db, projectId) : null;
  return appUrl(publicUrl, code ? { to: "server", projectCode: code, serverCode } : { to: "adminServer", serverCode });
}
