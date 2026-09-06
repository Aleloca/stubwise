import { activityReports, projectBriefs, type Db } from "@stubwise/db";
import {
  buildProjectTimeline,
  isProjectIdle,
  type IdleBlocker,
} from "@stubwise/notifications";
import type { ProjectTimelineEntry } from "@stubwise/shared";
import { and, asc, desc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";

/**
 * L'INPUT del BRIEF SETTIMANALE: cinque sorgenti, un ordine fisso, un tetto.
 *
 * LA REGOLA CHE GOVERNA TUTTO IL MODULO: **i commit non entrano mai**. Il brief
 * è per chi non legge codice, e un elenco di commit è la cosa meno leggibile che
 * il sistema produca. Della settimana si prende ciò che è GIÀ stato tradotto in
 * italiano corrente — `activity_reports.summary`, che l'agente ha scritto un
 * giorno alla volta — e i FATTI strutturati della timeline. Chi un domani
 * volesse "più dettaglio" ha la tentazione di attaccare qui i messaggi di
 * commit: non è più dettaglio, è un brief che nessuno legge.
 *
 * LE CINQUE SORGENTI, in quest'ordine (che è anche l'ordine di PRIORITÀ sotto il
 * tetto: quando lo spazio finisce, a perdere è l'ultima):
 *  1. i riassunti giornalieri del periodo;
 *  2. gli eventi della timeline (ticket, PR, milestone) — dallo stesso modulo
 *     condiviso che alimenta la pagina Roadmap, così le due superfici non
 *     possono raccontare settimane diverse;
 *  3. i BLOCCHI correnti, dai segnali condivisi del pulse;
 *  4. le decisioni umane del periodo (dalla stessa timeline, partizionate);
 *  5. il brief precedente, per continuità.
 *
 * ⚠️ I blocchi sono lo stato di ADESSO, non del periodo: una domanda aperta
 * ieri è ciò che serve sapere oggi, mentre una risolta martedì non è più un
 * blocco. È deliberato che le due cose convivano nello stesso prompt — la
 * sezione "cosa serve da voi" nasce solo dai blocchi correnti, e per questo
 * l'etichetta del blocco dice `now`.
 */

/**
 * Tetto complessivo dell'input, su TUTTE le sorgenti insieme. Il brief è
 * settimanale: un progetto attivo produce sette riassunti giornalieri e qualche
 * decina di eventi, molto sotto il tetto. Serve al caso patologico (un report
 * giornaliero degenerato, una settimana con centinaia di ticket), non alla
 * potatura di routine.
 */
export const BRIEF_INPUT_MAX_CHARS = 60_000;

/**
 * Marcatore di troncamento, INTERNO ai blocchi tagliati. Non è tradotto: la
 * frase che spiega il troncamento all'agente è `brief.input.truncated` (in
 * lingua) e la aggiunge il prompt quando {@link BriefInput.truncated} è vero.
 * Qui basta un segno che il testo continua.
 */
export const BRIEF_TRUNCATION_MARKER = "\n[…]";

/** Il periodo coperto dal brief: due giorni di calendario, estremi inclusi. */
export interface BriefPeriod {
  /** Primo giorno, `YYYY-MM-DD`. */
  periodStart: string;
  /** Ultimo giorno, `YYYY-MM-DD`. */
  periodEnd: string;
}

/** Tutto ciò che il prompt del brief ha da raccontare. */
export interface BriefInput {
  projectName: string;
  periodStart: string;
  periodEnd: string;
  /** I riassunti giornalieri del periodo, dal più vecchio. Mai i commit. */
  reports: { date: string; summary: string }[];
  /** Gli eventi del periodo, una riga per evento (vedi {@link renderTimelineEntry}). */
  timeline: string[];
  /** Cosa è fermo ADESSO, dai segnali condivisi. Vuoto = niente è fermo. */
  blocks: string[];
  /** Le decisioni umane prese nel periodo. */
  decisions: string[];
  /** Il markdown del brief precedente, o null se è il primo. */
  previousBrief: string | null;
  /** Il tetto ha tolto qualcosa: il prompt lo dichiara all'agente. */
  truncated: boolean;
}

/**
 * Glosse in inglese dei segnali che tacciono il pulse, riusate qui per dire
 * all'agente COSA è fermo. Inglese come le etichette dei prompt della fase B
 * (`Ticket:`, `Plan:`): la lingua dell'OUTPUT la portano le istruzioni del
 * catalogo, l'impalcatura del prompt resta neutra. Il token grezzo resta nella
 * riga perché sia sempre chiaro da quale segnale viene.
 */
const BLOCKER_GLOSS: Record<IdleBlocker, string> = {
  job_in_flight: "the automation is working on a ticket right now",
  job_held: "a job is parked waiting for a maintainer (usage limit, budget or approval gate)",
  open_question: "the agent asked a question and nobody answered yet",
  open_pr: "a pull request is open and waiting for a review",
  backlog_job: "a backlog job is running",
  code_session: "a code analysis session is open on a backlog item",
};

/**
 * Le voci della timeline che il prompt NON rende in quella sezione, perché ne
 * hanno già una propria: i report giornalieri (sezione 1), le decisioni
 * (sezione 4, con un rendering più ricco) e i brief (sezione 5). Ripeterle
 * costerebbe spazio sotto il tetto per dire due volte la stessa cosa.
 */
const TIMELINE_KINDS_ELSEWHERE = new Set(["report_day", "decision", "brief"]);

/** `YYYY-MM-DD` di un istante ISO (la data è ciò che serve, non l'ora). */
function day(at: string): string {
  return at.slice(0, 10);
}

/**
 * Una voce di timeline come UNA riga per il prompt, o `null` se quella voce ha
 * già una sezione propria.
 *
 * Forma `[kind] YYYY-MM-DD testo`: il `kind` grezzo è un'etichetta di
 * protocollo — non testo da leggere — e costa meno di una traduzione che poi il
 * modello riscriverebbe comunque. Gli URL restano fuori: non aggiungono nulla a
 * un brief per non-tecnici e allungano l'input sotto il tetto.
 */
export function renderTimelineEntry(entry: ProjectTimelineEntry): string | null {
  if (TIMELINE_KINDS_ELSEWHERE.has(entry.kind)) return null;
  const head = `[${entry.kind}] ${day(entry.at)}`;
  switch (entry.kind) {
    case "ticket_opened":
    case "ticket_done":
      return `${head} #${entry.ticketNumber} ${entry.title}`;
    case "milestone_due":
    case "milestone_closed":
      return `${head} ${entry.name}`;
    case "pr_opened":
    case "pr_merged":
    case "pr_closed": {
      const parts = [`${head} #${entry.ticketNumber} ${entry.ticketTitle}`];
      if (entry.reviewVerdict) parts.push(`review: ${entry.reviewVerdict}`);
      if (entry.prSummary) parts.push(entry.prSummary);
      return parts.join(" — ");
    }
    default:
      return null;
  }
}

/** Una decisione umana come riga del prompt. */
function renderDecision(entry: Extract<ProjectTimelineEntry, { kind: "decision" }>): string {
  return `${day(entry.at)} — ${entry.title}: ${entry.decision}`;
}

/**
 * Taglio DURO a `maxChars`, marcatore incluso.
 *
 * Diverso da `capText` (`../agent/text.ts`) di proposito: quello tiene SEMPRE la
 * prima riga anche se sfora, perché lì il tetto vale per un input solo. Qui il
 * tetto è un BUDGET CONDIVISO fra cinque sorgenti: se la prima potesse sforare,
 * le altre quattro non entrerebbero mai. Il confine di riga si preferisce, ma
 * solo se non costa più di metà del budget.
 */
export function capBlock(text: string, maxChars: number, marker = BRIEF_TRUNCATION_MARKER): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - marker.length);
  const slice = text.slice(0, budget);
  const nl = slice.lastIndexOf("\n");
  const kept = nl > budget / 2 ? slice.slice(0, nl) : slice;
  return `${kept}${marker}`;
}

/** Budget residuo condiviso fra le sorgenti, in ordine di priorità. */
interface Budget {
  remaining: number;
  truncated: boolean;
}

/**
 * Consuma il budget su una lista di testi: tiene gli elementi finché ci stanno,
 * taglia l'ultimo se serve, e da lì in poi si ferma marcando il troncamento.
 */
function takeWithin<T>(items: T[], budget: Budget, text: (item: T) => string, cut: (item: T, capped: string) => T): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const body = text(item);
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    if (body.length > budget.remaining) {
      kept.push(cut(item, capBlock(body, budget.remaining)));
      budget.remaining = 0;
      budget.truncated = true;
      break;
    }
    kept.push(item);
    // +1 per l'a capo che le unirà nel prompt.
    budget.remaining -= body.length + 1;
  }
  return kept;
}

/**
 * Raccoglie l'input del brief di un progetto per un periodo.
 *
 * ⚠️ Nessuna ACL: come `buildProjectTimeline`, gira dal poller del worker, che
 * non ha un viewer umano. Il permesso è di chi espone il risultato.
 */
export async function collectBriefInput(
  db: Db,
  projectId: string,
  period: BriefPeriod,
  projectName = "",
): Promise<BriefInput> {
  // La finestra della timeline: i due giorni di calendario, estremi inclusi.
  // `periodEnd` arriva fino all'ultimo millisecondo, altrimenti gli eventi del
  // pomeriggio dell'ultimo giorno resterebbero fuori dal brief che li racconta.
  const window = {
    from: new Date(`${period.periodStart}T00:00:00.000Z`),
    to: new Date(`${period.periodEnd}T23:59:59.999Z`),
  };

  const [reportRows, entries, idleness, previous] = await Promise.all([
    db
      .select({ date: activityReports.date, summary: activityReports.summary })
      .from(activityReports)
      .where(
        and(
          eq(activityReports.projectId, projectId),
          eq(activityReports.status, "done"),
          isNotNull(activityReports.summary),
          // Un `summary` di soli spazi è come nessun riassunto: una riga vuota
          // nel prompt è rumore che consuma budget.
          sql`${activityReports.summary} ~ '[^[:space:]]'`,
          gte(activityReports.date, period.periodStart),
          lte(activityReports.date, period.periodEnd),
        ),
      )
      .orderBy(asc(activityReports.date)),
    buildProjectTimeline(db, projectId, window),
    isProjectIdle(db, projectId),
    db
      .select({ summary: projectBriefs.summary })
      .from(projectBriefs)
      .where(
        and(
          eq(projectBriefs.projectId, projectId),
          eq(projectBriefs.status, "done"),
          isNotNull(projectBriefs.summary),
          lt(projectBriefs.periodStart, period.periodStart),
        ),
      )
      .orderBy(desc(projectBriefs.periodStart))
      .limit(1),
  ]);

  const budget: Budget = { remaining: BRIEF_INPUT_MAX_CHARS, truncated: false };

  const reports = takeWithin(
    reportRows.map((row) => ({ date: row.date, summary: row.summary!.trim() })),
    budget,
    (row) => `${row.date}: ${row.summary}`,
    (row, capped) => ({ date: row.date, summary: capped.slice(row.date.length + 2) }),
  );

  const timelineLines: string[] = [];
  const decisionLines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "decision") {
      decisionLines.push(renderDecision(entry));
      continue;
    }
    const line = renderTimelineEntry(entry);
    if (line) timelineLines.push(line);
  }

  const timeline = takeWithin(timelineLines, budget, (line) => line, (_line, capped) => capped);

  // TUTTI i segnali accesi, non solo il primo: il pulse deve sapere *se*
  // tacere, il brief deve dire al lettore ogni cosa che può sbloccare.
  const blocks = idleness.blockers.map(
    (blocker) => `[${blocker}] now: ${BLOCKER_GLOSS[blocker]}`,
  );
  // I blocchi sono poche decine di caratteri e sono la sorgente della sezione
  // "cosa serve da voi": non li si tronca, li si sottrae soltanto dal budget.
  budget.remaining -= blocks.reduce((n, line) => n + line.length + 1, 0);

  const decisions = takeWithin(decisionLines, budget, (line) => line, (_line, capped) => capped);

  let previousBrief = previous[0]?.summary ?? null;
  if (previousBrief !== null) {
    if (budget.remaining <= 0) {
      previousBrief = null;
      budget.truncated = true;
    } else if (previousBrief.length > budget.remaining) {
      previousBrief = capBlock(previousBrief, budget.remaining);
      budget.remaining = 0;
      budget.truncated = true;
    } else {
      budget.remaining -= previousBrief.length;
    }
  }

  return {
    projectName,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    reports,
    timeline,
    blocks,
    decisions,
    previousBrief,
    truncated: budget.truncated,
  };
}
