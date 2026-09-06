import { projectBriefs, type Db } from "@stubwise/db";
import type { ProjectBriefWeekly } from "@stubwise/shared";
import { and, desc, eq, gte } from "drizzle-orm";

/**
 * LETTURA E RIGENERAZIONE del brief settimanale (Fase 5) — il lato HTTP.
 *
 * A generare i brief è il POLLER del worker (`apps/worker/src/briefs/poller.ts`):
 * qui non gira nessun agente. Quello che il server sa fare è leggerli e
 * rimettere una riga in coda, che è tutto ciò che serve al bottone "Rigenera".
 *
 * ⚠️ ACL: nessuna, come per la timeline. Il permesso lo controlla la rotta con
 * `canViewProject`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Giorni coperti da un brief: sette, estremi inclusi. */
const BRIEF_PERIOD_DAYS = 7;

/** La proiezione pubblica: `error` NON esce mai (vedi `projectBriefWeeklySchema`). */
export function toPublicBrief(row: typeof projectBriefs.$inferSelect): ProjectBriefWeekly {
  return {
    id: row.id,
    projectId: row.projectId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    summary: row.summary,
    sections: row.sections,
    notificationId: row.notificationId,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** I brief di un progetto, dal periodo più recente. */
export async function listProjectBriefs(
  db: Db,
  projectId: string,
  limit: number,
): Promise<ProjectBriefWeekly[]> {
  const rows = await db
    .select()
    .from(projectBriefs)
    .where(eq(projectBriefs.projectId, projectId))
    .orderBy(desc(projectBriefs.periodStart))
    .limit(limit);
  return rows.map(toPublicBrief);
}

/** Un brief per id, o null. Il progetto serve al chiamante per l'ACL. */
export async function getBrief(db: Db, briefId: string): Promise<ProjectBriefWeekly | null> {
  const [row] = await db.select().from(projectBriefs).where(eq(projectBriefs.id, briefId));
  return row ? toPublicBrief(row) : null;
}

/**
 * L'ultima settimana CHIUSA secondo il server: sette giorni che finiscono ieri,
 * in UTC.
 *
 * ⚠️ NON è esattamente il periodo che userebbe il poller, che calcola i giorni
 * nel fuso dell'istanza (`PULSE_TIMEZONE`, che il server non conosce — è una env
 * del worker). Su un'istanza non-UTC i due periodi possono differire di un
 * giorno, e senza un rimedio la rigenerazione manuale creerebbe una SECONDA
 * riga quasi identica accanto a quella del poller.
 *
 * Il rimedio è {@link findTargetBrief}, che prima di creare cerca un brief il
 * cui periodo SI SOVRAPPONE a questo: uno scarto di un giorno è per forza una
 * sovrapposizione, quindi la rigenerazione manuale ricade sempre sulla riga
 * giusta e il calcolo qui resta un fallback per il caso "non esiste ancora
 * nessun brief".
 */
export function lastClosedWeek(now: Date = new Date()): { periodStart: string; periodEnd: string } {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = todayUtc - DAY_MS;
  const start = end - (BRIEF_PERIOD_DAYS - 1) * DAY_MS;
  return {
    periodStart: new Date(start).toISOString().slice(0, 10),
    periodEnd: new Date(end).toISOString().slice(0, 10),
  };
}

/**
 * Il brief su cui agisce la rigenerazione: il più recente il cui periodo tocca
 * (o supera) l'inizio dell'ultima settimana chiusa. `null` se non ce n'è
 * nessuno — allora se ne crea uno.
 */
async function findTargetBrief(
  db: Db,
  projectId: string,
  periodStart: string,
): Promise<typeof projectBriefs.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(projectBriefs)
    .where(
      and(eq(projectBriefs.projectId, projectId), gte(projectBriefs.periodEnd, periodStart)),
    )
    .orderBy(desc(projectBriefs.periodStart))
    .limit(1);
  return row ?? null;
}

export type QueueBriefResult =
  | { ok: true; created: boolean; brief: ProjectBriefWeekly }
  | { ok: false; reason: "already_done" };

/**
 * Rimette in coda il brief dell'ultima settimana (o lo crea se non c'è).
 *
 * `force` serve SOLO contro un brief già `done`: rifare un brief che qualcuno
 * ha già letto — e che è già stato annunciato in inbox e su Slack — è una
 * decisione, non un click. Un brief `failed`, `queued` o `running` si rimette
 * in coda senza chiedere niente: non c'è nulla da preservare.
 *
 * Il reset azzera `attempts` ed `error`: senza, un brief arrivato al terzo
 * tentativo tornerebbe `queued` e il poller lo scarterebbe subito — una
 * rigenerazione che non rigenera è peggio di un errore.
 */
export async function queueBriefRegeneration(
  db: Db,
  projectId: string,
  opts: { force?: boolean; now?: Date } = {},
): Promise<QueueBriefResult> {
  const period = lastClosedWeek(opts.now);
  const target = await findTargetBrief(db, projectId, period.periodStart);

  if (target) {
    if (target.status === "done" && opts.force !== true) {
      return { ok: false, reason: "already_done" };
    }
    const [updated] = await db
      .update(projectBriefs)
      .set({ status: "queued", attempts: 0, error: null, finishedAt: null, lastActivityAt: new Date() })
      .where(eq(projectBriefs.id, target.id))
      .returning();
    return { ok: true, created: false, brief: toPublicBrief(updated!) };
  }

  const [created] = await db
    .insert(projectBriefs)
    .values({
      projectId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      status: "queued",
    })
    .returning();
  return { ok: true, created: true, brief: toPublicBrief(created!) };
}
