import {
  activityReports,
  aiJobs,
  milestones,
  prReviews,
  projectBriefs,
  projectDecisions,
  repositories,
  ticketEvents,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import type { ProjectTimelineEntry, ProjectTimelineKind } from "@stubwise/shared";
import { and, asc, eq, gte, isNotNull, inArray, lte, or, sql } from "drizzle-orm";

/**
 * TIMELINE DI PROGETTO (Fase 5) — la fusione di sei sorgenti in un racconto.
 *
 * Il "dove siamo" di un progetto non vive in nessuna tabella: sta sparso fra i
 * ticket aperti, gli eventi di chiusura, le milestone, le PR dei job, i report
 * giornalieri, le decisioni e i brief. Questo modulo è l'unico posto in cui
 * quelle sei letture diventano un elenco solo, ordinato nel tempo.
 *
 * DUE REGOLE DI COSTRUZIONE, entrambe deliberate:
 *
 * 1. **Una query per sorgente, fusione in memoria.** Niente UNION SQL e niente
 *    N+1: le sorgenti hanno colonne, filtri e join diversi, e una UNION le
 *    obbligherebbe a una forma comune fatta di `null` — mentre i volumi di una
 *    finestra di settimane sono piccoli abbastanza da ordinarli qui. È la
 *    stessa scelta già fatta per `GET /api/tickets/:id/activity`.
 * 2. **La finestra è obbligatoria e limitata.** Nessuna chiamata può chiedere
 *    "tutto": il tetto (`TIMELINE_MAX_DAYS`) e la lettura della querystring
 *    restano nel SERVER, che è l'unico a parlare HTTP.
 *
 * ⚠️ PERCHÉ QUESTO MODULO STA IN `@stubwise/notifications` E NON NEL SERVER.
 * La timeline ha DUE consumatori: la rotta `GET /api/projects/:id/timeline`
 * (`apps/server`) e il brief settimanale (`apps/worker/src/briefs/input.ts`),
 * che della settimana appena chiusa deve raccontare gli stessi fatti. Le due
 * app sono SORELLE — non esiste dipendenza fra `apps/worker` e `apps/server` —
 * e questo package è già dipendenza di entrambe (ed è già la casa dei
 * segnali condivisi del pulse, `project-signals.ts`, spostati qui in fase 4
 * per la stessa ragione). L'alternativa era duplicare otto query in due punti,
 * cioè garantire che un giorno divergano.
 *
 * Quello che NON è salito quaggiù è altrettanto deliberato: l'ACL
 * (`canViewProject`), il tetto della finestra e la normalizzazione di
 * `from`/`to` restano in `apps/server/src/services/project-timeline.ts`.
 * Il brief gira senza un viewer umano e senza una querystring: le tre cose
 * sono HTTP, non timeline.
 */

/** La finestra temporale effettivamente usata per costruire la timeline. */
export interface TimelineWindow {
  from: Date;
  to: Date;
}


/** `YYYY-MM-DD` di un istante: le colonne `date` di Postgres non hanno fuso. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Verdetto + riassunto della review di una PR, indicizzati per url. */
type ReviewByPrUrl = Map<string, { verdict: string | null; prSummary: string | null }>;

/**
 * Le review completate del progetto, indicizzate per url della PR.
 *
 * Una stessa PR può essere ri-reviewata più volte (push successivi): vince
 * l'ULTIMA, che è quella che descrive il codice poi mergiato. L'ordinamento
 * crescente + sovrascrittura fa esattamente questo senza un `distinct on`.
 */
async function reviewsByPrUrl(db: Db, projectId: string): Promise<ReviewByPrUrl> {
  const rows = await db
    .select({
      prUrl: prReviews.prUrl,
      verdict: prReviews.verdict,
      prSummary: prReviews.prSummary,
    })
    .from(prReviews)
    .innerJoin(repositories, eq(repositories.id, prReviews.repositoryId))
    .where(and(eq(repositories.projectId, projectId), eq(prReviews.status, "completed")))
    .orderBy(asc(prReviews.createdAt));
  const map: ReviewByPrUrl = new Map();
  for (const row of rows) map.set(row.prUrl, { verdict: row.verdict, prSummary: row.prSummary });
  return map;
}


/**
 * Costruisce la timeline di un progetto nella finestra data.
 *
 * `kinds` assente = tutte le sorgenti; presente = si interrogano SOLO quelle
 * che possono produrre un tipo richiesto (filtrare dopo avrebbe pagato lo
 * stesso costo in query per buttare via il risultato).
 *
 * ⚠️ ACL: qui NON si controlla nulla. Il permesso è di chi chiama
 * ({@link canViewProject} nella rotta), perché questo modulo serve anche al
 * brief settimanale, che gira senza un viewer umano.
 */
export async function buildProjectTimeline(
  db: Db,
  projectId: string,
  window: TimelineWindow,
  kinds?: Set<ProjectTimelineKind | string>,
): Promise<ProjectTimelineEntry[]> {
  const want = (...candidates: ProjectTimelineKind[]) =>
    kinds === undefined || candidates.some((kind) => kinds.has(kind));
  const { from, to } = window;
  const entries: ProjectTimelineEntry[] = [];

  const [ticketRows, doneRows, milestoneRows, prRows, reviews, reportRows, decisionRows, briefRows] =
    await Promise.all([
      // 1. Ticket APERTI nella finestra.
      want("ticket_opened")
        ? db
            .select({
              id: tickets.id,
              number: tickets.number,
              title: tickets.title,
              createdAt: tickets.createdAt,
            })
            .from(tickets)
            .where(
              and(
                eq(tickets.projectId, projectId),
                gte(tickets.createdAt, from),
                lte(tickets.createdAt, to),
              ),
            )
        : [],
      // 2. Ticket CHIUSI: dagli eventi, non da `tickets.updated_at` (che dice
      //    quando la riga è cambiata l'ultima volta, non quando è passata a
      //    `done`). È la ragione per cui la Fase 5 ha riparato l'audit delle
      //    transizioni di sistema prima di poter disegnare questa timeline.
      want("ticket_done")
        ? db
            .select({
              id: ticketEvents.id,
              at: ticketEvents.createdAt,
              ticketId: tickets.id,
              number: tickets.number,
              title: tickets.title,
            })
            .from(ticketEvents)
            .innerJoin(tickets, eq(tickets.id, ticketEvents.ticketId))
            .where(
              and(
                eq(tickets.projectId, projectId),
                eq(ticketEvents.kind, "status_changed"),
                sql`${ticketEvents.payload}->>'to' = 'done'`,
                gte(ticketEvents.createdAt, from),
                lte(ticketEvents.createdAt, to),
              ),
            )
        : [],
      // 3. Milestone: una riga può produrre DUE voci (scadenza e chiusura), e
      //    solo quelle effettivamente dentro la finestra.
      want("milestone_due", "milestone_closed")
        ? db
            .select({
              id: milestones.id,
              name: milestones.name,
              status: milestones.status,
              dueDate: milestones.dueDate,
              closedAt: milestones.closedAt,
            })
            .from(milestones)
            .where(
              and(
                eq(milestones.projectId, projectId),
                or(
                  and(gte(milestones.dueDate, from), lte(milestones.dueDate, to)),
                  and(gte(milestones.closedAt, from), lte(milestones.closedAt, to)),
                ),
              ),
            )
        : [],
      // 4. PR: la spina dorsale sono i JOB, non `ticket_repositories` — perché
      //    solo il job porta le DATE (`finished_at` = apertura della PR;
      //    `last_activity_at` = l'istante in cui il webhook l'ha portato a
      //    `pr_merged`/`pr_closed`). Un fix multi-repo cita qui la sua PR
      //    primaria, esattamente come fa già la notifica `job.pr_opened`: il
      //    dettaglio per-repo vive sulla pagina del ticket.
      want("pr_opened", "pr_merged", "pr_closed")
        ? db
            .select({
              id: aiJobs.id,
              status: aiJobs.status,
              prUrl: aiJobs.prUrl,
              openedAt: sql<Date>`coalesce(${aiJobs.finishedAt}, ${aiJobs.createdAt})`,
              closedAt: aiJobs.lastActivityAt,
              ticketId: tickets.id,
              ticketNumber: tickets.number,
              ticketTitle: tickets.title,
            })
            .from(aiJobs)
            .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
            .where(
              and(
                eq(tickets.projectId, projectId),
                isNotNull(aiJobs.prUrl),
                inArray(aiJobs.status, ["pr_opened", "pr_merged", "pr_closed"]),
                or(
                  and(
                    sql`coalesce(${aiJobs.finishedAt}, ${aiJobs.createdAt}) >= ${from.toISOString()}::timestamptz`,
                    sql`coalesce(${aiJobs.finishedAt}, ${aiJobs.createdAt}) <= ${to.toISOString()}::timestamptz`,
                  ),
                  and(gte(aiJobs.lastActivityAt, from), lte(aiJobs.lastActivityAt, to)),
                ),
              ),
            )
        : [],
      want("pr_opened", "pr_merged", "pr_closed")
        ? reviewsByPrUrl(db, projectId)
        : (new Map() as ReviewByPrUrl),
      // 5. Report giornalieri completati. La colonna è `date` (nessun fuso):
      //    si confronta per giorno, non per istante.
      want("report_day")
        ? db
            .select({
              id: activityReports.id,
              date: activityReports.date,
              summary: activityReports.summary,
            })
            .from(activityReports)
            .where(
              and(
                eq(activityReports.projectId, projectId),
                eq(activityReports.status, "done"),
                gte(activityReports.date, isoDay(from)),
                lte(activityReports.date, isoDay(to)),
              ),
            )
        : [],
      // 6. Decisioni umane (registro della Fase 5, vuoto finché non arrivano i
      //    writer): l'attore è opzionale perché `decided_by_user_id` è ON
      //    DELETE SET NULL — la decisione sopravvive a chi l'ha presa.
      want("decision")
        ? db
            .select({
              id: projectDecisions.id,
              at: projectDecisions.decidedAt,
              title: projectDecisions.title,
              decision: projectDecisions.decision,
              userId: users.id,
              userEmail: users.email,
            })
            .from(projectDecisions)
            .leftJoin(users, eq(users.id, projectDecisions.decidedByUserId))
            .where(
              and(
                eq(projectDecisions.projectId, projectId),
                gte(projectDecisions.decidedAt, from),
                lte(projectDecisions.decidedAt, to),
              ),
            )
        : [],
      // 7. Brief settimanali completati: nella pagina Roadmap fanno da
      //    separatore fra una settimana e l'altra.
      want("brief")
        ? db
            .select({
              id: projectBriefs.id,
              at: sql<Date>`coalesce(${projectBriefs.finishedAt}, ${projectBriefs.createdAt})`,
              periodStart: projectBriefs.periodStart,
              periodEnd: projectBriefs.periodEnd,
              summary: projectBriefs.summary,
              sections: projectBriefs.sections,
            })
            .from(projectBriefs)
            .where(
              and(
                eq(projectBriefs.projectId, projectId),
                eq(projectBriefs.status, "done"),
                sql`coalesce(${projectBriefs.finishedAt}, ${projectBriefs.createdAt}) >= ${from.toISOString()}::timestamptz`,
                sql`coalesce(${projectBriefs.finishedAt}, ${projectBriefs.createdAt}) <= ${to.toISOString()}::timestamptz`,
              ),
            )
        : [],
    ]);

  for (const row of ticketRows) {
    entries.push({
      kind: "ticket_opened",
      id: row.id,
      at: row.createdAt.toISOString(),
      ticketNumber: row.number,
      title: row.title,
    });
  }
  for (const row of doneRows) {
    entries.push({
      kind: "ticket_done",
      id: row.id,
      at: row.at.toISOString(),
      ticketId: row.ticketId,
      ticketNumber: row.number,
      title: row.title,
    });
  }
  for (const row of milestoneRows) {
    if (row.dueDate && inWindow(row.dueDate, window) && want("milestone_due")) {
      entries.push({
        kind: "milestone_due",
        id: row.id,
        at: row.dueDate.toISOString(),
        name: row.name,
        status: row.status,
      });
    }
    if (row.closedAt && inWindow(row.closedAt, window) && want("milestone_closed")) {
      entries.push({
        kind: "milestone_closed",
        id: row.id,
        at: row.closedAt.toISOString(),
        name: row.name,
      });
    }
  }
  for (const row of prRows) {
    const prUrl = row.prUrl!;
    const review = reviews.get(prUrl);
    // Verdetto e riassunto sono OPZIONALI, non nullable: una PR senza review
    // non ha i campi, e la UI distingue "non c'è review" da "review senza
    // riassunto" senza dover leggere due `null` diversi.
    const enrichment = {
      ...(review?.verdict ? { reviewVerdict: review.verdict as "approve" | "request_changes" } : {}),
      ...(review?.prSummary ? { prSummary: review.prSummary } : {}),
    };
    const common = {
      id: row.id,
      ticketId: row.ticketId,
      ticketNumber: row.ticketNumber,
      ticketTitle: row.ticketTitle,
      prUrl,
      ...enrichment,
    };
    const openedAt = new Date(row.openedAt);
    if (inWindow(openedAt, window) && want("pr_opened")) {
      entries.push({ kind: "pr_opened", at: openedAt.toISOString(), ...common });
    }
    const terminal = row.status === "pr_merged" ? "pr_merged" : row.status === "pr_closed" ? "pr_closed" : null;
    if (terminal && inWindow(row.closedAt, window) && want(terminal)) {
      entries.push({ kind: terminal, at: row.closedAt.toISOString(), ...common });
    }
  }
  for (const row of reportRows) {
    entries.push({
      kind: "report_day",
      id: row.id,
      // Il giorno a mezzanotte UTC: è dove la timeline lo colloca, e la UI
      // mostra comunque `date`, che è il dato vero.
      at: new Date(`${row.date}T00:00:00.000Z`).toISOString(),
      date: row.date,
      summary: row.summary,
    });
  }
  for (const row of decisionRows) {
    entries.push({
      kind: "decision",
      id: row.id,
      at: row.at.toISOString(),
      title: row.title,
      decision: row.decision,
      decidedBy: row.userId && row.userEmail ? { id: row.userId, email: row.userEmail } : null,
    });
  }
  for (const row of briefRows) {
    entries.push({
      kind: "brief",
      id: row.id,
      at: new Date(row.at).toISOString(),
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      headline: briefHeadline(row.sections, row.summary),
    });
  }

  // Ordine cronologico crescente, tie-break su `kind:id`: due voci allo stesso
  // istante (una milestone scaduta e chiusa nello stesso minuto) devono uscire
  // sempre nello stesso ordine, o i test sull'ordine dipenderebbero da quale
  // delle query di sopra ha risposto per prima.
  entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    const keyA = `${a.kind}:${a.id}`;
    const keyB = `${b.kind}:${b.id}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  return entries;
}

/** Istante dentro la finestra, estremi inclusi. */
function inWindow(at: Date, window: TimelineWindow): boolean {
  return at.getTime() >= window.from.getTime() && at.getTime() <= window.to.getTime();
}

/**
 * L'incipit di un brief: la prima sezione ("dove siamo") se il parse dei
 * marcatori l'ha prodotta, altrimenti l'inizio del markdown. Null se il brief
 * è `done` ma senza testo (provider assente: caso previsto, non un errore).
 */
function briefHeadline(
  sections: Record<string, string> | null,
  summary: string | null,
): string | null {
  const first = sections?.whereWeAre ?? Object.values(sections ?? {})[0];
  const text = (first ?? summary ?? "").trim();
  if (!text) return null;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
