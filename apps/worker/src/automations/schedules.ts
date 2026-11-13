import { automationRuns, automations, automationScheduleFires, automationVersions, type Db } from "@stubwise/db";
import { projectPermissionsOfUser } from "@stubwise/notifications";
import { initialState, localDate, render, scheduleDue, type AutomationFlow } from "@stubwise/shared";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { MAX_ACTIVE_RUNS } from "./consumer.js";

/**
 * GLI INIZI A ORARIO (area 7, F2, S7). A ogni giro del poller, le automazioni
 * ACCESE con un inizio `schedule`: se la regola cade oggi nel fuso Europe/Rome
 * e l'ora è raggiunta (`scheduleDue`, condivisa col prototipo), si inserisce
 * `automation_schedule_fires(automation_id, local_date)` e, nella STESSA
 * transazione, si crea l'esecuzione. Il vincolo è ciò che fa scattare una
 * volta sola: un giro ripetuto, due worker o un riavvio non la fanno partire
 * due volte lo stesso giorno.
 *
 * - Un'automazione in pausa non scatta, e riaccesa non recupera i giorni
 *   persi (un worker spento per un giorno nemmeno): conta solo OGGI. Accesa
 *   dopo l'ora di oggi, scatta oggi (come il prototipo).
 * - Il proprietario deve ancora vedere il progetto, come per un evento.
 * - Al tetto delle esecuzioni aperte il giorno si consuma senza esecuzione.
 */

export const SCHEDULE_TIME_ZONE = "Europe/Rome";
const OPEN = ["running", "waiting_approval", "waiting_project", "suspended", "waiting_event"] as const;

export async function fireSchedules(db: Db, now: Date, log: (msg: string) => void = () => {}): Promise<number> {
  const at = now.toISOString();
  const today = localDate(at, SCHEDULE_TIME_ZONE);
  // Review F2, M2: solo le accese con l'ultima versione pubblicata a orario, in una query.
  const rows = await db
    .select({ a: automations, n: automationVersions.n, flow: automationVersions.flow })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        isNotNull(automationVersions.publishedAt),
        sql`${automationVersions.n} = (select max(v2.n) from automation_versions v2 where v2.automation_id = ${automations.id} and v2.published_at is not null)`,
      ),
    )
    .where(and(eq(automations.status, "active"), isNotNull(automations.ownerId), sql`${automationVersions.flow}->'trigger'->>'kind' = 'schedule'`));
  let fired = 0;
  for (const { a, n, flow: raw } of rows) {
    // Una per volta: un'automazione che lancia si logga e non ferma le altre.
    try {
      const flow = raw as AutomationFlow;
      const v = { n };
      if (flow.trigger.kind !== "schedule" || !scheduleDue(flow.trigger.rule, at, SCHEDULE_TIME_ZONE)) continue;
      if (await fireOne(db, a, v, flow, at, today)) {
        fired += 1;
        log(`[automations] ${a.code}: inizio a orario del ${today}`);
      }
    } catch (err) {
      log(`[automations] ${a.code}: inizio a orario non riuscito (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return fired;
}

async function fireOne(db: Db, a: typeof automations.$inferSelect, v: { n: number }, flow: AutomationFlow, at: string, today: string): Promise<boolean> {
  {
    const started = await db.transaction(async (tx) => {
      const [fire] = await tx.insert(automationScheduleFires).values({ automationId: a.id, localDate: today }).onConflictDoNothing().returning();
      if (!fire) return false;
      await tx.select({ id: automations.id }).from(automations).where(eq(automations.id, a.id)).for("update");
      const [still] = await tx.select({ status: automations.status, ownerId: automations.ownerId }).from(automations).where(eq(automations.id, a.id));
      if (still?.status !== "active" || !still.ownerId) return false;
      if (!(await projectPermissionsOfUser(tx, still.ownerId, a.projectId))) return false;
      const [c] = await tx
        .select({
          open: sql<number>`count(*) filter (where ${inArray(automationRuns.status, [...OPEN] as never)})::int`,
          last: sql<number>`coalesce(max(${automationRuns.n}), 0)::int`,
        })
        .from(automationRuns)
        .where(eq(automationRuns.automationId, a.id));
      if ((c?.open ?? 0) >= MAX_ACTIVE_RUNS) return false;
      const event = { avvio: { data: today } };
      const titled = initialState(flow, at);
      titled.event = event;
      const [run] = await tx
        .insert(automationRuns)
        .values({
          automationId: a.id,
          n: (c?.last ?? 0) + 1,
          version: v.n,
          title: render(titled, flow.titleTemplate).trim() || a.name,
          status: "running",
          event,
          origin: "schedule",
          mailboxAccountId: a.mailboxAccountId,
          projectIds: [a.projectId],
          dueAt: sql`now()`,
        })
        .returning({ id: automationRuns.id });
      await tx.update(automationScheduleFires).set({ runId: run!.id }).where(and(eq(automationScheduleFires.automationId, a.id), eq(automationScheduleFires.localDate, today)));
      return true;
    });
    return started;
  }
}
