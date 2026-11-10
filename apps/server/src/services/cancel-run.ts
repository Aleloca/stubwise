import { agentQuestions, aiJobs, comments, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { completeCorrection, promotePendingForTicket } from "@stubwise/notifications";
import { AI_JOB_CANCEL_CHANNEL, type ProjectPermission } from "@stubwise/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { mirrorDecision, propagateHandled } from "./notifications-propagation.js";
import { notifyTaskActivity } from "./task-notify.js";
import { getContentLanguage } from "../settings.js";

/**
 * «Annulla il lavoro» (integrazione area 3, fetta 3b; decisione del maintainer
 * del 10 nov 2026, opzione A): chiude SUBITO l'ultimo job della task se è
 * PARCHEGGIATO, cioè senza un processo vivo — in coda (`queued`), fermo
 * (`held`), sul gate del piano (`awaiting_plan_approval`), su una domanda
 * (`awaiting_input`: il CLI è già uscito, la risposta lo riprende da
 * `cli_session_id`).
 *
 * - Un job IN ESECUZIONE (`triaging`, `fixing`, 3b.1-bis): il server non ne
 *   tocca lo stato (è del worker); registra la richiesta
 *   (`cancel_requested_at`/`_by_user_id`) e la annuncia (`AI_JOB_CANCEL_CHANNEL`).
 *   Il worker ferma il CLI e chiude `skipped` senza commit, push né PR
 *   (`apps/worker/src/pipeline/cancel.ts`); il commento e l'avviso li scrive lui.
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
  /** `closed`: un job parcheggiato, chiuso qui. `requested`: un job in esecuzione, lo chiude il worker. */
  | { ok: true; kind: "closed" | "requested" }
  | { ok: false; error: "forbidden" | "nothing_to_cancel" | "run_in_progress" };

export async function cancelRun(
  db: Db,
  input: {
    ticketId: string;
    actor: { id: string; email: string; permissions: ReadonlySet<ProjectPermission> };
    log?: { warn: (obj: object, msg: string) => void };
  },
): Promise<CancelRunResult> {
  const { ticketId, actor, log } = input;
  if (!actor.permissions.has("runs.start")) return { ok: false, error: "forbidden" };
  const lang = await getContentLanguage(db);
  const closedCards: string[] = [];
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
    if ((RUNNING as readonly string[]).includes(latest.status)) {
      // In esecuzione (3b.1-bis): il server non tocca lo stato di un job che il
      // worker possiede. Registra la richiesta (chi, quando: la fonte, che
      // sopravvive a un riavvio) e la annuncia col NOTIFY; il worker ferma il
      // CLI, non fa commit né push, e chiude `skipped`. Ripeterla non cambia
      // la richiesta già scritta.
      const requested = await tx
        .update(aiJobs)
        .set({ cancelRequestedAt: sql`now()`, cancelRequestedByUserId: actor.id })
        .where(and(eq(aiJobs.id, latest.id), inArray(aiJobs.status, [...RUNNING]), isNull(aiJobs.cancelRequestedAt)))
        .returning({ id: aiJobs.id });
      if (requested.length > 0) {
        await tx.execute(sql`select pg_notify(${AI_JOB_CANCEL_CHANNEL}, ${JSON.stringify({ jobId: latest.id })})`);
      }
      return { ok: true, kind: "requested" };
    }
    if (!(PARKED as readonly string[]).includes(latest.status)) return { ok: false, error: "nothing_to_cancel" };
    // Guardato sullo stato letto: il worker può reclamarlo proprio ora (claim di un `queued`).
    const closed = await tx
      .update(aiJobs)
      .set({
        status: "skipped",
        finishedAt: sql`now()`,
        lastActivityAt: sql`now()`,
        cancelRequestedAt: sql`now()`,
        cancelRequestedByUserId: actor.id,
      })
      .where(and(eq(aiJobs.id, latest.id), eq(aiJobs.status, latest.status)))
      .returning({ id: aiJobs.id });
    if (closed.length === 0) return { ok: false, error: "run_in_progress" };
    if (latest.correctionId) await completeCorrection(tx, latest.correctionId);
    // Un'altra uscita da `awaiting_input` (e dal gate): le card che aspettavano
    // una risposta o una decisione si chiudono QUI, attribuite a chi annulla —
    // non sono archiviabili, e resterebbero aperte per sempre
    // (`packages/notifications/src/actions.ts`). Solo quei due kind: un
    // `job.failed` di prima dello stesso job non c'entra.
    for (const kind of ["job.awaiting_input", "job.plan_review"] as const) {
      closedCards.push(...(await propagateHandled(tx, { jobId: latest.id, kind }, actor.id)));
    }
    // La domanda aperta si chiude come ANNULLATA, distinta da una risposta.
    await tx
      .update(agentQuestions)
      .set({ cancelledAt: sql`now()` })
      .where(and(eq(agentQuestions.jobId, latest.id), isNull(agentQuestions.answeredAt), isNull(agentQuestions.cancelledAt)));
    const body = [
      t(lang, "comment.runCancelled.head", { who: actor.email }),
      t(lang, latest.correctionId ? "comment.agentStopCancelled.correction" : "comment.agentStopCancelled.fix"),
    ].join(" ");
    await tx.insert(comments).values({ ticketId, authorType: "system", body });
    // Ai follower: il cambio come DATO (`run_cancelled`), la frase la mette il template.
    await notifyTaskActivity(tx, { ticketId, actorUserId: actor.id, change: "run_cancelled", summary: "" });
    return { ok: true, kind: "closed" };
  });
  if (result.ok && result.kind === "closed") {
    // Dopo il commit, e mai a costo dell'annullamento già fatto: un errore qui
    // si registra e basta (la pending la ripesca il tick del worker, il DM
    // Slack resta da riscrivere).
    try {
      await promotePendingForTicket(db, ticketId);
    } catch (error) {
      log?.warn({ err: error, ticketId }, "cancel-run: promozione della pending non riuscita");
    }
    if (closedCards.length > 0) {
      await mirrorDecision(db, { notificationIds: closedCards, action: "handled", actorId: actor.id }).catch((error: unknown) =>
        log?.warn({ err: error, ticketId }, "cancel-run: rispecchiamento delle card non riuscito"),
      );
    }
  }
  return result;
}
