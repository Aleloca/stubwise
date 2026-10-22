/**
 * Resolver del progetto per `config.access` di tipo `project` (vedi
 * `access.ts`): dal parametro del path all'id del progetto della risorsa.
 *
 * Ognuno restituisce `null` se l'entità non esiste — e anche quando il
 * parametro non ha la forma di un uuid, per non mandare a Postgres un cast
 * che fallirebbe con un 500: per chi chiede, un id malformato e un id che non
 * esiste sono la stessa cosa (404).
 */
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  agentSessions,
  aiJobs,
  attachments,
  backlogItems,
  docPages,
  milestones,
  projects,
  repositories,
  tickets,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { ProjectPermission } from "@stubwise/shared";
import type { ProjectResolver, ResourceGuard } from "./access.js";
import type { SessionUser } from "./session.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paramOf(req: FastifyRequest, name: string): string | null {
  const value = (req.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : null;
}

/** Il parametro come uuid, o `null` se assente o malformato. */
function uuidParam(req: FastifyRequest, name: string): string | null {
  const value = paramOf(req, name);
  return value && UUID_RE.test(value) ? value : null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

async function existingProject(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
  return row?.id ?? null;
}

/** Il parametro È l'id del progetto (che deve esistere). */
export function fromParam(name: string): ProjectResolver {
  return async (req, db) => existingProject(db, uuidParam(req, name));
}

/**
 * Il campo del CORPO è l'id del progetto (creazioni: ticket, milestone). L'hook
 * gira dopo la validazione, quindi il corpo è già quello dello schema.
 */
export function fromBody(field: string): ProjectResolver {
  return async (req, db) =>
    existingProject(db, uuidOrNull((req.body as Record<string, unknown> | null)?.[field]));
}

/** Il parametro della QUERY è l'id del progetto (elenchi per progetto). */
export function fromQuery(field: string): ProjectResolver {
  return async (req, db) =>
    existingProject(db, uuidOrNull((req.query as Record<string, unknown> | null)?.[field]));
}

export function fromTicket(param: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, param);
    if (!id) return null;
    const [row] = await db
      .select({ projectId: tickets.projectId })
      .from(tickets)
      .where(eq(tickets.id, id));
    return row?.projectId ?? null;
  };
}

export function fromBacklogItem(param: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, param);
    if (!id) return null;
    const [row] = await db
      .select({ projectId: backlogItems.projectId })
      .from(backlogItems)
      .where(eq(backlogItems.id, id));
    return row?.projectId ?? null;
  };
}

/**
 * Accetta l'id del repository o il suo slug (unico): le rotte di
 * `repositories.ts` usano `:slug`, le altre `:repositoryId`.
 */
export function fromRepository(param: string): ProjectResolver {
  return async (req, db) => {
    const value = paramOf(req, param);
    if (!value) return null;
    const where = UUID_RE.test(value) ? eq(repositories.id, value) : eq(repositories.slug, value);
    const [row] = await db
      .select({ projectId: repositories.projectId })
      .from(repositories)
      .where(where);
    return row?.projectId ?? null;
  };
}

/**
 * Il progetto di una sessione dell'agente: la colonna diretta, altrimenti
 * quello del ticket, del job (via ticket) o della voce di backlog. Una sessione
 * senza progetto (la classificazione di un'email, legata alla casella) dà
 * `null`: non è una risorsa di progetto.
 */
export function fromAgentSession(param: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, param);
    return id ? agentSessionProjectId(db, id) : null;
  };
}

/** Il progetto della sessione `id` (vedi {@link fromAgentSession}), `null` se non ne ha. */
export async function agentSessionProjectId(db: Db, id: string): Promise<string | null> {
  const jobTickets = db
    .select({ id: tickets.id, projectId: tickets.projectId })
    .from(tickets)
    .as("job_tickets");
  const [row] = await db
    .select({
      projectId: sql<
        string | null
      >`coalesce(${agentSessions.projectId}, ${tickets.projectId}, ${jobTickets.projectId}, ${backlogItems.projectId})`,
    })
    .from(agentSessions)
    .leftJoin(tickets, eq(tickets.id, agentSessions.ticketId))
    .leftJoin(aiJobs, eq(aiJobs.id, agentSessions.aiJobId))
    .leftJoin(jobTickets, eq(jobTickets.id, aiJobs.ticketId))
    .leftJoin(backlogItems, eq(backlogItems.id, agentSessions.backlogItemId))
    .where(eq(agentSessions.id, id));
  return row?.projectId ?? null;
}

export function fromJob(param: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, param);
    if (!id) return null;
    const [row] = await db
      .select({ projectId: tickets.projectId })
      .from(aiJobs)
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .where(eq(aiJobs.id, id));
    return row?.projectId ?? null;
  };
}

export function fromAttachment(param: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, param);
    if (!id) return null;
    const [row] = await db
      .select({ projectId: tickets.projectId })
      .from(attachments)
      .innerJoin(tickets, eq(tickets.id, attachments.ticketId))
      .where(eq(attachments.id, id));
    return row?.projectId ?? null;
  };
}

export function fromMilestone(param: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, param);
    if (!id) return null;
    const [row] = await db
      .select({ projectId: milestones.projectId })
      .from(milestones)
      .where(eq(milestones.id, id));
    return row?.projectId ?? null;
  };
}

export function fromDocPage(param: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, param);
    if (!id) return null;
    const [row] = await db
      .select({ projectId: repositories.projectId })
      .from(docPages)
      .innerJoin(repositories, eq(repositories.id, docPages.repositoryId))
      .where(eq(docPages.id, id));
    return row?.projectId ?? null;
  };
}

/**
 * Regola di `tickets.view_all` (design: «senza, solo i ticket che ha aperto o
 * richiesto»): un ticket è visibile a chi ha il permesso nel suo progetto, o a
 * chi lo ha chiesto (`requested_by_user_id`, scritto anche da chi lo apre
 * dalla web app o dall'MCP). La tabella non ha una colonna «autore» distinta.
 */
export async function canSeeTicket(
  db: Db,
  user: Pick<SessionUser, "id">,
  permissions: ReadonlySet<ProjectPermission>,
  ticketId: string,
): Promise<boolean> {
  if (permissions.has("tickets.view_all")) return true;
  const [row] = await db
    .select({ requestedByUserId: tickets.requestedByUserId })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  return row !== undefined && row.requestedByUserId === user.id;
}

/** {@link canSeeTicket} sul ticket del parametro (rotte `/tickets/:id/...`). */
export function ticketVisible(param: string): ResourceGuard {
  return async (req, db, user, permissions) => {
    const id = uuidParam(req, param);
    return id !== null && canSeeTicket(db, user, permissions, id);
  };
}

/** {@link canSeeTicket} sul ticket dell'allegato del parametro. */
export function attachmentTicketVisible(param: string): ResourceGuard {
  return async (req, db, user, permissions) => {
    if (permissions.has("tickets.view_all")) return true;
    const id = uuidParam(req, param);
    if (!id) return false;
    const [row] = await db
      .select({ ticketId: attachments.ticketId })
      .from(attachments)
      .where(eq(attachments.id, id));
    return row !== undefined && canSeeTicket(db, user, permissions, row.ticketId);
  };
}

