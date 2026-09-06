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
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { IN_FLIGHT_JOB_STATUSES } from "./actions.js";
import type { PulseUrgency } from "./format.js";

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
 * agire che compete col primo. Per questo i segnali sono sei e non uno solo:
 * misurano il lavoro in volo *e* le decisioni pendenti.
 *
 * ⚠️ COSA RESTA FUORI, e va saputo. Gli stati TERMINALI di un job non bloccano
 * niente, ed è voluto: un progetto il cui ultimo job è `failed` (o `skipped`, o
 * con la PR già chiusa) è genuinamente fermo, e silenziarlo per sempre sarebbe il
 * difetto opposto a quello che il pulse cura. Fuori anche le generazioni Docs e
 * le build del grafo in corso (lavoro di INFRASTRUTTURA, non lavoro sui ticket:
 * non impediscono di proporre una voce di backlog) e i ticket aperti senza
 * nessun job — nessuno ci sta lavorando, che è esattamente la situazione che il
 * pulse vuole smuovere.
 *
 * SPOSTATO da `apps/worker/src/pulse/signals.ts` (Fase 4, Task 11): il
 * consumatore non è più solo il poller del pulse del worker, ma anche
 * `summarizeProject` (`./project-pulse-summary.ts`), chiamato SINCRONAMENTE
 * dal server per `GET /api/projects/pulse`. Sta in `@stubwise/notifications` e
 * non altrove perché `IN_FLIGHT_JOB_STATUSES` è già qui: spostare i segnali
 * nello stesso package evita un giro di dipendenza fra worker e notifications.
 * `apps/worker/src/pulse/signals.ts` resta come re-export sottile finché i test
 * del worker non vengono aggiornati a importare direttamente da qui.
 */

/**
 * Job PARCHEGGIATO su un limite del provider, sul budget o sul gate
 * dell'automazione. NON è "in volo" — `IN_FLIGHT_JOB_STATUSES` lo esclude
 * apposta, perché quella lista risponde a un'altra domanda ("si può rilanciare
 * questo job adesso?") e `held` è *il* caso in cui il rilancio deve restare
 * possibile — ma per il pulse blocca eccome: c'è già una `job.held` in inbox che
 * aspetta un maintainer, e il pulse non deve competerci.
 */
export const PULSE_HELD_STATUS = "held" as const;

/**
 * Gli stati di `ai_jobs` che fanno tacere il pulse. È la POLICY del pulse, e sta
 * qui — non in `@stubwise/notifications/actions` — perché quel modulo è il
 * catalogo delle AZIONI: una regola del pulse là dentro ne smusserebbe la
 * responsabilità. Finché il consumatore è uno solo, resta locale.
 *
 * DERIVATA e non ricopiata: uno stato aggiunto domani a
 * {@link IN_FLIGHT_JOB_STATUSES} entra qui da solo, e l'unica delta manuale
 * della policy del pulse resta visibile in questa riga.
 *
 * Esportata (era privata nel file originale) perché `project-pulse-summary.ts`
 * vive nello stesso package e la policy va tenuta in un punto solo: se un
 * domani un secondo consumatore avrà bisogno anche del sottoinsieme completo
 * (in volo + held), non dovrà ricostruirlo a mano.
 */
export const PULSE_BLOCKING_JOB_STATUSES = [...IN_FLIGHT_JOB_STATUSES, PULSE_HELD_STATUS] as const;

/**
 * Gli stati bloccanti che NON sono `held`, cioè il lavoro davvero in corso.
 *
 * I due sottoinsiemi sono interrogati da due `EXISTS` separati invece che da uno
 * solo sull'intera {@link PULSE_BLOCKING_JOB_STATUSES}, e non per efficienza (la
 * query resta una): per tenere VERITIERO il log. Un progetto fermo da tre
 * settimane su un blocco di budget verrebbe altrimenti loggato "non fermo
 * (job_in_flight)", che è fuorviante proprio nel caso in cui il log serve.
 */
export const PULSE_IN_FLIGHT_STATUSES = PULSE_BLOCKING_JOB_STATUSES.filter(
  (status) => status !== PULSE_HELD_STATUS,
);

/** Il segnale che ha impedito il pulse: entra nel log, per capire perché tace. */
export type IdleBlocker =
  | "job_in_flight"
  | "job_held"
  | "open_question"
  | "open_pr"
  | "backlog_job"
  | "code_session";

export interface ProjectIdleness {
  /** Nessuno dei sei segnali è acceso. */
  idle: boolean;
  /** Il PRIMO segnale acceso, nell'ordine di dichiarazione. Null se fermo. */
  blocker: IdleBlocker | null;
  /**
   * TUTTI i segnali accesi, nello stesso ordine. Il pulse guarda solo il primo
   * — gli basta sapere *se* tacere e *perché*, in una riga di log — ma il brief
   * settimanale (fase 5) deve elencare al lettore ogni cosa che è ferma: dire
   * "l'automazione sta lavorando" mentre una domanda dell'agente aspetta da tre
   * giorni sarebbe la mezza verità peggiore, perché è proprio quella domanda
   * l'unica cosa che il lettore può sbloccare.
   *
   * NON costa una query in più: i sei `EXISTS` sono già tutti nella stessa
   * riga di risultato, e prima venivano semplicemente buttati dopo il primo.
   */
  blockers: IdleBlocker[];
  /**
   * Ultima attività di un job AI del progetto (`ai_jobs.last_activity_at`, il
   * heartbeat del worker), o null se nessun job è mai girato: è la base di
   * `idleDays`. Vedi `idleDaysFrom` nel poller (e la sua sorella in
   * `project-pulse-summary.ts`) per il perché di questa scelta.
   */
  lastJobActivityAt: Date | null;
}

/**
 * I SEI SEGNALI in UNA query, come sei `EXISTS` scalari sulla riga del progetto
 * (più il `max()` dell'ultima attività). Un solo round-trip invece di sette, e
 * ogni `EXISTS` si ferma alla prima riga trovata.
 *
 * MISURA (`EXPLAIN (ANALYZE, BUFFERS)`, Postgres di test, 1 settembre 2026, su
 * un progetto con 200 ticket, 1000 job, 300 voci di backlog e 250 backlog job,
 * più 1000 job e 250 backlog job di rumore su un secondo progetto — il test
 * "costo delle query dei segnali" in `poller.test.ts` la ristampa, con gli stati
 * INTERPOLATI da queste costanti perché la misura non possa scollarsi dal codice
 * misurato):
 *
 *   Result (cost=134.56..134.57 rows=1)  (actual time=2.467..2.470 rows=1)
 *     Buffers: shared hit=5446        Execution Time: 2.601 ms
 *
 * cioè **~2,6 ms, tutto in cache**, per l'intera batteria. Il dettaglio per
 * segnale, con l'indice che ciascuno usa:
 *
 *  1. **job in volo — 0,75 ms.** `tickets_project_id_status_idx`
 *     (`project_id, status`) prende i 200 ticket, poi per ciascuno un bitmap su
 *     `ai_jobs_ticket_id_idx`. `ai_jobs` NON ha `project_id`: il join su
 *     `tickets` è obbligato, ed è il ramo più caro (1400 buffer sul solo heap di
 *     `ai_jobs`, perché lo stato non è nell'indice).
 *  2. **job `held` — 0,55 ms.** Stesso piano del precedente con un uguale al
 *     posto dell'`ANY`: è il prezzo della distinzione nel log, ed è il ramo che
 *     ha alzato il totale da ~1,8 a ~2,6 ms. Un `EXISTS` solo sull'unione
 *     costerebbe quanto il #1 da solo, ma direbbe "job_in_flight" su un progetto
 *     fermo da settimane su un blocco di budget.
 *  3. **domande aperte — 0,13 ms.** Il planner sceglie l'unico PARZIALE
 *     `agent_questions_open_job_unique` (`job_id WHERE answered_at IS NULL`),
 *     che è minuscolo perché contiene solo le domande ancora aperte, e filtra il
 *     join sul ticket. Non `agent_questions_ticket_idx`, che pure esiste.
 *  4. **PR aperte — 0,16 ms.** `ticket_repositories_ticket_id_idx`.
 *  5. **backlog job attivi — 0,05 ms, ma con SEQ SCAN.** `backlog_jobs` ha solo
 *     il parziale `(created_at) WHERE status='queued'`, che non copre né
 *     `project_id` né lo stato `running`: Postgres scansiona la tabella intera
 *     (500 righe → 10 buffer). È il segnale senza indice, ed è anche il più
 *     veloce: la tabella è una coda, si svuota.
 *  6. **sessioni di analisi — 0,14 ms.** `backlog_items_project_status_idx` per
 *     le voci, poi un *index only scan* sul parziale
 *     `backlog_code_sessions_active_item_unique` (nessun accesso all'heap).
 *  7. **`max(last_activity_at)` — 0,69 ms**, stesso piano del segnale 1 senza il
 *     filtro sullo stato.
 *
 * CONCLUSIONE: **nessun indice nuovo**. A questi volumi il piano non
 * cambierebbe, e il tick è una query per progetto ABILITATO ogni 15 minuti (i
 * progetti abilitati sono unità, non migliaia). Le due cose da guardare se un
 * giorno i numeri crescessero di ordini di grandezza, in quest'ordine:
 * `ai_jobs (ticket_id, status)` — oggi c'è solo `ticket_id`, e i rami 1, 2 e 7
 * pagano tutti e tre il ritorno all'heap: è il 78% dei buffer della query — e
 * `backlog_jobs (project_id, status)`, che toglierebbe l'unico seq scan.
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
        and(eq(tickets.projectId, projectId), inArray(aiJobs.status, PULSE_IN_FLIGHT_STATUSES)),
      ),
  );

  // Il gemello del precedente sull'altro sottoinsieme della policy: separato solo
  // perché il log sappia dire QUALE dei due tace il pulse (vedi
  // PULSE_IN_FLIGHT_STATUSES).
  const jobHeld = exists(
    db
      .select({ one: sql`1` })
      .from(aiJobs)
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .where(and(eq(tickets.projectId, projectId), eq(aiJobs.status, PULSE_HELD_STATUS))),
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
      jobHeld,
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
  if (!row) return { idle: false, blocker: null, blockers: [], lastJobActivityAt: null };

  // L'ordine di questa lista È la precedenza del `blocker` singolo: chi la
  // riordina cambia anche la riga di log del pulse.
  const blockers: IdleBlocker[] = [];
  if (row.jobsInFlight) blockers.push("job_in_flight");
  if (row.jobHeld) blockers.push("job_held");
  if (row.openQuestion) blockers.push("open_question");
  if (row.openPr) blockers.push("open_pr");
  if (row.activeBacklogJob) blockers.push("backlog_job");
  if (row.activeCodeSession) blockers.push("code_session");
  const blocker: IdleBlocker | null = blockers[0] ?? null;

  return {
    idle: blocker === null,
    blocker,
    blockers,
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

/**
 * Intestazione (livello 2) che il deep dive del backlog scrive nel documento.
 * Duplicata da `apps/worker/src/backlog/deep-dive.ts` (là è privata) di
 * proposito: qui la si CERCA, là la si SCRIVE, e legarle costringerebbe a
 * esportare un dettaglio interno del deep dive per una `LIKE`. NON esportata:
 * è un dettaglio implementativo di {@link listCandidates}, nessun altro modulo
 * la usa (verificato: era già così nel file di origine, dove nessun import la
 * prendeva da fuori nonostante fosse `export`).
 */
const ANALYSIS_HEADING = "## Analisi tecnica";

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
