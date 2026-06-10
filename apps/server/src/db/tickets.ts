import type { TicketPriority, TicketSource, TicketType } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { projects, tickets } from "./schema.js";

export type Ticket = typeof tickets.$inferSelect;

/** Lanciato da {@link createTicket} quando il progetto indicato non esiste. */
export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Progetto ${projectId} inesistente: impossibile creare il ticket`);
    this.name = "ProjectNotFoundError";
  }
}

export interface CreateTicketInput {
  projectId: string;
  title: string;
  body?: string;
  type: TicketType;
  priority: TicketPriority;
  source: TicketSource;
  assigneeId?: string;
  labels?: string[];
  technicalPayload?: unknown;
}

/**
 * Crea un ticket assegnandogli atomicamente il prossimo numero sequenziale
 * del progetto. L'UPDATE su `projects.next_ticket_number` prende il row lock
 * sul progetto: creazioni concorrenti sullo stesso progetto si serializzano
 * lì, quindi i numeri escono senza buchi né duplicati. Tutto in transazione,
 * così se l'insert fallisce il contatore non avanza.
 *
 * Riusato dalle route HTTP (Task 8) e dall'ingestion SDK (Task 10).
 */
export async function createTicket(db: Db, input: CreateTicketInput): Promise<Ticket> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(projects)
      .set({ nextTicketNumber: sql`${projects.nextTicketNumber} + 1` })
      .where(eq(projects.id, input.projectId))
      // RETURNING restituisce il valore già incrementato: il numero
      // riservato a questo ticket è quello precedente.
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
      })
      .returning();

    if (!ticket) {
      throw new Error("L'insert del ticket non ha restituito la riga creata");
    }
    return ticket;
  });
}
