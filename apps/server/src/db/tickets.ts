import type { TicketPriority, TicketSource, TicketType } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { repositories, tickets } from "@stubwise/db";

export type Ticket = typeof tickets.$inferSelect;

/**
 * Lanciato da {@link createTicket} quando il repository bersaglio indicato non
 * esiste. Conserva il nome storico ProjectNotFoundError per non rompere i
 * chiamanti (ingest/slack) che lo mappano su 404, ma ora rappresenta un
 * repository mancante: il numero ticket è per-repository.
 */
export class ProjectNotFoundError extends Error {
  constructor(repositoryId: string) {
    super(`Repository ${repositoryId} inesistente: impossibile creare il ticket`);
    this.name = "ProjectNotFoundError";
  }
}

export interface CreateTicketInput {
  /**
   * Repository bersaglio del ticket: da qui si claima il numero sequenziale
   * (per-repository) e si deriva il progetto (gruppo) se `projectId` è omesso.
   */
  repositoryId: string;
  /**
   * Progetto (gruppo) a cui il ticket appartiene. Opzionale: se omesso viene
   * derivato dal repository bersaglio (relazione 1:N, ogni repo ha un progetto).
   * Quando il chiamante l'ha già validato (route HTTP) lo passa esplicito.
   */
  projectId?: string;
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
 * Crea un ticket assegnandogli atomicamente il prossimo numero sequenziale del
 * REPOSITORY bersaglio. L'UPDATE su `repositories.next_ticket_number` prende il
 * row lock sul repository: creazioni concorrenti sullo stesso repository si
 * serializzano lì, quindi i numeri (per-repo) escono senza buchi né duplicati.
 * Il progetto (gruppo) del ticket si deriva dal repository se non passato.
 * Tutto in transazione: se l'insert fallisce il contatore non avanza.
 *
 * Riusato dalle route HTTP e dall'ingestion SDK.
 */
export async function createTicket(db: Db, input: CreateTicketInput): Promise<Ticket> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(repositories)
      .set({ nextTicketNumber: sql`${repositories.nextTicketNumber} + 1` })
      .where(eq(repositories.id, input.repositoryId))
      // RETURNING restituisce il valore già incrementato: il numero riservato a
      // questo ticket è quello precedente. Recupera anche il progetto del repo,
      // così il ticket nasce col gruppo corretto senza una query extra.
      .returning({
        nextTicketNumber: repositories.nextTicketNumber,
        projectId: repositories.projectId,
      });

    if (!claimed) {
      throw new ProjectNotFoundError(input.repositoryId);
    }

    const [ticket] = await tx
      .insert(tickets)
      .values({
        projectId: input.projectId ?? claimed.projectId,
        repositoryId: input.repositoryId,
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
