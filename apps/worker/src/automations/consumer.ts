import {
  automationEvents,
  automationRuns,
  automations,
  automationVersions,
  googleAccounts,
  mailOutgoing,
  type Db,
} from "@stubwise/db";
import { automationEventFields as eventFields, projectPermissionsOfUser } from "@stubwise/notifications";
import { wakeTaskWaits } from "./waits.js";
import { chainAllows, evaluate, initialState, lookup, render, type AutomationFlow } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

/**
 * IL CONSUMATORE DEGLI EVENTI (area 7, fetta 1): dall'outbox
 * `automation_events`, che scrivono SOLO i trigger della 0169, alle
 * esecuzioni. Le regole (`docs/invariants/automations.md`, e `startsOn` /
 * `chainAllows` del prototipo, `data/automations/sources.ts`):
 *
 * - parte un'automazione del PROGETTO dell'evento, `active`, con un
 *   proprietario che vede il progetto, la cui versione pubblicata ascolta
 *   quell'evento e il cui filtro d'inizio vale sui campi dell'evento;
 * - NIENTE RECUPERO RETROATTIVO: l'evento nato prima di `active_since` non
 *   la avvia (accenderla, o riaccenderla, non riprende gli eventi vecchi);
 * - la CATENA: un evento scritto da un'esecuzione (`origin_run_id`) non
 *   riavvia un'automazione già fra gli antenati, e la catena si ferma a
 *   `CHAIN_MAX`; l'esecuzione nuova è figlia di quella d'origine;
 * - al più {@link MAX_ACTIVE_RUNS} esecuzioni non finite per automazione;
 * - gli eventi di una transazione si leggono con la conversione PRIMA della
 *   task che ne nasce (Q5: `txid`, poi `request_converted`, poi l'ora);
 * - i campi dell'inizio (`triggerFields.ts`) si compongono dalle righe vere
 *   al consumo: alcuni (i richiedenti di una voce) si scrivono DOPO la riga
 *   nella stessa transazione, e il trigger non li vede. Un oggetto sparito
 *   nel frattempo ripiega sulla fotografia del trigger.
 *
 * Un batch è UNA transazione: le esecuzioni nate e gli eventi consumati
 * entrano insieme. `FOR UPDATE SKIP LOCKED`: due worker non consumano lo
 * stesso evento. Il consumatore non esegue nulla: le esecuzioni nascono
 * `running` e dovute, le muove l'esecutore.
 */

/** Il massimo di esecuzioni non finite per automazione (Global Constraints del piano). */
export const MAX_ACTIVE_RUNS = 100;
/** Gli eventi letti per giro. */
export const EVENT_BATCH = 100;
/** Gli eventi consumati si tengono un po' per diagnosi, poi si tolgono. */
export const CONSUMED_RETENTION_DAYS = 7;

const OPEN_STATUSES = ["running", "waiting_approval", "waiting_project", "suspended"] as const;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EventRow = typeof automationEvents.$inferSelect;

export interface ConsumerDeps {
  db: Db;
  log?: (msg: string) => void;
}

/**
 * La chiave dell'advisory lock del consumatore (review F1, M3): un consumatore
 * alla volta. Con due consumatori e SKIP LOCKED gli eventi di una stessa
 * transazione (la stessa txid) potevano dividersi fra due giri concorrenti, e
 * l'ordine di Q5 (la conversione prima della task) dipendeva dal caso. Un
 * lotto ogni pochi secondi basta: chi non prende il lock salta il giro.
 */
export const CONSUMER_LOCK_KEY = 7_207_001;

/** Un giro: consuma un batch di eventi e ritorna quanti. Lancia solo su un guasto del DB. */
export async function consumeAutomationEvents(deps: ConsumerDeps): Promise<number> {
  const log = deps.log ?? (() => {});
  const consumed = await deps.db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${CONSUMER_LOCK_KEY}) as ok`);
    if (!lock?.ok) return 0;
    const batch = await tx
      .select()
      .from(automationEvents)
      .where(sql`${automationEvents.consumedAt} is null`)
      .orderBy(asc(automationEvents.txid), sql`(${automationEvents.kind} <> 'request_converted')`, asc(automationEvents.createdAt))
      .limit(EVENT_BATCH)
      .for("update", { skipLocked: true });
    for (const event of batch) {
      // S5: una task chiusa sveglia le attese che la aspettano (un passo `wait` taskClosed della stessa esecuzione).
      if (event.kind === "task_closed" && event.objectId) {
        const woken = await wakeTaskWaits(tx, event.objectId);
        if (woken > 0) log(`[automations] task ${event.objectId} chiusa: ${woken} attese svegliate`);
      }
      const started = await startRunsFor(tx, event, log);
      if (started > 0) log(`[automations] evento ${event.kind} ${event.objectId}: ${started} esecuzioni`);
    }
    if (batch.length > 0) {
      await tx.update(automationEvents).set({ consumedAt: sql`now()` }).where(inArray(automationEvents.id, batch.map((e) => e.id)));
      // Il testo di un'email resta solo nelle esecuzioni partite (il registro, del proprietario): l'evento lo perde.
      await tx.execute(sql`
        update ${automationEvents} set "payload" = jsonb_set("payload", '{email,testo}', '""'::jsonb)
        where "kind" = 'mail_received' and "id" in (${sql.join(batch.map((e) => sql`${e.id}`), sql`, `)})
      `);
    }
    return batch.length;
  });
  await deps.db
    .delete(automationEvents)
    .where(and(isNotNull(automationEvents.consumedAt), sql`${automationEvents.consumedAt} < now() - make_interval(days => ${CONSUMED_RETENTION_DAYS})`));
  return consumed;
}

/** Le esecuzioni che l'evento fa nascere. */
async function startRunsFor(tx: Tx, row: EventRow, log: (msg: string) => void): Promise<number> {
  // Un evento della posta (0170, F2) non ha progetto né riga: ha il suo percorso (`mail_received`, S8).
  if (row.kind === "mail_received") return startMailRunsFor(tx, row, log);
  if (row.projectId === null || row.objectId === null) return 0;
  const event = { ...row, projectId: row.projectId, objectId: row.objectId, kind: row.kind as Exclude<EventRow["kind"], "mail_received"> };
  const candidates = await tx
    .select({ automation: automations })
    .from(automations)
    .where(
      and(
        eq(automations.projectId, event.projectId),
        eq(automations.status, "active"),
        isNotNull(automations.ownerId),
        isNotNull(automations.activeSince),
        lte(automations.activeSince, event.createdAt),
      ),
    )
    .orderBy(asc(automations.code));
  if (candidates.length === 0) return 0;
  const ancestors = event.originRunId ? await ancestorsOf(tx, event.originRunId) : [];
  // L'esecuzione d'origine può essere sparita (il suo progetto eliminato prima
  // del consumo): `origin_run_id` non ha FK, `parent_run_id` sì.
  const parentRunId = ancestors.length > 0 ? event.originRunId : null;
  let fields: Record<string, unknown> | null = null;
  let started = 0;
  for (const { automation: a } of candidates) {
    // Un savepoint per automazione (review F1, I2): un avvio che lancia non
    // annulla il lotto e non lo fa rileggere per sempre; si salta, col log.
    try {
      const ok = await tx.transaction(async (sp) => {
        const version = await publishedVersion(sp, a.id);
        if (!version) return false;
        const flow = version.flow as AutomationFlow;
        const trigger = flow.trigger;
        if (trigger.kind !== "stubwise" || trigger.event !== event.kind) return false;
        if (!(await projectPermissionsOfUser(sp, a.ownerId!, event.projectId))) return false;
        if (event.originRunId && !chainAllows(ancestors, a.id)) return false;
        fields ??= await eventFields(sp, event);
        if (trigger.filter && !evaluate(trigger.filter, (key) => lookup(fields!, key))) return false;
        return createRun(sp, a, version.n, flow, fields, event, parentRunId);
      });
      if (ok) started += 1;
    } catch (err) {
      log(`[automations] evento ${event.kind} ${event.objectId}, automazione ${a.code}: avvio saltato (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return started;
}

/**
 * «Email in arrivo» (area 7, F2, S8): le automazioni accese che ascoltano la
 * CASELLA dell'evento, solo se ne sono il proprietario (`mailbox_owner`: un
 * admin non legge la posta di un altro, R-J13). Mai una risposta nella
 * conversazione in cui la stessa automazione ha mandato un'email (C-F2-5, il
 * botta e risposta: quella sveglia solo le sue attese, `mail-in.ts`).
 */
async function startMailRunsFor(tx: Tx, row: EventRow, log: (msg: string) => void): Promise<number> {
  if (!row.accountId) return 0;
  const [account] = await tx.select({ userId: googleAccounts.userId }).from(googleAccounts).where(eq(googleAccounts.id, row.accountId));
  if (!account) return 0;
  const payload = (row.payload ?? {}) as { email?: Record<string, unknown>; threadId?: string };
  const fields = { email: payload.email ?? {} };
  const candidates = await tx
    .select({ automation: automations })
    .from(automations)
    .where(
      and(
        eq(automations.mailboxAccountId, row.accountId),
        eq(automations.status, "active"),
        eq(automations.ownerId, account.userId),
        isNotNull(automations.activeSince),
        lte(automations.activeSince, row.createdAt),
      ),
    )
    .orderBy(asc(automations.code));
  let started = 0;
  for (const { automation: a } of candidates) {
    try {
      const ok = await tx.transaction(async (sp) => {
        const version = await publishedVersion(sp, a.id);
        if (!version) return false;
        const flow = version.flow as AutomationFlow;
        const trigger = flow.trigger;
        if (trigger.kind !== "stubwise" || trigger.event !== "mail_received") return false;
        if (!(await projectPermissionsOfUser(sp, a.ownerId!, a.projectId))) return false;
        if (payload.threadId) {
          const [pingPong] = await sp
            .select({ id: mailOutgoing.id })
            .from(mailOutgoing)
            .innerJoin(automationRuns, eq(automationRuns.id, mailOutgoing.automationRunId))
            .where(and(eq(mailOutgoing.accountId, row.accountId!), eq(mailOutgoing.gmailThreadId, payload.threadId), eq(automationRuns.automationId, a.id)))
            .limit(1);
          if (pingPong) return false;
        }
        if (trigger.filter && !evaluate(trigger.filter, (key) => lookup(fields, key))) return false;
        return createRun(sp, a, version.n, flow, fields, row, null);
      });
      if (ok) started += 1;
    } catch (err) {
      log(`[automations] email ${row.dedupeKey ?? row.id}, automazione ${a.code}: avvio saltato (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return started;
}

/** La versione con cui partono le esecuzioni nuove: l'ultima pubblicata. */
async function publishedVersion(tx: Tx, automationId: string) {
  const [v] = await tx
    .select({ n: automationVersions.n, flow: automationVersions.flow })
    .from(automationVersions)
    .where(and(eq(automationVersions.automationId, automationId), isNotNull(automationVersions.publishedAt)))
    .orderBy(desc(automationVersions.n))
    .limit(1);
  return v ?? null;
}

/** L'esecuzione d'origine e le sue antenate (`parent_run_id`), dalla più vicina. */
async function ancestorsOf(tx: Tx, runId: string): Promise<{ automationId: string }[]> {
  const rows = await tx.execute<{ automation_id: string }>(sql`
    with recursive chain(id, automation_id, parent_run_id, depth) as (
      select id, automation_id, parent_run_id, 0 from ${automationRuns} where id = ${runId}
      union all
      select r.id, r.automation_id, r.parent_run_id, c.depth + 1
      from ${automationRuns} r join chain c on r.id = c.parent_run_id
      where c.depth < 16
    )
    select automation_id from chain order by depth
  `);
  return [...rows].map((r) => ({ automationId: r.automation_id }));
}

/** Fa nascere un'esecuzione (col numero sotto il lock dell'automazione); false se è al tetto. */
async function createRun(
  tx: Tx,
  a: typeof automations.$inferSelect,
  version: number,
  flow: AutomationFlow,
  fields: Record<string, unknown>,
  event: EventRow,
  parentRunId: string | null,
): Promise<boolean> {
  await tx.select({ id: automations.id }).from(automations).where(eq(automations.id, a.id)).for("update");
  const [counts] = await tx
    .select({
      open: sql<number>`count(*) filter (where ${inArray(automationRuns.status, [...OPEN_STATUSES])})::int`,
      last: sql<number>`coalesce(max(${automationRuns.n}), 0)::int`,
    })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, a.id));
  if ((counts?.open ?? 0) >= MAX_ACTIVE_RUNS) return false;
  const titled = initialState(flow, new Date().toISOString());
  titled.event = fields;
  const title = render(titled, flow.titleTemplate).trim() || a.name;
  await tx.insert(automationRuns).values({
    automationId: a.id,
    n: (counts?.last ?? 0) + 1,
    version,
    title,
    status: "running",
    event: fields,
    // Un evento scritto da un'esecuzione fa nascere una figlia (la catena).
    origin: event.originRunId ? "automation" : "stubwise",
    parentRunId,
    projectIds: [a.projectId],
    startedAt: sql`clock_timestamp()`,
    dueAt: sql`now()`,
  });
  return true;
}
