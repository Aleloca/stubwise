import type { TicketPriority, TicketSource, TicketType } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { projects, tickets } from "./schema.js";

export type Ticket = typeof tickets.$inferSelect;

/**
 * Lanciato da {@link createTicket} quando il progetto bersaglio indicato non
 * esiste. Dalla Fase 3 il ticket appartiene solo al PROGETTO: il numero
 * sequenziale è per-progetto e non esiste più un "repo di origine". I chiamanti
 * (ingest/inbound/slack) mappano questo errore su una risposta di "progetto
 * inesistente".
 */
export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Progetto ${projectId} inesistente: impossibile creare il ticket`);
    this.name = "ProjectNotFoundError";
  }
}

export interface CreateTicketInput {
  /**
   * Progetto (gruppo) bersaglio del ticket: da qui si claima il numero
   * sequenziale per-progetto (Fase 3). Il ticket appartiene solo al progetto:
   * non ha più un repository bersaglio (il legame ticket↔repo vive in
   * `ticket_repositories`, popolato dopo l'esecuzione del fix).
   */
  projectId: string;
  title: string;
  body?: string;
  type: TicketType;
  priority: TicketPriority;
  source: TicketSource;
  assigneeId?: string;
  labels?: string[];
  technicalPayload?: unknown;
  /**
   * Piano di implementazione collegato (testo libero, opzionale): propagato ad
   * es. dalla conversione di una voce di backlog. Default non impostato → null.
   */
  implementationPlan?: string | null;
  /**
   * Contenuto d'origine preservato quando un design sostituisce il corpo
   * (opzionale): propagato ad es. dalla conversione di una voce di backlog.
   */
  originContent?: string | null;
  /** Chi ha chiesto il ticket (utente autenticato); assente/null per ingest SDK, Slack, widget. */
  requestedByUserId?: string | null;
  /**
   * Integrazione area 2 (app nuova): reparto, stato, sforzo (la taglia),
   * traguardo e scadenza. Assenti = i default del DB (ripiego, stato
   * dall'enum, nessuno) — gli scrittori di oggi non cambiano.
   */
  departmentId?: string;
  statusId?: string;
  effort?: number | null;
  milestoneId?: string | null;
  dueDate?: string | null;
  /** Fetta 2: il lunedì della settimana pianificata. */
  plannedWeek?: string | null;
  /** Area 7: l'esecuzione che la crea (l'origine si DERIVA a lettura da qui). */
  automationRunId?: string | null;
}

/**
 * Crea un ticket assegnandogli atomicamente il prossimo numero sequenziale del
 * PROGETTO bersaglio. L'UPDATE su `projects.next_ticket_number` prende il row
 * lock sul progetto: creazioni concorrenti sullo stesso progetto si
 * serializzano lì, quindi i numeri (per-progetto) escono senza buchi né
 * duplicati. Tutto in transazione: se l'insert fallisce il contatore non
 * avanza.
 *
 * Riusato dalle route HTTP, dall'ingestion SDK e (area 7) dall'esecutore
 * delle automazioni nel worker: sta in `@stubwise/db` per questo, e
 * `apps/server/src/db/tickets.ts` lo ri-esporta. `db` può essere una
 * transazione aperta (drizzle apre un savepoint).
 */
export async function createTicket(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], input: CreateTicketInput): Promise<Ticket> {
  return (db as Db).transaction(async (tx) => {
    const [claimed] = await tx
      .update(projects)
      .set({ nextTicketNumber: sql`${projects.nextTicketNumber} + 1` })
      .where(eq(projects.id, input.projectId))
      // RETURNING restituisce il valore già incrementato: il numero riservato a
      // questo ticket è quello precedente.
      .returning({ nextTicketNumber: projects.nextTicketNumber });

    if (!claimed) {
      throw new ProjectNotFoundError(input.projectId);
    }

    const [ticket] = await tx
      .insert(tickets)
      .values({
        projectId: input.projectId,
        number: claimed.nextTicketNumber - 1,
        title: input.title,
        body: input.body,
        type: input.type,
        priority: input.priority,
        source: input.source,
        assigneeId: input.assigneeId,
        labels: input.labels,
        technicalPayload: input.technicalPayload,
        implementationPlan: input.implementationPlan,
        originContent: input.originContent,
        requestedByUserId: input.requestedByUserId ?? null,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
        ...(input.statusId ? { statusId: input.statusId } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.plannedWeek !== undefined ? { plannedWeek: input.plannedWeek } : {}),
        ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}),
      })
      .returning();

    if (!ticket) {
      throw new Error("L'insert del ticket non ha restituito la riga creata");
    }
    return ticket;
  });
}
