import {
  activityReports,
  agentQuestions,
  aiJobs,
  backlogItems,
  notifications,
  projects,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { and, eq, exists, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import {
  actorAllows,
  type ActionableNotification,
  type ActionId,
  type ActorRole,
} from "./actions.js";
import type { NotificationKind } from "./format.js";
import { isProjectIdle, PULSE_BLOCKING_JOB_STATUSES } from "./project-signals.js";

/**
 * IL "POLSO" di un progetto per un viewer: chi aspetta cosa, cosa gira, cosa
 * langue — senza duplicare la logica che il poller del pulse (Fase 2) già usa
 * per decidere quando proporre lavoro (`./project-signals.js`).
 *
 * Nasce per `GET /api/projects/pulse` (Fase 4, app mobile): dove il poller del
 * pulse guarda UN progetto alla volta, in background, e decide "propongo
 * qualcosa?", questa vista guarda UN progetto per UN viewer, su richiesta, e
 * decide "cosa gli mostro?" — la stessa base dati, letta sincronamente.
 */

/** Chi guarda il riepilogo: id e ruolo, come {@link ActorRole}. */
export interface PulseViewer {
  userId: string;
  role: ActorRole;
}

/**
 * Le due decisioni umane che possono fermare un job, viste da questo modulo:
 * `question` (`ai_jobs.status = 'awaiting_input'`, la notifica è
 * `job.awaiting_input`) e `plan_approval` (`awaiting_plan_approval`, notifica
 * `job.plan_review`). Nome distinto dal `NotificationKind` di
 * `@stubwise/notifications/pure` — qui non c'è il prefisso `job.` perché
 * questa non è (ancora) una notifica, è lo stato del job.
 */
export type PulseWaitingKind = "question" | "plan_approval";

/**
 * Voce di `waitingForYou`: il VIEWER può agire. `notificationId` è la riga
 * d'inbox su cui farlo — stessa identità che `/api/inbox/:id/actions` già
 * accetta, così l'app non ha bisogno di una seconda rotta per "rispondi"
 * o "approva": riusa quella che esiste.
 */
export interface PulseWaitingForYouItem {
  kind: PulseWaitingKind;
  ticketId: string;
  ticketNumber: number;
  title: string;
  notificationId: string;
}

/**
 * Chi PUÒ sbloccare una voce di `waitingForOthers`, quando non è il viewer.
 * STRUTTURATO e non testo: la frase per l'umano («in attesa di un
 * maintainer», «in attesa del richiedente») la compone l'app, che sa in che
 * lingua parlare — il server manda solo il ruolo di chi deve agire, non una
 * stringa già tradotta (vedi il catalogo delle azioni in `./actions.ts`, di
 * cui questo è lo specchio):
 *  - `requester`: `job.awaiting_input` è rivolta a chi ha lanciato il job (più
 *    gli admin, ma per QUESTA voce il viewer non è né l'uno né l'altro — il
 *    dato più specifico che gli si può dare è "aspetta chi l'ha chiesto");
 *  - `maintainer`: `job.plan_review` è `adminOnly` nel catalogo — il
 *    richiedente stesso NON può approvare il proprio piano, quindi qui
 *    l'unico attore possibile è "un admin qualsiasi", mai una persona precisa.
 */
export type PulseWaitingWho = { kind: "requester" } | { kind: "maintainer" };

/** Voce di `waitingForOthers`: il viewer non può agire lui stesso su questa. */
export interface PulseWaitingForOthersItem {
  kind: PulseWaitingKind;
  ticketId: string;
  ticketNumber: number;
  title: string;
  who: PulseWaitingWho;
}

/** Voce di `running`: un job che l'agente sta eseguendo ORA (non solo in coda). */
export interface PulseRunningItem {
  ticketId: string;
  ticketNumber: number;
  title: string;
  /**
   * Minuti trascorsi da `ai_jobs.started_at`, calcolati AL MOMENTO della
   * richiesta: cambia a ogni chiamata, ed è voluto — è un "da quanto", non un
   * dato che ha senso mettere in cache lato client oltre la sessione in cui è
   * arrivato.
   */
  sinceMinutes: number;
}

/**
 * PERCHÉ un ticket è fermo. Gemello di `pulseStalledReasonSchema`
 * (`@stubwise/shared`), che ne è la forma pubblica: il ragionamento per esteso
 * — e in particolare perché il motivo si deriva dai JOB e non dallo STATO —
 * sta nel docblock di là, scritto una volta sola.
 */
export type PulseStalledReason =
  | "to_prepare"
  | "worked_then_stopped"
  | "interrupted"
  | "declared_no_work";

/** Voce di `stalled`: un ticket che non si muove, e da quando. */
export interface PulseStalledItem {
  ticketId: string;
  ticketNumber: number;
  title: string;
  /**
   * L'ultimo MOVIMENTO del ticket in ISO 8601 — il più recente fra
   * `tickets.updated_at` e l'ultima attività di un suo job — non la creazione
   * e non un numero di giorni: i giorni li conta il client al rendering,
   * perché un numero calcolato qui invecchia dentro una risposta in cache.
   */
  stalledSince: string;
  reason: PulseStalledReason;
}

/**
 * Voce di `waitingForMerge`: un ticket con una PR aperta. `canMerge` è
 * calcolato QUI, col ruolo del viewer, mai dedotto dal client — vedi il
 * docblock di `pulseWaitingForMergeItemSchema` in `@stubwise/shared`.
 */
export interface PulseWaitingForMergeItem {
  ticketId: string;
  ticketNumber: number;
  title: string;
  prUrl: string;
  canMerge: boolean;
}

/** Il riepilogo completo di UN progetto per UN viewer. */
export interface ProjectPulseSummary {
  projectId: string;
  projectName: string;
  waitingForYou: PulseWaitingForYouItem[];
  waitingForOthers: PulseWaitingForOthersItem[];
  running: PulseRunningItem[];
  /** Job `failed`. Un rilancio (`startRun`) RIUSA la riga e ne cambia lo stato:
   * un job qui dentro non è mai stato rilanciato, per costruzione — non serve
   * un filtro aggiuntivo "senza rilancio" (vedi `apps/server/src/services/jobs.ts`). */
  failedCount: number;
  /** Voci di backlog `status = 'ready'`: pronte per un «Procedi con…». */
  backlogReadyCount: number;
  /** Giorni dall'ultima attività di un job AI del progetto. 0 se nessun job è
   * mai girato, o se il progetto NON è fermo (l'ultima attività è recentissima). */
  idleDays: number;
  /** I ticket FERMI, dal più vecchio (design §4: l'ordine è per anzianità). */
  stalled: PulseStalledItem[];
  /** I ticket con una PR aperta: non fermi, in attesa del merge. */
  waitingForMerge: PulseWaitingForMergeItem[];
  /** Data (YYYY-MM-DD) dell'ultimo `activity_reports` completato, o null se
   * nessuno è mai stato generato per questo progetto. */
  lastReportDate: string | null;
}

/** Stati di `ai_jobs` che rappresentano una DECISIONE UMANA pendente. */
export const WAITING_STATUSES = ["awaiting_input", "awaiting_plan_approval"] as const;

/**
 * Vero se lo stato è uno di {@link WAITING_STATUSES}. DERIVATA dalla costante
 * (stesso pattern di `isInFlight` in `./actions.ts`) e non un confronto
 * letterale ripetuto qui: uno stato aggiunto o tolto da WAITING_STATUSES
 * cambia anche questa funzione da sola. Un confronto scritto a mano
 * (`status === "awaiting_input" || status === "..."`) potrebbe silenziosamente
 * disallinearsi dalla query SQL che usa la stessa costante (riga sotto) — qui
 * non può, perché leggono lo stesso array.
 */
export function isWaitingStatus(status: string): boolean {
  return (WAITING_STATUSES as readonly string[]).includes(status);
}

/** Stati di `ai_jobs` in cui l'agente sta lavorando DAVVERO (non solo in coda:
 * `queued` non è "running", non c'è ancora nessuna attività da mostrare). */
export const RUNNING_STATUSES = ["triaging", "fixing"] as const;

/** Vero se lo stato è uno di {@link RUNNING_STATUSES}. Stesso pattern di
 * {@link isWaitingStatus}, stesso perché. */
export function isRunningStatus(status: string): boolean {
  return (RUNNING_STATUSES as readonly string[]).includes(status);
}

/**
 * Gli stati TERMINALI di un ticket: da qui in poi non c'è più niente da
 * muovere, quindi un ticket così non può essere "fermo".
 */
export const CLOSED_TICKET_STATUSES = ["done", "closed"] as const;

/**
 * Gli stati di `ai_jobs` che rendono un ticket NON fermo perché qualcuno (o
 * qualcosa) ci sta ancora lavorando o aspettando. È
 * {@link PULSE_BLOCKING_JOB_STATUSES} riusata e non riscritta: è la stessa
 * domanda che il poller del pulse si fa per tacere — «c'è già del lavoro in
 * corso o una decisione pendente?» — e due elenchi separati divergerebbero al
 * primo stato nuovo. Include `held` (limite/budget/gate): un job trattenuto
 * NON è un ticket dimenticato, è un ticket in coda dietro a un cancello.
 */
const LIVE_JOB_STATUSES = PULSE_BLOCKING_JOB_STATUSES;

/**
 * Gli stati di `ai_jobs` in cui il lavoro è arrivato a CONSEGNARE qualcosa: ha
 * aperto una PR. Serve solo a distinguere `interrupted` (cominciato e mai
 * arrivato a niente) dal resto — non è un giudizio sulla qualità del lavoro,
 * solo il fatto che qualcosa di rivedibile sia uscito.
 */
const DELIVERED_JOB_STATUSES = ["pr_opened", "pr_merged"] as const;

/**
 * PERCHÉ questo ticket è fermo. Pura, e separata dalla query apposta: è la
 * regola del design §3, e la si vuole poter esercitare caso per caso senza un
 * Postgres davanti.
 *
 * ⚠️ Il motivo si deriva dai JOB, non dallo STATO — lo stato è una
 * DICHIARAZIONE di qualcuno, i job sono un FATTO. `declared_no_work` esiste
 * proprio per non dire «interrotto» a un ticket che si dichiara in
 * lavorazione ma di lavoro non ne ha mai avuto (il caso #25 in produzione, il
 * cui contenuto era già rilasciato da settimane).
 *
 * Il chiamante ha già stabilito che il ticket È fermo (non chiuso, nessun job
 * vivo, nessuna PR aperta, nessuna domanda in sospeso): qui si risponde solo
 * al «perché».
 */
export function stalledReasonFor(input: {
  ticketStatus: string;
  jobCount: number;
  deliveredJobCount: number;
}): PulseStalledReason {
  const declaredInWork = input.ticketStatus === "in_progress" || input.ticketStatus === "in_review";
  // Nessun job REGISTRATO: la differenza fra «da preparare» e «stato
  // dichiarato, nessun lavoro» sta tutta qui, e l'etichetta del secondo non
  // promette che ci sia qualcosa da fare.
  if (input.jobCount === 0) return declaredInWork ? "declared_no_work" : "to_prepare";
  // Ha avuto job, nessuno vivo (garantito dal chiamante). Se si dichiara in
  // lavorazione e nessuno di quei job è arrivato ad aprire una PR, il lavoro
  // è cominciato e si è fermato a metà: è il caso peggiore, e l'unico che
  // merita quel nome.
  if (input.ticketStatus === "in_progress" && input.deliveredJobCount === 0) return "interrupted";
  return "worked_then_stopped";
}

/**
 * Da quanti giorni è fermo un progetto, data l'ultima attività di un job AI.
 *
 * Duplicata da `idleDaysFrom` in `apps/worker/src/pulse/poller.ts` (stessa
 * logica, stesso perché: vedi il commento là) invece di importata: il worker
 * dipende da `@stubwise/notifications`, non il contrario, quindi un helper
 * privato del poller non è raggiungibile da qui. È una funzione di tre righe;
 * duplicarla costa meno che introdurre un giro di dipendenza per lei sola.
 *
 * Vale 0 quando nessun job è mai girato (progetto nuovo) e quando la data è
 * nel futuro (orologi sfasati fra questo processo e il DB).
 */
function idleDaysFrom(now: Date, lastActivityAt: Date | null): number {
  if (!lastActivityAt) return 0;
  const ms = now.getTime() - lastActivityAt.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Le notifiche del viewer ancorate a uno di questi job, come mappa
 * jobId -> notificationId. Serve SOLO alle voci di `waitingForYou`: le altre
 * non hanno (o non hanno per QUESTO viewer) una riga d'inbox diretta.
 *
 * Filtrata su `status <> 'handled'`: una notifica handled sarebbe STALE per
 * un job ancora fermo su una decisione (l'unica uscita da `awaiting_input`/
 * `awaiting_plan_approval` è proprio rispondere/approvare, che chiude le
 * copie — vedi il commento su `answerQuestion` in `./actions.ts`), quindi non
 * è la riga giusta su cui offrire l'azione. Una `snoozed` invece resta valida:
 * rinviata non vuol dire risolta.
 */
async function loadNotificationIds(
  db: Db,
  userId: string,
  jobIds: string[],
): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .select({ jobId: notifications.jobId, notificationId: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.jobId, jobIds),
        sql`${notifications.status} <> 'handled'`,
      ),
    );
  const byJobId = new Map<string, string>();
  for (const row of rows) {
    if (row.jobId) byJobId.set(row.jobId, row.notificationId);
  }
  return byJobId;
}

/**
 * Il "polso" di UN progetto per UN viewer. Ritorna `null` se il progetto non
 * esiste (più) — cancellato fra la lista letta dal chiamante e questa
 * chiamata: il chiamante lo scarta in silenzio, non è un 404, è una corsa
 * persa contro un'altra richiesta (stesso trattamento di `isProjectIdle`
 * quando il progetto sparisce).
 */
export async function summarizeProject(
  db: Db,
  projectId: string,
  viewer: PulseViewer,
): Promise<ProjectPulseSummary | null> {
  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return null;

  // Le SETTE query indipendenti da qui in poi (job vivi, backlog pronto,
  // fermo/idle, ultimo report, ticket aperti, job dei ticket aperti, PR
  // aperte) non hanno dati in comune fra loro: nessuna
  // legge ciò che un'altra scrive o restituisce. Le si lancia insieme con
  // `Promise.all` invece che in sequenza — dimezza abbondantemente il numero
  // di round-trip in serie per QUESTO progetto (da 6 a ~3: questa più
  // `loadNotificationIds`, che invece DEVE aspettare `jobRows`).
  //
  // ⚠️ LIMITE NOTO v1, non risolto da questo `Promise.all`: per un viewer
  // `admin`, `projectIds` nella rotta (`apps/server/src/routes/projects.ts`)
  // è OGNI progetto dell'istanza, senza cap né paginazione, e la rotta chiama
  // `summarizeProject` per ciascuno IN PARALLELO (anche quello è un
  // `Promise.all`). Il parallelismo qui dentro riduce la latenza per singolo
  // progetto (il caso comune: un viewer segue poche unità), ma su un'istanza
  // con MOLTI progetti alza il picco di query simultanee verso il pool
  // (`DATABASE_POOL_MAX`) — un admin che apre questa vista genera comunque
  // dell'ordine di N×7 query (quattro storiche più le tre del quarto secchio,
  // 21 set 2026), solo più fitte nel tempo invece che più lunghe
  // in serie. Non c'è oggi un cap sul numero di progetti né una paginazione:
  // se un'istanza crescesse a centinaia di progetti, andrebbe rivisitato
  // (limite sui progetti restituiti all'admin, o esecuzione a lotti). Stessa
  // categoria della sezione "limite noto v1" sui Plugin di progetto in
  // CLAUDE.md: accettato per la v1, non per un difetto di oggi.
  const [jobRows, backlogReadyRow, idleness, lastReportRow, openTicketRows, ticketJobRows, openPrRows] =
    await Promise.all([
    // I job "vivi" del progetto in UNA query: le due categorie di attesa, i
    // due stati "in esecuzione" e i falliti. Un solo giro invece di quattro:
    // il filtro sullo stato è lo stesso indice (`ai_jobs_ticket_id_idx` + il
    // join su `tickets`) che i segnali del pulse già pagano.
    db
      .select({
        jobId: aiJobs.id,
        ticketId: tickets.id,
        ticketNumber: tickets.number,
        title: tickets.title,
        status: aiJobs.status,
        requestedByUserId: aiJobs.requestedByUserId,
        // Calcolato IN SQL, non in JS dopo il fetch: evita lo sfasamento fra
        // l'orologio di questo processo e quello del DB. A differenza di
        // `idleDays` (granularità giorni, dove qualche secondo di skew è
        // innocuo), un job appena avviato deve poter dire "da 0 minuti" con
        // precisione.
        sinceMinutes: sql<number | null>`floor(extract(epoch from (now() - ${aiJobs.startedAt})) / 60)::int`,
      })
      .from(aiJobs)
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .where(
        and(
          eq(tickets.projectId, projectId),
          inArray(aiJobs.status, [...WAITING_STATUSES, ...RUNNING_STATUSES, "failed"]),
        ),
      )
      // Ordine stabile e leggibile: il ticket più vecchio del progetto prima.
      // Nessun requisito funzionale dietro, solo test deterministici.
      .orderBy(tickets.number),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(backlogItems)
      .where(and(eq(backlogItems.projectId, projectId), eq(backlogItems.status, "ready")))
      .then((rows) => rows[0]),
    isProjectIdle(db, projectId),
    db
      .select({ date: sql<string | null>`max(${activityReports.date})` })
      .from(activityReports)
      .where(and(eq(activityReports.projectId, projectId), eq(activityReports.status, "done")))
      .then((rows) => rows[0]),
    // I ticket NON chiusi del progetto: la platea da cui escono sia `stalled`
    // sia `waitingForMerge`. `hasOpenQuestion` viaggia come `exists` nella
    // stessa select invece che in una query a sé — è un booleano per riga, non
    // un elenco da mostrare, e una query in meno qui è una query in meno
    // MOLTIPLICATA per il numero di progetti di un admin (vedi il limite noto
    // poco sopra).
    db
      .select({
        ticketId: tickets.id,
        ticketNumber: tickets.number,
        title: tickets.title,
        status: tickets.status,
        updatedAt: tickets.updatedAt,
        hasOpenQuestion: exists(
          db
            .select({ one: sql`1` })
            .from(agentQuestions)
            .where(
              and(eq(agentQuestions.ticketId, tickets.id), isNull(agentQuestions.answeredAt)),
            ),
        ),
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.projectId, projectId),
          notInArray(tickets.status, [...CLOSED_TICKET_STATUSES]),
        ),
      ),
    // I job di quei ticket, TUTTI — conclusi compresi. È la differenza con
    // `jobRows` qui sopra, che pesca solo i vivi e i falliti: qui serve sapere
    // anche che un job c'È STATO ed è finito, perché «mai lavorato» e
    // «lavorato, poi fermo» sono motivi diversi. Il join sui soli ticket non
    // chiusi tiene la query piccola: non è la storia del progetto, è la storia
    // di ciò che è ancora aperto.
    db
      .select({
        ticketId: aiJobs.ticketId,
        status: aiJobs.status,
        lastActivityAt: aiJobs.lastActivityAt,
      })
      .from(aiJobs)
      .innerJoin(tickets, eq(tickets.id, aiJobs.ticketId))
      .where(
        and(
          eq(tickets.projectId, projectId),
          notInArray(tickets.status, [...CLOSED_TICKET_STATUSES]),
        ),
      ),
    // Le PR aperte, con la STESSA condizione della coda di rilascio
    // (`listReleaseQueue`, `apps/server/src/services/release.ts`): `prState =
    // 'open'` E `prUrl` valorizzato. Non è pignoleria — `prState` nasce
    // `'open'` di default, quindi una riga con `prUrl` nullo è un branch
    // preparato di cui la PR non è MAI stata aperta. Tenerla qui direbbe «sta
    // aspettando il merge» di una PR che non esiste; escluderla la lascia
    // cadere fra i fermi, che è ciò che è davvero.
    db
      .select({
        ticketId: tickets.id,
        ticketNumber: tickets.number,
        title: tickets.title,
        prUrl: ticketRepositories.prUrl,
      })
      .from(ticketRepositories)
      .innerJoin(tickets, eq(tickets.id, ticketRepositories.ticketId))
      .where(
        and(
          eq(tickets.projectId, projectId),
          notInArray(tickets.status, [...CLOSED_TICKET_STATUSES]),
          eq(ticketRepositories.prState, "open"),
          isNotNull(ticketRepositories.prUrl),
        ),
      )
      .orderBy(tickets.number),
  ]);

  const waitingRows = jobRows.filter((row) => isWaitingStatus(row.status));

  const notificationByJobId = await loadNotificationIds(
    db,
    viewer.userId,
    waitingRows.map((row) => row.jobId),
  );

  const waitingForYou: PulseWaitingForYouItem[] = [];
  const waitingForOthers: PulseWaitingForOthersItem[] = [];

  for (const row of waitingRows) {
    // Binario e non derivato da WAITING_STATUSES di proposito: `row` è già
    // filtrata da isWaitingStatus, quindi qui i valori possibili sono solo
    // questi due. Se un domani WAITING_STATUSES cresce a un terzo stato,
    // questo ternario lo etichetterebbe silenziosamente "plan_approval" — a
    // quel punto serve uno switch esaustivo su PulseWaitingKind (o l'unione
    // che copre il nuovo stato), non un terzo ramo qui: un `.includes` non
    // basterebbe comunque a essere esaustivo su più di due valori.
    const kind: PulseWaitingKind = row.status === "awaiting_input" ? "question" : "plan_approval";
    // Il kind di NOTIFICA e l'AZIONE corrispondente a questo tipo di attesa:
    // servono solo a interrogare `actorAllows`, la stessa funzione che decide
    // i bottoni delle notifiche vere (`./actions.ts`). Nessuna policy scritta
    // qui: la policy resta unica, in un solo posto.
    const notifKind: NotificationKind = kind === "plan_approval" ? "job.plan_review" : "job.awaiting_input";
    const action: ActionId = kind === "plan_approval" ? "approve_plan" : "answer";
    const notification: ActionableNotification = {
      kind: notifKind,
      requestedByUserId: row.requestedByUserId,
    };

    const canAct = actorAllows(notification, action, { id: viewer.userId, role: viewer.role });

    const shared = {
      kind,
      ticketId: row.ticketId,
      ticketNumber: row.ticketNumber,
      title: row.title,
    };

    if (canAct) {
      const notificationId = notificationByJobId.get(row.jobId);
      // Difensivo: senza una notifica su cui agire la voce non entra in
      // `waitingForYou` (mostrarla senza un modo di agirci sarebbe peggio che
      // ometterla per questo giro) — né altrove: non è compito di questa
      // funzione indovinare dove metterla.
      if (notificationId) waitingForYou.push({ ...shared, notificationId });
    } else {
      // "Chi PUÒ sbloccarla, se non il viewer?" è la stessa domanda che
      // `actorAllows` sa rispondere per un attore preciso — la si pone per IL
      // RICHIEDENTE (ipotetico, ruolo `member`) invece di ripetere qui la
      // policy per kind. Se anche un richiedente `member` risulterebbe
      // ammesso, lui è il destinatario naturale (`requester`, es.
      // `job.awaiting_input`); se no, resta solo l'ammissione per RUOLO
      // (`maintainer`, es. `job.plan_review`, `adminOnly` nel catalogo — il
      // richiedente stesso non basta). Nessuna seconda policy scritta a mano:
      // stessa chiamata a `actorAllows` di sopra, solo con un attore diverso.
      const requesterCouldAct =
        row.requestedByUserId !== null &&
        actorAllows(notification, action, { id: row.requestedByUserId, role: "member" });
      const who: PulseWaitingWho = requesterCouldAct ? { kind: "requester" } : { kind: "maintainer" };
      waitingForOthers.push({ ...shared, who });
    }
  }

  const running: PulseRunningItem[] = jobRows
    .filter((row) => isRunningStatus(row.status))
    .map((row) => ({
      ticketId: row.ticketId,
      ticketNumber: row.ticketNumber,
      title: row.title,
      // `startedAt` è sempre valorizzato per triaging/fixing (`claimNextJob`
      // lo scrive all'atto del claim, e nessuna transizione successiva lo
      // azzera finché il job resta in uno di questi due stati): il fallback a
      // 0 è difensivo, non un caso che ci si aspetti di incontrare.
      sinceMinutes: row.sinceMinutes ?? 0,
    }));

  const failedCount = jobRows.filter((row) => row.status === "failed").length;

  // --- IL QUARTO SECCHIO: ciò che non si muove (21 set 2026) ---------------
  //
  // ⚠️ IL CRITERIO STA QUI, E IN NESSUN ALTRO POSTO. Un ticket è FERMO quando
  // non è chiuso, non ha un job vivo, non ha una PR aperta e non ha una
  // domanda dell'agente in sospeso: nessuno ci sta lavorando e nessuno sta
  // aspettando nessun altro. Chi ne ha bisogno altrove chiami questa funzione
  // — non lo ricopi in SQL: il repo ha già due casi di una stessa regola
  // scritta in due lingue (`isReadyForProposal` e la query del propose phase)
  // e reggono solo perché documentati con insistenza. Qui non serve pagare
  // quel prezzo.
  //
  // Le due liste sono COMPLEMENTARI per costruzione: la condizione sulla PR è
  // la stessa in entrambe (la query qui sopra), quindi un ticket con una PR
  // aperta finisce in `waitingForMerge` e MAI in `stalled`, e uno senza non
  // può sparire da tutte e due.
  const ticketsWithOpenPr = new Set(openPrRows.map((row) => row.ticketId));

  // `canMerge` deciso UNA volta, qui, col ruolo del viewer: è il divieto
  // dell'operatore (CLAUDE.md, punto 2) applicato IN LETTURA, con lo stesso
  // criterio di `requireAdmin` sulla rotta di rilascio e del controllo
  // ridondante dentro `releasePullRequest`. Il client non lo deduce mai da sé:
  // l'app si aggiorna dagli store, e una copia del divieto là dentro sarebbe
  // la copia che non possiamo correggere.
  const canMerge = viewer.role === "admin";
  const waitingForMerge: PulseWaitingForMergeItem[] = openPrRows
    .filter((row): row is typeof row & { prUrl: string } => row.prUrl !== null)
    .map((row) => ({
      ticketId: row.ticketId,
      ticketNumber: row.ticketNumber,
      title: row.title,
      prUrl: row.prUrl,
      canMerge,
    }));

  const jobsByTicket = new Map<string, { status: string; lastActivityAt: Date }[]>();
  for (const row of ticketJobRows) {
    const existing = jobsByTicket.get(row.ticketId);
    if (existing) existing.push(row);
    else jobsByTicket.set(row.ticketId, [row]);
  }

  const stalled: PulseStalledItem[] = [];
  for (const ticket of openTicketRows) {
    if (ticket.hasOpenQuestion) continue;
    if (ticketsWithOpenPr.has(ticket.ticketId)) continue;
    const jobs = jobsByTicket.get(ticket.ticketId) ?? [];
    if (jobs.some((job) => (LIVE_JOB_STATUSES as readonly string[]).includes(job.status))) continue;

    // L'ultimo MOVIMENTO, non la creazione (design §4): il più recente fra la
    // riga del ticket e l'attività dei suoi job. Nessuna delle due basta da
    // sola — un job che gira non tocca `tickets.updated_at`, e un ticket senza
    // job non ha attività di job.
    let lastMovedAt = ticket.updatedAt;
    for (const job of jobs) {
      if (job.lastActivityAt > lastMovedAt) lastMovedAt = job.lastActivityAt;
    }

    stalled.push({
      ticketId: ticket.ticketId,
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      stalledSince: lastMovedAt.toISOString(),
      reason: stalledReasonFor({
        ticketStatus: ticket.status,
        jobCount: jobs.length,
        deliveredJobCount: jobs.filter((job) =>
          (DELIVERED_JOB_STATUSES as readonly string[]).includes(job.status),
        ).length,
      }),
    });
  }
  // Dal più fermo (design §4). L'ordine È parte del significato: senza, il
  // secchio diventa l'elenco piatto che il §2 ha scartato. Le date sono ISO
  // 8601 in UTC, quindi l'ordine lessicografico È quello cronologico.
  stalled.sort((a, b) => a.stalledSince.localeCompare(b.stalledSince));

  // `backlogReadyRow`, `idleness` e `lastReportRow` sono già arrivati dal
  // `Promise.all` di sopra: qui si legge solo il risultato.
  const idleDays = idleDaysFrom(new Date(), idleness.lastJobActivityAt);

  return {
    projectId: project.id,
    projectName: project.name,
    waitingForYou,
    waitingForOthers,
    running,
    failedCount,
    backlogReadyCount: backlogReadyRow?.count ?? 0,
    idleDays,
    stalled,
    waitingForMerge,
    lastReportDate: lastReportRow?.date ?? null,
  };
}
