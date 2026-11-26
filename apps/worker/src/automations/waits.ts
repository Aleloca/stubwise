import { automationEffects, automationRunInputs, automationRunLog, automationRuns, automations, automationVersions, googleAccounts, mailOutgoing, type Db } from "@stubwise/db";
import { stepAt, type AutomationFlow, type Step } from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { effectKey } from "./effects.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WaitStep = Extract<Step, { kind: "wait" }>;

/**
 * LE ATTESE (area 7, F2, S5; piano C-F2-4). Un `wait` è un'esecuzione in
 * `waiting_event`: la scadenza è `due_at` (il poller del motore la riprende e
 * il motore dà `risposta.arrivata = false` / `chiusa = false`); cosa aspetta sta
 * in due colonne indicizzate, così chi sveglia legge SOLO le attese giuste:
 *
 * - `waiting_thread` = `<accountId>:<gmailThreadId>` dell'email partita dal
 *   passo `replyTo`: la sveglia il poller Google, per un messaggio RICEVUTO in
 *   quella conversazione E in quella casella (mai un'altra conversazione, mai
 *   un'altra casella, mai la posta mandata dalla casella stessa);
 * - `waiting_ticket_id` = la task creata dal passo `taskClosed` in QUESTA
 *   esecuzione: la sveglia l'evento `task_closed` (il consumatore).
 *
 * Chi sveglia mette un input `event` in coda, come una decisione: il motore lo
 * applica al giro. Un input arrivato mentre l'esecuzione è sospesa (pausa)
 * resta in coda e vale alla ripresa (F2-6 = a).
 */

/** Il path dell'ultima esecuzione riuscita di un passo (per id) in una run. */
async function lastPathOf(db: Db | Tx, runId: string, stepId: string): Promise<string | null> {
  const [row] = await (db as Db)
    .select({ path: automationRunLog.path })
    .from(automationRunLog)
    .where(and(eq(automationRunLog.runId, runId), eq(automationRunLog.stepId, stepId), eq(automationRunLog.outcome, "ok")))
    .orderBy(desc(automationRunLog.seq))
    .limit(1);
  return row?.path ?? null;
}

async function effectObject(db: Db | Tx, runId: string, path: string): Promise<string | null> {
  const [e] = await (db as Db).select({ objectId: automationEffects.objectId }).from(automationEffects).where(eq(automationEffects.idempotencyKey, effectKey(runId, path)));
  return e?.objectId ?? null;
}

/** Cosa aspetta un `wait` (le colonne di C-F2-4), letto dal registro e dagli effetti della run. */
export async function waitingTargets(db: Db | Tx, runId: string, step: WaitStep): Promise<{ waitingThread: string | null; waitingTicketId: string | null }> {
  const w = step.for;
  if ("replyTo" in w) {
    const path = await lastPathOf(db, runId, w.replyTo);
    const mailId = path ? await effectObject(db, runId, path) : null;
    const [mail] = mailId ? await (db as Db).select({ accountId: mailOutgoing.accountId, threadId: mailOutgoing.gmailThreadId }).from(mailOutgoing).where(eq(mailOutgoing.id, mailId)) : [];
    return { waitingThread: mail?.threadId ? `${mail.accountId}:${mail.threadId}` : null, waitingTicketId: null };
  }
  if ("taskClosed" in w) {
    const path = await lastPathOf(db, runId, w.taskClosed);
    return { waitingThread: null, waitingTicketId: path ? await effectObject(db, runId, path) : null };
  }
  return { waitingThread: null, waitingTicketId: null };
}

/** Il passo `wait` su cui una run è ferma, dal suo flusso e dal cursore. */
async function waitStepOf(db: Db | Tx, run: typeof automationRuns.$inferSelect): Promise<WaitStep | null> {
  const [v] = await (db as Db)
    .select({ flow: automationVersions.flow })
    .from(automationVersions)
    .where(and(eq(automationVersions.automationId, run.automationId), eq(automationVersions.n, run.version)));
  const path = (run.cursor as { path?: string | null } | null)?.path;
  const step = v && path ? stepAt((v.flow as AutomationFlow).steps, path) : null;
  return step?.kind === "wait" ? step : null;
}

/** Le run in attesa su una conversazione o una task (anche sospese: l'input aspetta la ripresa). */
const WAITING = sql`(${automationRuns.status} = 'waiting_event' or (${automationRuns.status} = 'suspended' and ${automationRuns.cursor}->>'suspendedFrom' = 'waiting_event'))`;

/**
 * Una RISPOSTA ricevuta in una conversazione (il poller Google, per un
 * messaggio ricevuto e non mandato dalla casella): sveglia le attese della
 * risposta su `<accountId>:<threadId>`. Ritorna quante.
 */
export async function wakeReplyWaits(db: Db | Tx, mail: { accountId: string; threadId: string; text: string; gmailMessageId?: string }): Promise<number> {
  // C1 (review F2): solo le esecuzioni di QUESTA casella, e solo se l'automazione
  // è ancora del proprietario della casella (passata a un altro, la posta di
  // prima non la sveglia più: non deve arrivare a lui).
  const runs = (
    await (db as Db)
      .select({ run: automationRuns })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .innerJoin(googleAccounts, eq(googleAccounts.id, mail.accountId))
      .where(and(eq(automationRuns.waitingThread, `${mail.accountId}:${mail.threadId}`), eq(automationRuns.mailboxAccountId, mail.accountId), eq(automations.ownerId, googleAccounts.userId), WAITING))
  ).map((r) => r.run);
  let woken = 0;
  for (const run of runs) {
    const step = await waitStepOf(db, run);
    if (!step || !("replyTo" in step.for)) continue;
    // Review F2, M1: una risposta sveglia UNA volta (un resync o un lotto rifatto la
    // rileggono), e una vecchia non sveglia l'attesa di un giro dopo.
    if (mail.gmailMessageId) {
      const [seen] = await (db as Db)
        .select({ id: automationRunInputs.id })
        .from(automationRunInputs)
        .where(and(eq(automationRunInputs.runId, run.id), sql`${automationRunInputs.input}->>'messageId' = ${mail.gmailMessageId}`))
        .limit(1);
      if (seen) continue;
    }
    await (db as Db).insert(automationRunInputs).values({
      runId: run.id,
      input: { kind: "event", payload: { kind: "reply", to: step.for.replyTo, text: mail.text }, ...(mail.gmailMessageId ? { messageId: mail.gmailMessageId } : {}) },
      byId: null,
    });
    woken += 1;
  }
  return woken;
}

/** Una task chiusa (l'evento `task_closed`): sveglia le attese di quella task. */
export async function wakeTaskWaits(db: Db | Tx, ticketId: string): Promise<number> {
  const runs = await (db as Db).select().from(automationRuns).where(and(eq(automationRuns.waitingTicketId, ticketId), WAITING));
  let woken = 0;
  for (const run of runs) {
    const step = await waitStepOf(db, run);
    if (!step || !("taskClosed" in step.for)) continue;
    await (db as Db).insert(automationRunInputs).values({ runId: run.id, input: { kind: "event", payload: { kind: "task_closed", taskStepId: step.for.taskClosed } }, byId: null });
    woken += 1;
  }
  return woken;
}
