import { automationRuns, automations, automationScheduleFires, automationVersions, type Db } from "@stubwise/db";
import { projectPermissionsOfUser } from "@stubwise/notifications";
import { initialState, localDate, render, scheduleDue, type AutomationFlow } from "@stubwise/shared";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  const active = await db
    .select()
    .from(automations)
    .where(and(eq(automations.status, "active"), isNotNull(automations.ownerId)));
  let fired = 0;
  for (const a of active) {
    const [v] = await db
      .select({ n: automationVersions.n, flow: automationVersions.flow })
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, a.id), isNotNull(automationVersions.publishedAt)))
      .orderBy(desc(automationVersions.n))
      .limit(1);
    const flow = v?.flow as AutomationFlow | undefined;
    if (!v || !flow || flow.trigger.kind !== "schedule" || !scheduleDue(flow.trigger.rule, at, SCHEDULE_TIME_ZONE)) continue;
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
    if (started) {
      fired += 1;
      log(`[automations] ${a.code}: inizio a orario del ${today}`);
    }
  }
  return fired;
}
