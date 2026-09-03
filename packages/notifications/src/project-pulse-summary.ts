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
import type { ActorRole } from "./actions.js";
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
const WAITING_STATUSES = ["awaiting_input", "awaiting_plan_approval"] as const;

/** Stati di `ai_jobs` in cui l'agente sta lavorando DAVVERO (non solo in coda:
 * `queued` non è "running", non c'è ancora nessuna attività da mostrare). */
const RUNNING_STATUSES = ["triaging", "fixing"] as const;

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

  // I job "vivi" del progetto in UNA query: le due categorie di attesa, i due
  // stati "in esecuzione" e i falliti. Un solo giro invece di quattro: il
  // filtro sullo stato è lo stesso indice (`ai_jobs_ticket_id_idx` + il join
  // su `tickets`) che i segnali del pulse già pagano.
  const jobRows = await db
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
    .orderBy(tickets.number);

  const waitingRows = jobRows.filter(
    (row) => row.status === "awaiting_input" || row.status === "awaiting_plan_approval",
  );

  const notificationByJobId = await loadNotificationIds(
    db,
    viewer.userId,
    waitingRows.map((row) => row.jobId),
  );

  const waitingForYou: PulseWaitingForYouItem[] = [];
  const waitingForOthers: PulseWaitingForOthersItem[] = [];

  for (const row of waitingRows) {
    const kind: PulseWaitingKind = row.status === "awaiting_input" ? "question" : "plan_approval";
    // `job.plan_review` è `adminOnly` nel catalogo delle azioni: il
    // richiedente stesso non può approvare il proprio piano, quindi qui
    // l'identità non conta, solo il ruolo. `job.awaiting_input` invece la
    // offre ad admin O richiedente (vedi `actorAllows` in `./actions.ts`):
    // qui la specificità conta, e va ripetuta qui perché quella funzione
    // lavora su una `NotificationEvent` già costruita, non su un job.
    const canAct =
      kind === "plan_approval"
        ? viewer.role === "admin"
        : viewer.role === "admin" ||
          (row.requestedByUserId !== null && row.requestedByUserId === viewer.userId);

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
      const who: PulseWaitingWho =
        kind === "plan_approval" ? { kind: "maintainer" } : { kind: "requester" };
      waitingForOthers.push({ ...shared, who });
    }
  }

  const running: PulseRunningItem[] = jobRows
    .filter((row) => row.status === "triaging" || row.status === "fixing")
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

  const [backlogReadyRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(backlogItems)
    .where(and(eq(backlogItems.projectId, projectId), eq(backlogItems.status, "ready")));

  const idleness = await isProjectIdle(db, projectId);
  const idleDays = idleDaysFrom(new Date(), idleness.lastJobActivityAt);

  const [lastReportRow] = await db
    .select({ date: sql<string | null>`max(${activityReports.date})` })
    .from(activityReports)
    .where(and(eq(activityReports.projectId, projectId), eq(activityReports.status, "done")));

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
