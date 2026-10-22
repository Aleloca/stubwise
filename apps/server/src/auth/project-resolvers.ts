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
  backlogItems,
  docPages,
  milestones,
  projects,
  repositories,
  tickets,
} from "@stubwise/db";
import type { ProjectResolver } from "./access.js";

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

/** Il parametro È l'id del progetto (che deve esistere). */
export function fromParam(name: string): ProjectResolver {
  return async (req, db) => {
    const id = uuidParam(req, name);
    if (!id) return null;
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
    return row?.id ?? null;
  };
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
    if (!id) return null;
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
  };
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
