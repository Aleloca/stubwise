import { aiJobs, createDb, ticketEvents, tickets, type Db } from "@stubwise/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";

/**
 * BACKFILL UNA TANTUM degli eventi di chiusura mancanti (fase 5).
 *
 *   pnpm --filter @stubwise/server backfill:ticket-events -- --dry-run
 *   pnpm --filter @stubwise/server backfill:ticket-events
 *
 * Fino alla fase 5 solo `PATCH /api/tickets/:id` scriveva un `status_changed`:
 * le chiusure fatte dal webhook git (PR mergiata → `done`) non lasciavano
 * traccia. Da qui in avanti la traccia c'è, ma la storia PASSATA resterebbe
 * vuota — e la timeline di progetto mostrerebbe come chiusi i soli ticket
 * chiusi a mano dalla web app.
 *
 * NON è una migrazione, ed è una scelta: una migrazione gira su ogni istanza
 * dentro la transazione dell'avvio del server, mentre questo è un ripasso di
 * dati storici che può toccare molte righe, va lanciato quando si vuole e può
 * essere provato prima con `--dry-run`.
 *
 * IDEMPOTENTE: salta i ticket che hanno già un `status_changed` verso `done`
 * (un `status_changed` verso un ALTRO stato non conta: quel ticket ha una
 * transizione tracciata, non LA chiusura). Rilanciarlo è sempre sicuro.
 *
 * DATA dell'evento: `max(ai_jobs.finished_at)` del job `pr_merged` del ticket,
 * altrimenti `tickets.updated_at`. Non `now()`: datare tutto oggi metterebbe
 * l'intera storia dell'istanza nella settimana corrente della timeline.
 *
 * `from` è convenzionalmente `in_review`, lo stato da cui la pipeline porta a
 * `done`. È una ricostruzione, non un dato: lo stato precedente reale non è
 * recuperabile a posteriori, e per un backfill dichiararlo così è più onesto
 * che inventare un `from` diverso per riga.
 */

/** Esito di un giro di backfill. */
export interface BackfillResult {
  /** Ticket `done` senza evento di chiusura trovati. */
  candidates: number;
  /** Eventi effettivamente inseriti (0 con `--dry-run`). */
  inserted: number;
}

/** Stato da cui si dichiara avvenuta la chiusura ricostruita. Vedi il docblock. */
const ASSUMED_FROM_STATUS = "in_review";

export async function backfillTicketDoneEvents(
  db: Db,
  opts: { dryRun: boolean },
): Promise<BackfillResult> {
  // I candidati: ticket `done` che NON hanno un `status_changed` con
  // payload->>'to' = 'done'. Il NOT EXISTS è la condizione di idempotenza.
  const rows = await db
    .select({ id: tickets.id, updatedAt: tickets.updatedAt })
    .from(tickets)
    .where(
      and(
        eq(tickets.status, "done"),
        sql`not exists (
          select 1 from ${ticketEvents}
          where ${ticketEvents.ticketId} = ${tickets.id}
            and ${ticketEvents.kind} = 'status_changed'
            and ${ticketEvents.payload}->>'to' = 'done'
        )`,
      ),
    );

  if (opts.dryRun || rows.length === 0) {
    return { candidates: rows.length, inserted: 0 };
  }

  // Data del merge per i soli candidati, in UNA query aggregata. Volutamente
  // separata invece che come sottoquery correlata nella projection: lì drizzle
  // rende i nomi di colonna NON qualificati, e `ai_jobs.ticket_id = "id"`
  // finirebbe per confrontare due colonne di `ai_jobs` — sempre falso, con
  // ogni evento datato dal fallback senza che nulla segnali l'errore.
  const mergedRows = await db
    .select({
      ticketId: aiJobs.ticketId,
      mergedAt: sql<string | null>`max(${aiJobs.finishedAt})`,
    })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.status, "pr_merged"),
        inArray(
          aiJobs.ticketId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .groupBy(aiJobs.ticketId);
  const mergedAtByTicket = new Map<string, Date>();
  for (const row of mergedRows) {
    if (row.mergedAt) mergedAtByTicket.set(row.ticketId, new Date(row.mergedAt));
  }

  // Un solo INSERT: il backfill tocca dati storici, non c'è ragione di fare
  // una andata e ritorno per ticket.
  await db.insert(ticketEvents).values(
    rows.map((row) => ({
      ticketId: row.id,
      // Sistema: la chiusura la fece il merge, nessuna persona.
      actorId: null,
      kind: "status_changed" as const,
      payload: { from: ASSUMED_FROM_STATUS, to: "done" },
      createdAt: mergedAtByTicket.get(row.id) ?? row.updatedAt,
    })),
  );

  return { candidates: rows.length, inserted: rows.length };
}

/**
 * Entry point CLI. Separato dalla funzione così i test esercitano la logica su
 * un Postgres di test senza toccare env né process.exit.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[backfill] DATABASE_URL non impostata");
    process.exit(1);
  }
  const handle = createDb(databaseUrl);
  try {
    const result = await backfillTicketDoneEvents(handle.db, { dryRun });
    console.log(
      dryRun
        ? `[backfill] --dry-run: ${result.candidates} ticket done senza evento di chiusura (nessuna scrittura)`
        : `[backfill] ${result.inserted} eventi di chiusura inseriti`,
    );
  } finally {
    await handle.client.end();
  }
}

// Eseguito solo quando il file è il modulo di INGRESSO, mai quando è importato
// dai test (che chiamano `backfillTicketDoneEvents` su un DB di prova).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
