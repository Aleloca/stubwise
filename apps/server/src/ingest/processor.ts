import type { ErrorEvent, FeedbackEvent, IngestEvent, TicketCreateEvent } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { aiJobs, errorGroups, tickets } from "../db/schema.js";
import { createTicket } from "../db/tickets.js";
import { fingerprint } from "./fingerprint.js";

/** Lunghezza massima del titolo di un ticket (allineata alla validazione API). */
const TITLE_MAX = 300;

/** Tentativi massimi per evento errore: ogni retry segue un conflitto
 * sull'unique, cioè un concorrente ha appena creato il gruppo — al giro
 * successivo la SELECT lo trova. Più di un retry è già anomalo. */
const MAX_ATTEMPTS = 3;

export interface ProcessResult {
  /** Ticket nuovi creati (errori nuovi + feedback + eventi ticket). */
  created: number;
  /** Eventi errore collassati su un ErrorGroup esistente. */
  deduped: number;
}

/**
 * Hook riservati ai test: permettono di iniettare deterministicamente la
 * race sul vincolo unique di errorGroups. Nessun uso in produzione.
 */
export interface ProcessorTestHooks {
  /** Chiamato nel percorso errore quando la SELECT non trova il gruppo,
   * prima della creazione del ticket. */
  beforeTicketCreate?: () => Promise<void>;
}

function truncate(text: string): string {
  return text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`;
}

/**
 * Sentinella interna: lanciata dentro la transazione quando l'insert del
 * gruppo trova il vincolo unique già occupato (race persa). Far esplodere
 * la transazione è il modo più pulito di disfare il ticket appena creato:
 * il rollback cancella ticket e incremento del contatore, senza orfani né
 * buchi nella numerazione. Il chiamante ritenta l'evento come update.
 */
class GroupConflictError extends Error {
  constructor() {
    super("Conflitto sul vincolo unique di error_groups: gruppo creato da un concorrente");
    this.name = "GroupConflictError";
  }
}

/**
 * Dedup di un evento errore via ErrorGroup.
 *
 * Strategia sulla race (due ingestion concorrenti dello stesso errore
 * nuovo): non si può inserire il gruppo "in anticipo" perché ha bisogno del
 * ticketId, e creare prima il ticket lascerebbe orfani in caso di
 * conflitto. Quindi:
 *
 * 1. SELECT del gruppo: se esiste → UPDATE occurrences/lastSeenAt (dedup).
 * 2. Altrimenti crea il ticket, poi INSERT del gruppo con
 *    `onConflictDoNothing` + RETURNING.
 * 3. Se l'insert non restituisce righe, un concorrente ha vinto la corsa
 *    tra la SELECT e l'INSERT: si lancia {@link GroupConflictError} per
 *    far fare rollback all'intera transazione (il ticket appena creato
 *    sparisce) e si ritenta l'evento — al giro dopo la SELECT trova il
 *    gruppo del vincitore e si dedupa come update.
 *
 * Sotto READ COMMITTED l'insert in conflitto con una riga non ancora
 * committata attende il commit del concorrente, quindi al retry il gruppo
 * è visibile: il loop converge sempre (cap difensivo a {@link MAX_ATTEMPTS}).
 */
async function processErrorEvent(
  db: Db,
  projectId: string,
  event: ErrorEvent,
  hooks?: ProcessorTestHooks,
): Promise<"created" | "deduped"> {
  const fp = fingerprint({
    errorType: event.errorType,
    message: event.message,
    stack: event.stack,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [group] = await tx
          .select({ ticketId: errorGroups.ticketId })
          .from(errorGroups)
          .where(and(eq(errorGroups.projectId, projectId), eq(errorGroups.fingerprint, fp)))
          .limit(1);

        if (group) {
          await tx
            .update(tickets)
            .set({
              occurrences: sql`${tickets.occurrences} + 1`,
              lastSeenAt: new Date(),
            })
            .where(eq(tickets.id, group.ticketId));
          return "deduped";
        }

        await hooks?.beforeTicketCreate?.();

        const ticket = await createTicket(tx, {
          projectId,
          title: truncate(`${event.errorType ?? "Error"}: ${event.message}`),
          type: "bug",
          priority: "medium",
          source: "sdk_error",
          technicalPayload: {
            message: event.message,
            stack: event.stack,
            url: event.url,
            release: event.release,
            environment: event.environment,
            breadcrumbs: event.breadcrumbs,
            timestamp: event.timestamp,
          },
        });

        const inserted = await tx
          .insert(errorGroups)
          .values({ projectId, fingerprint: fp, ticketId: ticket.id })
          .onConflictDoNothing()
          .returning({ id: errorGroups.id });
        if (inserted.length === 0) {
          throw new GroupConflictError();
        }

        await tx.insert(aiJobs).values({ ticketId: ticket.id });
        return "created";
      });
    } catch (err) {
      if (err instanceof GroupConflictError) continue;
      throw err;
    }
  }
  throw new Error(
    `Impossibile processare l'evento errore dopo ${MAX_ATTEMPTS} tentativi (fingerprint ${fp})`,
  );
}

/** I feedback non si dedupano: ogni segnalazione utente è un ticket. */
async function processFeedbackEvent(
  db: Db,
  projectId: string,
  event: FeedbackEvent,
): Promise<void> {
  const bodyLines = [
    event.message,
    ...(event.email !== undefined ? [`Email: ${event.email}`] : []),
    ...(event.url !== undefined ? [`URL: ${event.url}`] : []),
    ...(event.release !== undefined ? [`Release: ${event.release}`] : []),
  ];
  await db.transaction(async (tx) => {
    const ticket = await createTicket(tx, {
      projectId,
      title: truncate(event.message),
      body: bodyLines.join("\n"),
      type: "feedback",
      priority: "medium",
      source: "sdk_feedback",
    });
    await tx.insert(aiJobs).values({ ticketId: ticket.id });
  });
}

/** Creazione ticket esplicita via SDK/API: type e priority li sceglie il client. */
async function processTicketEvent(
  db: Db,
  projectId: string,
  event: TicketCreateEvent,
): Promise<void> {
  await db.transaction(async (tx) => {
    const ticket = await createTicket(tx, {
      projectId,
      title: truncate(event.title),
      body: event.body,
      type: event.type,
      priority: event.priority,
      source: "api",
    });
    await tx.insert(aiJobs).values({ ticketId: ticket.id });
  });
}

/**
 * Processa un batch di eventi di ingestion per un progetto. Gli eventi
 * errore collassano per fingerprint in un ErrorGroup (un solo ticket e un
 * solo job AI per errore unico); feedback ed eventi ticket creano sempre un
 * ticket. Per ogni ticket nuovo viene accodato un aiJob `queued` nella
 * stessa transazione.
 *
 * Gli eventi sono processati in sequenza: ognuno nella propria transazione,
 * così un evento malformato a metà batch non disfa i precedenti.
 */
export async function processEvents(
  db: Db,
  project: { id: string },
  events: IngestEvent[],
  hooks?: ProcessorTestHooks,
): Promise<ProcessResult> {
  const result: ProcessResult = { created: 0, deduped: 0 };
  for (const event of events) {
    switch (event.kind) {
      case "error": {
        const outcome = await processErrorEvent(db, project.id, event, hooks);
        result[outcome] += 1;
        break;
      }
      case "feedback":
        await processFeedbackEvent(db, project.id, event);
        result.created += 1;
        break;
      case "ticket":
        await processTicketEvent(db, project.id, event);
        result.created += 1;
        break;
    }
  }
  return result;
}
