import {
  activityReports,
  aiJobs,
  backlogItems,
  notifications,
  projects,
  tickets,
  type Db,
} from "@stubwise/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  actorAllows,
  type ActionableNotification,
  type ActionId,
  type ActorRole,
} from "./actions.js";
import type { NotificationKind } from "./format.js";
import { isProjectIdle } from "./project-signals.js";

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

  // Le QUATTRO query indipendenti da qui in poi (job vivi, backlog pronto,
  // fermo/idle, ultimo report) non hanno dati in comune fra loro: nessuna
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
  // dell'ordine di N×4 query, solo più fitte nel tempo invece che più lunghe
  // in serie. Non c'è oggi un cap sul numero di progetti né una paginazione:
  // se un'istanza crescesse a centinaia di progetti, andrebbe rivisitato
  // (limite sui progetti restituiti all'admin, o esecuzione a lotti). Stessa
  // categoria della sezione "limite noto v1" sui Plugin di progetto in
  // CLAUDE.md: accettato per la v1, non per un difetto di oggi.
  const [jobRows, backlogReadyRow, idleness, lastReportRow] = await Promise.all([
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
    lastReportDate: lastReportRow?.date ?? null,
  };
}
