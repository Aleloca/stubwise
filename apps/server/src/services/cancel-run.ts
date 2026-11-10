import { aiJobs, comments, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { completeCorrection, promotePendingForTicket } from "@stubwise/notifications";
import type { ProjectPermission } from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { getContentLanguage } from "../settings.js";

/**
 * «Annulla il lavoro» (integrazione area 3, fetta 3b; decisione del maintainer
 * del 10 nov 2026, opzione A): chiude SUBITO l'ultimo job della task se è
 * PARCHEGGIATO, cioè senza un processo vivo — in coda (`queued`), fermo
 * (`held`), sul gate del piano (`awaiting_plan_approval`), su una domanda
 * (`awaiting_input`: il CLI è già uscito, la risposta lo riprende da
 * `cli_session_id`).
 *
 * - Un job IN ESECUZIONE (`triaging`, `fixing`) → `run_in_progress`: il server
 *   non sa fermare il processo del worker (le sue scritture sono guardate sulla
 *   ownership e se ne accorgerebbe dopo push e PR). Si ferma con «Ferma»;
 *   l'annullamento in corsa è un passo a sé (3b.1-bis, col worker).
 * - Il job si chiude `skipped`, come uno «Ferma» scaduto: nessun valore di enum
 *   nuovo, nessun `job.failed`.
 * - Job e correzione si chiudono INSIEME (`docs/invariants/pr-corrections.md`):
 *   la correzione passa a `done` nella stessa transazione (conta come giro,
 *   come la chiusura di uno «Ferma»), e DOPO il commit si promuove la pending
 *   del ticket (`promotePendingForTicket`, mai dentro: vedrebbe ancora il job).
 * - PR e branch NON si toccano; lo stato della task nemmeno (come
 *   `recordAgentStopExpired`: una persona può averlo cambiato).
 * - Un commento di SISTEMA da template, mai testo dell'AI.
 * Il permesso (`runs.start`) lo dichiara la rotta e si riverifica qui.
 */

const PARKED = ["queued", "held", "awaiting_plan_approval", "awaiting_input"] as const;
const RUNNING = ["triaging", "fixing"] as const;

export type CancelRunResult =
  | { ok: true }
  | { ok: false; error: "forbidden" | "nothing_to_cancel" | "run_in_progress" };

export async function cancelRun(
  db: Db,
  input: { ticketId: string; actor: { id: string; email: string; permissions: ReadonlySet<ProjectPermission> } },
): Promise<CancelRunResult> {
  const { ticketId, actor } = input;
  if (!actor.permissions.has("runs.start")) return { ok: false, error: "forbidden" };
  const lang = await getContentLanguage(db);
  const result = await db.transaction(async (tx): Promise<CancelRunResult> => {
    // Lo stesso lock del ticket di `startRun`: un avvio e un annullamento non si incrociano.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
    const [latest] = await tx
      .select({ id: aiJobs.id, status: aiJobs.status, correctionId: aiJobs.correctionId })
      .from(aiJobs)
      .where(eq(aiJobs.ticketId, ticketId))
      .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
      .limit(1);
    if (!latest) return { ok: false, error: "nothing_to_cancel" };
    if ((RUNNING as readonly string[]).includes(latest.status)) return { ok: false, error: "run_in_progress" };
    if (!(PARKED as readonly string[]).includes(latest.status)) return { ok: false, error: "nothing_to_cancel" };
    // Guardato sullo stato letto: il worker può reclamarlo proprio ora (claim di un `queued`).
    const closed = await tx
      .update(aiJobs)
      .set({ status: "skipped", finishedAt: sql`now()`, lastActivityAt: sql`now()` })
      .where(and(eq(aiJobs.id, latest.id), eq(aiJobs.status, latest.status)))
      .returning({ id: aiJobs.id });
    if (closed.length === 0) return { ok: false, error: "run_in_progress" };
    if (latest.correctionId) await completeCorrection(tx, latest.correctionId);
    const body = [
      t(lang, "comment.runCancelled.head", { who: actor.email }),
      t(lang, latest.correctionId ? "comment.agentStopCancelled.correction" : "comment.agentStopCancelled.fix"),
    ].join(" ");
    await tx.insert(comments).values({ ticketId, authorType: "system", body });
    return { ok: true };
  });
  if (result.ok) await promotePendingForTicket(db, ticketId);
  return result;
}
