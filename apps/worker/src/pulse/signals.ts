import {
  agentQuestions,
  aiJobs,
  backlogCodeSessions,
  backlogItems,
  backlogJobs,
  projects,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { IN_FLIGHT_JOB_STATUSES, type PulseUrgency } from "@stubwise/notifications";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";

/**
 * I SEGNALI del pulse proattivo: "questo progetto è fermo?" e "c'è qualcosa da
 * proporre?".
 *
 * Le due domande stanno insieme perché sono la stessa decisione vista da due
 * lati, ma restano due funzioni: la prima guarda il LAVORO in corso, la seconda
 * il BACKLOG. Il poller le chiama in quest'ordine e si ferma alla prima che dice
 * no, così il caso normale (progetto vivo) costa una query sola.
 *
 * PERCHÉ "fermo" NON VUOL DIRE "inattivo". Un progetto in cui un piano aspetta
 * un'approvazione, una domanda dell'agente aspetta una risposta o una PR aspetta
 * una review NON è fermo: è fermo su una DECISIONE UMANA, e per quella decisione
 * la notifica esiste già in inbox. Un pulse lì sopra sarebbe un secondo invito ad
 * agire che compete col primo. Per questo i segnali sono cinque e non uno solo:
 * misurano il lavoro in volo *e* le decisioni pendenti.
 *
 * ⚠️ COSA RESTA FUORI, e va saputo. `IN_FLIGHT_JOB_STATUSES` NON contiene
 * `held`: un progetto il cui unico job è fermo su un limite del provider, sul
 * budget o sul gate dell'automazione risulta quindi FERMO, e il pulse parte —
 * anche se in inbox c'è già una `job.held` che aspetta un maintainer. È
 * l'unico caso in cui il razionale del design ("se il progetto è fermo su una
 * decisione umana pendente, il pulse tace") e la lista dei segnali che il design
 * stesso enumera non coincidono. Non è stato chiuso qui perché cambierebbe la
 * definizione di "fermo" concordata; se lo si volesse chiudere, il posto è il
 * segnale 1 (aggiungere `held` agli stati che bloccano) e non serve altro. Fuori
 * anche, di proposito: generazioni Docs e build del grafo in corso (lavoro di
 * infrastruttura, non lavoro sui ticket) e i ticket aperti senza job (nessuno ci
 * sta lavorando: è esattamente la situazione che il pulse vuole smuovere).
 */

/** Intestazione (livello 2) che il deep dive del backlog scrive nel documento.
 * Duplicata da `../backlog/deep-dive.ts` (là è privata) di proposito: qui la si
 * CERCA, là la si SCRIVE, e legarle costringerebbe a esportare un dettaglio
 * interno del deep dive per una `LIKE`. */
export const ANALYSIS_HEADING = "## Analisi tecnica";

/** Il segnale che ha impedito il pulse: entra nel log, per capire perché tace. */
export type IdleBlocker =
  | "job_in_flight"
  | "open_question"
  | "open_pr"
  | "backlog_job"
  | "code_session";

export interface ProjectIdleness {
  /** Nessuno dei cinque segnali è acceso. */
  idle: boolean;
  /** Il PRIMO segnale acceso, nell'ordine di dichiarazione. Null se fermo. */
  blocker: IdleBlocker | null;
  /**
   * Ultima attività di un job AI del progetto (`ai_jobs.last_activity_at`, il
   * heartbeat del worker), o null se nessun job è mai girato: è la base di
   * `idleDays`. Vedi `idleDaysFrom` nel poller per il perché di questa scelta.
   */
  lastJobActivityAt: Date | null;
}

/**
 * I CINQUE SEGNALI in UNA query, come cinque `EXISTS` scalari sulla riga del
 * progetto (più il `max()` dell'ultima attività). Un solo round-trip invece di
 * sei, e ogni `EXISTS` si ferma alla prima riga trovata.
 *
 * MISURA (`EXPLAIN (ANALYZE, BUFFERS)`, Postgres di test, 1 settembre 2026, su
 * un progetto con 200 ticket, 1000 job, 300 voci di backlog e 250 backlog job,
 * più 1000 job e 250 backlog job di rumore su un secondo progetto — il test
 * "costo delle query dei segnali" in `poller.test.ts` la ristampa):
 *
 *   Result (cost=113.17..113.18 rows=1)  (actual time=1.775..1.777 rows=1)
 *     Buffers: shared hit=4040        Execution Time: 1.815 ms
 *
 * cioè **~1,8 ms, tutto in cache**, per l'intera batteria. Il dettaglio per
 * segnale, con l'indice che ciascuno usa:
 *
 *  1. **job in volo — 0,61 ms.** `tickets_project_id_status_idx`
 *     (`project_id, status`) prende i 200 ticket, poi per ciascuno un bitmap su
 *     `ai_jobs_ticket_id_idx`. `ai_jobs` NON ha `project_id`: il join su
 *     `tickets` è obbligato, ed è il ramo più caro dei cinque (1400 buffer sul
 *     solo heap di `ai_jobs`, perché lo stato non è nell'indice).
 *  2. **domande aperte — 0,12 ms.** Il planner sceglie l'unico PARZIALE
 *     `agent_questions_open_job_unique` (`job_id WHERE answered_at IS NULL`),
 *     che è minuscolo perché contiene solo le domande ancora aperte, e filtra il
 *     join sul ticket. Non `agent_questions_ticket_idx`, che pure esiste.
 *  3. **PR aperte — 0,15 ms.** `ticket_repositories_ticket_id_idx`.
 *  4. **backlog job attivi — 0,04 ms, ma con SEQ SCAN.** `backlog_jobs` ha solo
 *     il parziale `(created_at) WHERE status='queued'`, che non copre né
 *     `project_id` né lo stato `running`: Postgres scansiona la tabella intera
 *     (500 righe → 10 buffer). È il segnale senza indice, ed è anche il più
 *     veloce: la tabella è una coda, si svuota.
 *  5. **sessioni di analisi — 0,13 ms.** `backlog_items_project_status_idx` per
 *     le voci, poi un *index only scan* sul parziale
 *     `backlog_code_sessions_active_item_unique` (nessun accesso all'heap).
 *  6. **`max(last_activity_at)` — 0,71 ms**, stesso piano del segnale 1 senza il
 *     filtro sullo stato.
 *
 * CONCLUSIONE: **nessun indice nuovo**. A questi volumi il piano non
 * cambierebbe, e il tick è una query per progetto ABILITATO ogni 15 minuti (i
 * progetti abilitati sono unità, non migliaia). Le due cose da guardare se un
 * giorno i numeri crescessero di ordini di grandezza, in quest'ordine:
 * `ai_jobs (ticket_id, status)` — oggi c'è solo `ticket_id`, e i segnali 1 e 6
 * pagano il ritorno all'heap — e `backlog_jobs (project_id, status)`, che
 * toglierebbe l'unico seq scan.
 */
export async function isProjectIdle(db: Db, projectId: string): Promise<ProjectIdleness> {
  // Sotto-select riusata: i ticket del progetto (l'ancora che `ai_jobs`,
  // `agent_questions` e `ticket_repositories` non hanno).
  const jobsInFlight = exists(
    db
      .select({ one: sql`1` })
      .from(aiJobs)
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .where(
        and(eq(tickets.projectId, projectId), inArray(aiJobs.status, [...IN_FLIGHT_JOB_STATUSES])),
      ),
  );

  const openQuestion = exists(
    db
      .select({ one: sql`1` })
      .from(agentQuestions)
      .innerJoin(tickets, eq(tickets.id, agentQuestions.ticketId))
      .where(and(eq(tickets.projectId, projectId), isNull(agentQuestions.answeredAt))),
  );

  const openPr = exists(
    db
      .select({ one: sql`1` })
      .from(ticketRepositories)
      .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
      .where(and(eq(tickets.projectId, projectId), eq(ticketRepositories.prState, "open"))),
  );

  const activeBacklogJob = exists(
    db
      .select({ one: sql`1` })
      .from(backlogJobs)
      .where(
        and(
          eq(backlogJobs.projectId, projectId),
          inArray(backlogJobs.status, ["queued", "running"]),
        ),
      ),
  );

  const activeCodeSession = exists(
    db
      .select({ one: sql`1` })
      .from(backlogCodeSessions)
      .innerJoin(backlogItems, eq(backlogItems.id, backlogCodeSessions.itemId))
      .where(and(eq(backlogItems.projectId, projectId), eq(backlogCodeSessions.status, "active"))),
  );

  const [row] = await db
    .select({
      jobsInFlight,
      openQuestion,
      openPr,
      activeBacklogJob,
      activeCodeSession,
      // Scalare, non aggregato sulla riga: un `max()` in projection
      // trasformerebbe la select in un'aggregazione sul progetto.
      //
      // Scritta con identificatori NUDI e alias espliciti invece che con i
      // riferimenti drizzle: dentro un template `sql` di una projection drizzle
      // rende le colonne SENZA il prefisso di tabella, e in una subquery con due
      // tabelle `"id"` e `"ticket_id"` diventano ambigui.
      lastJobActivityAt: sql<Date | null>`(
        select max(j.last_activity_at)
        from ai_jobs j
        join tickets t on t.id = j.ticket_id
        where t.project_id = ${projectId}
      )`,
    })
    .from(projects)
    .where(eq(projects.id, projectId));

  // Progetto sparito fra la lista e il segnale (cancellato da un'altra
  // sessione): non è fermo, non esiste. Nessun pulse.
  if (!row) return { idle: false, blocker: null, lastJobActivityAt: null };

  const blocker: IdleBlocker | null = row.jobsInFlight
    ? "job_in_flight"
    : row.openQuestion
      ? "open_question"
      : row.openPr
        ? "open_pr"
        : row.activeBacklogJob
          ? "backlog_job"
          : row.activeCodeSession
            ? "code_session"
            : null;

  return {
    idle: blocker === null,
    blocker,
    // postgres-js rende `timestamptz` come Date, ma il `max()` di zero righe è
    // null: il tipo lo dichiara e il chiamante lo gestisce.
    lastJobActivityAt: row.lastJobActivityAt ? new Date(row.lastJobActivityAt) : null,
  };
}

/** Una voce di backlog proponibile, coi metadati su cui il poller la ordina. */
export interface PulseCandidate {
  id: string;
  title: string;
  urgency: PulseUrgency | null;
  effort: number | null;
  status: "new" | "refining" | "ready";
  /** La voce ha già la sezione `## Analisi tecnica` del deep dive. */
  hasAnalysis: boolean;
  createdAt: Date;
}

/** Stati di una voce PROPONIBILE: qualcosa su cui si può ancora decidere. */
const CANDIDATE_STATUSES = ["ready", "refining", "new"] as const;

/**
 * Le voci di backlog che il pulse può proporre: stato ancora aperto, un
 * documento da leggere, e nessun job del backlog che ci stia già lavorando
 * sopra (proporre una voce mentre il deep dive la sta riscrivendo significa
 * proporre un testo che fra un minuto è un altro).
 *
 * Il `document` NON viene selezionato: serve solo a sapere se c'è l'analisi
 * tecnica, e quel test lo fa Postgres con una `LIKE`. I documenti del backlog
 * arrivano a decine di migliaia di caratteri l'uno: trasferirli per cercare una
 * sottostringa sarebbe il costo più grosso dell'intero tick.
 *
 * La condizione sui job attivi è RIDONDANTE rispetto al segnale `backlog_job` di
 * {@link isProjectIdle} (se un job del progetto è vivo, il pulse non arriva
 * comunque fin qui) ed è tenuta lo stesso: questa funzione definisce cosa sia un
 * candidato, e deve restare vera anche per chi la chiamasse da solo.
 */
export async function listCandidates(db: Db, projectId: string): Promise<PulseCandidate[]> {
  const busy = exists(
    db
      .select({ one: sql`1` })
      .from(backlogJobs)
      .where(
        and(
          eq(backlogJobs.projectId, projectId),
          inArray(backlogJobs.status, ["queued", "running"]),
          // `itemId` sta nel payload jsonb solo per i kind che lavorano su una
          // voce (deep_dive, chat_turn, estimate): per l'intake è assente e il
          // confronto è semplicemente falso.
          sql`${backlogJobs.payload}->>'itemId' = ${backlogItems.id}::text`,
        ),
      ),
  );

  const rows = await db
    .select({
      id: backlogItems.id,
      title: backlogItems.title,
      urgency: backlogItems.urgency,
      effort: backlogItems.effort,
      status: backlogItems.status,
      createdAt: backlogItems.createdAt,
      hasAnalysis: sql<boolean>`position(${ANALYSIS_HEADING} in ${backlogItems.document}) > 0`,
    })
    .from(backlogItems)
    .where(
      and(
        eq(backlogItems.projectId, projectId),
        inArray(backlogItems.status, [...CANDIDATE_STATUSES]),
        // "Non vuoto" vuol dire "con almeno un carattere che non sia spazio":
        // `btrim` da solo toglie gli spazi ma non i newline, e un documento di
        // soli a capo non è un documento.
        sql`${backlogItems.document} ~ '[^[:space:]]'`,
        // `not exists`: la voce NON deve avere un job attivo su di sé.
        sql`not ${busy}`,
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    urgency: row.urgency,
    effort: row.effort,
    // Il `where` ha già ristretto agli stati candidabili: il cast restringe il
    // tipo dell'enum completo a quello dichiarato dal candidato.
    status: row.status as PulseCandidate["status"],
    hasAnalysis: row.hasAnalysis,
    createdAt: row.createdAt,
  }));
}
