import { aiJobs, backlogItems, docPages, projects, repositories, serverProjects, servers, tickets } from "@stubwise/db";
import { appPath, type AppTarget } from "@stubwise/shared";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { projectPermissionsFor } from "../auth/access.js";
import { canSeeBacklogItem, canSeeTicket } from "../auth/project-resolvers.js";
import { findSessionUser, sessionIdFromRequest, type SessionUser } from "../auth/session.js";

/**
 * I RIMANDI dei link del web vecchio verso la nuova app (ritiro del web vecchio,
 * design `docs/plans/2026-11-27-link-nuova-app-design.md`, «Da fare al
 * ritiro», parte a). Card, email, push, DM e webhook già spediti portano i
 * percorsi vecchi per ID (`/tickets/<uuid>`, `/docs/<repositoryId>`…); la
 * nuova app vuole i CODICI, che Caddy non conosce. Al ritiro Caddy manda i
 * percorsi vecchi qui (`/go/<percorso vecchio>`, regole nel Caddyfile, spente
 * fino ad allora); queste rotte risolvono l'id e rispondono 302 al link della
 * nuova app, costruito dall'helper (`app-links`).
 *
 * Le regole, uguali per tutte:
 * - **Serve la sessione** del browser, completa. Senza (o a metà login) si va
 *   all'ingresso della nuova app, che chiede il login: mai un 401 JSON a un
 *   browser che segue un link, e nessuna informazione su cosa c'era dietro.
 * - **Un oggetto inesistente, sparito o che chi apre non vede porta alla
 *   Home**, con la stessa risposta (r.1414): il rimando non conferma che
 *   l'id esiste e non rivela il codice di un progetto invisibile. Un id non
 *   valido idem.
 * - Il `Location` è RELATIVO all'origine (`/app/#/…`): il browser è già
 *   sull'istanza, e un `PUBLIC_URL` sbagliato non lo porta altrove.
 *
 * `config.access` è `public` perché la sessione la legge l'handler (per poter
 * rimandare invece di rispondere 401); `config.mcp` le esclude come
 * infrastruttura: sono rimandi per i browser, per Claude Code non servono.
 */
const HOME: AppTarget = { to: "home" };
const ENTRY = appPath(HOME);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE = { config: { access: { kind: "public" as const }, mcp: { exclude: "infra" as const } } };

type Resolve = (user: SessionUser, params: Record<string, string | undefined>, query: Record<string, string | undefined>) => Promise<AppTarget | null>;

/** Le pagine che una persona vede in un progetto: `null` = non lo vede (o non esiste). */
async function permissionsIn(app: FastifyInstance, user: SessionUser, projectId: string) {
  return projectPermissionsFor(app.db, user, projectId);
}

const uuid = (value: string | undefined) => (value && UUID.test(value) ? value : null);

export async function goRoutes(app: FastifyInstance): Promise<void> {
  /** Una rotta di rimando: sessione, risoluzione, 302 (la Home per tutto ciò che non si apre). */
  function go(path: string, resolve: Resolve) {
    app.get(path, ROUTE, async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      const sessionId = sessionIdFromRequest(request);
      const user = sessionId ? await findSessionUser(app.db, sessionId) : null;
      if (!user || user.sessionStage !== "full") return reply.redirect(ENTRY, 302);
      let target: AppTarget | null = null;
      try {
        target = await resolve(user, request.params as Record<string, string | undefined>, request.query as Record<string, string | undefined>);
      } catch (error) {
        // Un guasto nella risoluzione non diventa una pagina d'errore: la Home.
        request.log.warn({ err: error, path }, "rimando del web vecchio non risolto");
      }
      return reply.redirect(appPath(target ?? HOME), 302);
    });
  }

  /** La task (`/tickets/:id`): visibile secondo `tickets.view_all` o chi l'ha chiesta. */
  async function taskOf(user: SessionUser, ticketId: string | null): Promise<AppTarget | null> {
    if (!ticketId) return null;
    const [row] = await app.db
      .select({ projectId: tickets.projectId, number: tickets.number, code: projects.code })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    if (!row) return null;
    const permissions = await permissionsIn(app, user, row.projectId);
    if (!permissions || !(await canSeeTicket(app.db, user, permissions, ticketId))) return null;
    return { to: "task", projectCode: row.code, taskCode: `${row.code}-${row.number}` };
  }

  /** Il codice di un progetto che chi apre vede, o `null`. */
  async function visibleProjectCode(user: SessionUser, projectId: string | null): Promise<string | null> {
    if (!projectId) return null;
    const [row] = await app.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    if (!row || !(await permissionsIn(app, user, projectId))) return null;
    return row.code;
  }

  go("/tickets/:id", (user, params) => taskOf(user, uuid(params.id)));

  // `/agents/job/:jobId?ticketId=`: la conversazione del web vecchio; nella
  // nuova app si apre la task, la cui sezione Claude elenca i run.
  go("/agents/job/:jobId", async (user, params, query) => {
    const jobId = uuid(params.jobId);
    const [job] = jobId ? await app.db.select({ ticketId: aiJobs.ticketId }).from(aiJobs).where(eq(aiJobs.id, jobId)) : [];
    return taskOf(user, job?.ticketId ?? uuid(query.ticketId));
  });

  go("/backlog/:id", async (user, params) => {
    const itemId = uuid(params.id);
    if (!itemId) return null;
    const [row] = await app.db
      .select({ projectId: backlogItems.projectId, code: projects.code })
      .from(backlogItems)
      .innerJoin(projects, eq(projects.id, backlogItems.projectId))
      .where(eq(backlogItems.id, itemId));
    if (!row) return null;
    const permissions = await permissionsIn(app, user, row.projectId);
    if (!permissions || !(await canSeeBacklogItem(app.db, user, permissions, itemId))) return null;
    return { to: "requests", projectCode: row.code, requestId: itemId };
  });

  // `/backlog?projectId=` (il link del pulse): le richieste del progetto.
  go("/backlog", async (user, _params, query) => {
    const code = await visibleProjectCode(user, uuid(query.projectId));
    return code ? { to: "requests", projectCode: code } : null;
  });

  go("/projects/:id", async (user, params) => {
    const code = await visibleProjectCode(user, uuid(params.id));
    return code ? { to: "project", projectCode: code } : null;
  });
  // La roadmap non ha un equivalente nella nuova app: la panoramica (il brief vi si apre).
  go("/projects/:id/roadmap", async (user, params) => {
    const code = await visibleProjectCode(user, uuid(params.id));
    return code ? { to: "project", projectCode: code } : null;
  });
  go("/projects/:id/backlog", async (user, params) => {
    const code = await visibleProjectCode(user, uuid(params.id));
    return code ? { to: "requests", projectCode: code } : null;
  });

  /** Lo spazio Docs di un repository (per slug, nel suo progetto), o una sua pagina. */
  async function docsOf(user: SessionUser, repositoryId: string | null, pageSlug?: string): Promise<AppTarget | null> {
    if (!repositoryId) return null;
    const [repo] = await app.db.select({ slug: repositories.slug, projectId: repositories.projectId }).from(repositories).where(eq(repositories.id, repositoryId));
    const code = await visibleProjectCode(user, repo?.projectId ?? null);
    if (!repo || !code) return null;
    return { to: "docs", projectCode: code, repositorySlug: repo.slug, ...(pageSlug ? { pageSlug } : {}) };
  }

  go("/docs/:repositoryId", (user, params) => docsOf(user, uuid(params.repositoryId)));
  go("/docs/:repositoryId/:slug", async (user, params) => {
    const repositoryId = uuid(params.repositoryId);
    const slug = params.slug ?? "";
    // Solo una pagina che esiste in quel repository: un slug inventato porta allo spazio.
    const [page] = repositoryId && slug ? await app.db.select({ slug: docPages.slug }).from(docPages).where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.slug, slug))) : [];
    return docsOf(user, repositoryId, page?.slug);
  });

  // Un server: nel primo progetto legato che chi apre vede, o dall'Amministrazione con `monitor.manage`.
  go("/monitor/servers/:id", async (user, params) => {
    const serverId = uuid(params.id);
    if (!serverId) return null;
    const [server] = await app.db.select({ number: servers.number }).from(servers).where(eq(servers.id, serverId));
    if (!server) return null;
    const serverCode = `SRV-${server.number}`;
    const linked = await app.db
      .select({ projectId: serverProjects.projectId })
      .from(serverProjects)
      .innerJoin(projects, eq(projects.id, serverProjects.projectId))
      .where(eq(serverProjects.serverId, serverId))
      .orderBy(asc(projects.code));
    for (const { projectId } of linked) {
      const code = await visibleProjectCode(user, projectId);
      if (code) return { to: "server", projectCode: code, serverCode };
    }
    const admin = user.instancePermissions.has("monitor.manage") || user.instancePermissions.has("instance.full_admin");
    return admin ? { to: "adminServer", serverCode } : null;
  });
}
