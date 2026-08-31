/**
 * Servizio INBOX: cosa un utente vede nella sua lista di notifiche, quali
 * azioni può compiere su ciascuna e cosa succede quando ne compie una.
 *
 * È il gemello di `./jobs.ts` sul lato "notifiche": le rotte `/api/inbox`
 * (Task 8) e le interazioni Slack (Task 10) passano tutte di qui invece di
 * scrivere `notifications` a mano, così le due superfici applicano le stesse
 * regole di permesso, la stessa propagazione di `handled` e gli stessi errori.
 *
 * Il catalogo delle azioni è CALCOLATO, mai persistito: dipende dal `kind`
 * della notifica, dallo stato ATTUALE dell'ultimo job del ticket e dal ruolo di
 * chi guarda. Persisterlo vorrebbe dire riscriverlo a ogni transizione di stato
 * del job (e sbagliarlo).
 *
 * NB (Task 9): `actionsFor` è pura e non tocca il DB. Quando il poller delle
 * consegne dovrà comporre i bottoni Block Kit del DM Slack le servirà anche nel
 * worker — che NON può importare da `apps/server`: a quel punto va spostata in
 * `packages/notifications/src/actions.ts` e ri-esportata da qui. Finché il
 * consumatore è uno solo, resta nel server.
 */
import { aiJobs, notifications, users, type Db } from "@stubwise/db";
import type { Language } from "@stubwise/i18n";
import {
  formatNotificationText,
  type NotificationEvent,
  type NotificationKind,
} from "@stubwise/notifications";
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { IN_FLIGHT, resolvePlan, startRun, type Actor } from "./jobs.js";

/** Le azioni che una notifica può offrire. `open` è l'unica non eseguibile lato server. */
export type ActionId = "approve_plan" | "reject_plan" | "relaunch" | "open" | "snooze" | "handled";

/** Durate di rinvio ammesse dallo snooze. */
export type SnoozeUntil = "1h" | "tomorrow" | "3d";

/** Stato di una riga d'inbox (speculare all'enum DB `notification_status`). */
export type InboxStatus = "open" | "handled" | "snoozed";

/** Quel poco che serve a {@link actionsFor}: il resto della riga è irrilevante. */
export interface ActionableNotification {
  kind: NotificationKind;
}

/**
 * Azione DECISIONALE offerta da ciascun kind, col ruolo minimo per compierla.
 *
 * `job.held` e `job.budget_held` sono lo stesso stato del job (`held`) con
 * `heldReason` diverso: un fermo "normale" lo può sbloccare chiunque, uno per
 * budget sforato no — è una decisione di spesa, e la portano già separata i due
 * `kind`, quindi qui non serve rileggere `ai_jobs.held_reason`.
 *
 * Record esaustivo su `NotificationKind`: un kind nuovo non compila finché non
 * gli si decide un'azione (anche "nessuna").
 */
const DECISION_FOR_KIND: Record<NotificationKind, { actions: ActionId[]; adminOnly: boolean }> = {
  "job.plan_review": { actions: ["approve_plan", "reject_plan"], adminOnly: true },
  "job.held": { actions: ["relaunch"], adminOnly: false },
  "job.budget_held": { actions: ["relaunch"], adminOnly: true },
  "job.failed": { actions: ["relaunch"], adminOnly: false },
  "job.pr_closed": { actions: ["relaunch"], adminOnly: false },
  // Informativi: si aprono, si rinviano, si archiviano. Nient'altro.
  "job.pr_opened": { actions: [], adminOnly: false },
  "review.completed": { actions: [], adminOnly: false },
  "ticket.created": { actions: [], adminOnly: false },
  "docs.limit_paused": { actions: [], adminOnly: false },
  "monitor.alert": { actions: [], adminOnly: false },
  "monitor.recovered": { actions: [], adminOnly: false },
};

/** Azioni disponibili su OGNI notifica: sono igiene dell'inbox, non decisioni. */
const ALWAYS: ActionId[] = ["open", "snooze", "handled"];

/** True se lo stato del job è uno di {@link IN_FLIGHT} (lavoro in corso). */
function isInFlight(jobStatus: string | null | undefined): boolean {
  return jobStatus != null && (IN_FLIGHT as readonly string[]).includes(jobStatus);
}

/**
 * Il RUOLO consente l'azione? Separata da {@link stateAllows} perché i due "no"
 * hanno messaggi diversi: chi non ha il ruolo riceve `forbidden` e basta, chi ce
 * l'ha ma arriva tardi merita di sapere che il job è già ripartito.
 */
function roleAllows(kind: NotificationKind, action: ActionId, role: Actor["role"]): boolean {
  if (ALWAYS.includes(action)) return true;
  const decision = DECISION_FOR_KIND[kind];
  if (!decision.actions.includes(action)) return false;
  return !decision.adminOnly || role === "admin";
}

/**
 * Lo STATO ATTUALE del job consente l'azione? `approve_plan`/`reject_plan` solo
 * su un piano davvero fermo sul gate; `relaunch` solo se l'ultimo job del ticket
 * non è in volo (rilanciarne uno vivo scippa il lavoro al worker).
 */
function stateAllows(action: ActionId, jobStatus: string | null | undefined): boolean {
  switch (action) {
    case "approve_plan":
    case "reject_plan":
      return jobStatus === "awaiting_plan_approval";
    case "relaunch":
      return !isInFlight(jobStatus);
    default:
      return true;
  }
}

/**
 * Azioni offerte su una notifica, nell'ordine in cui vanno mostrate: prima le
 * decisioni (se il ruolo e lo stato le consentono), poi apri/rinvia/archivia.
 *
 * `jobStatus` è lo stato dell'ULTIMO job del ticket a cui la notifica è
 * ancorata (`null` per gli eventi senza ticket, come `monitor.*`). Funzione
 * pura: nessun accesso al DB, così la si può chiamare in batch su una pagina
 * intera senza N+1.
 */
export function actionsFor(
  notification: ActionableNotification,
  jobStatus: string | null | undefined,
  actor: Actor,
): ActionId[] {
  const decisions = DECISION_FOR_KIND[notification.kind].actions.filter(
    (action) => roleAllows(notification.kind, action, actor.role) && stateAllows(action, jobStatus),
  );
  return [...decisions, ...ALWAYS];
}

/**
 * Dove porta `open`: la superficie su cui l'utente va a *fare* qualcosa.
 *
 * Per gli eventi il cui soggetto È la pull request (`job.pr_opened`,
 * `review.completed`) è la PR sul provider git — è lì che si legge il diff e si
 * approva. Per `job.pr_closed` no: la PR è chiusa, quello che conta è il ticket
 * riaperto. Gli eventi senza ticket portano alla loro pagina (Docs, server
 * monitorato).
 */
export function openUrl(event: NotificationEvent): string {
  switch (event.kind) {
    case "job.pr_opened":
    case "review.completed":
      return event.prUrl;
    case "docs.limit_paused":
      return event.docsUrl;
    case "monitor.alert":
    case "monitor.recovered":
      return event.url;
    case "ticket.created":
    case "job.pr_closed":
    case "job.held":
    case "job.plan_review":
    case "job.budget_held":
    case "job.failed":
      return event.ticketUrl;
  }
}

/** Chi ha chiuso una notifica: l'id per la UI, l'email per dirlo a parole. */
export interface HandledBy {
  id: string;
  email: string;
}

/** Errori tipizzati di {@link executeAction}, mappati a HTTP dalle rotte. */
export type ExecuteActionError =
  | "not_found"
  | "forbidden"
  | "invalid_action"
  | "already_handled"
  | "job_in_flight"
  | "plan_not_pending";

export type ExecuteActionResult =
  | { ok: true; action: ActionId; jobId?: string; snoozedUntil?: Date }
  | {
      ok: false;
      error: ExecuteActionError;
      handledBy?: HandledBy;
      jobStatus?: string;
    };

export interface ExecuteActionInput {
  notificationId: string;
  action: ActionId;
  actor: Actor;
  /** Parametri dell'azione: `until` per lo snooze, `instructions` per il rifiuto. */
  payload?: { until?: SnoozeUntil; instructions?: string };
  /** PUBLIC_URL, inoltrato a `startRun` per i link nelle notifiche che emette. */
  publicUrl?: string;
}

/** Scadenze dello snooze, calcolate dall'orologio del DB (una sola sorgente di tempo). */
const SNOOZE_DEADLINE: Record<SnoozeUntil, SQL> = {
  // Rinvio breve: "riprovo dopo pranzo".
  "1h": sql`now() + interval '1 hour'`,
  // "Domani" = +24h, non le 08:00 di domani: senza il fuso orario dell'utente
  // un'ora fissa sarebbe giusta solo per chi sta nel fuso del server, mentre
  // +24h significa la stessa cosa ovunque. Se un giorno la UI manda il fuso,
  // è qui l'unico punto da cambiare.
  tomorrow: sql`now() + interval '24 hours'`,
  "3d": sql`now() + interval '3 days'`,
};

/** True se la stringa è una durata di snooze ammessa. */
function isSnoozeUntil(value: string | undefined): value is SnoozeUntil {
  return value === "1h" || value === "tomorrow" || value === "3d";
}

/**
 * Esegue un'azione dell'inbox per conto di `actor`.
 *
 * Regole trasversali:
 *  - la notifica DEVE essere dell'utente: quella di un altro risponde
 *    `not_found`, mai `forbidden` (non se ne rivela nemmeno l'esistenza);
 *  - `open` non è eseguibile lato server (è un link): `invalid_action`;
 *  - `snooze`/`handled` toccano SOLO la propria riga — sono igiene personale;
 *  - le azioni DECISIONALI (`approve_plan`, `reject_plan`, `relaunch`) passano
 *    dai servizi di `./jobs.ts` e, se vanno a buon fine, chiudono in blocco
 *    tutte le copie della stessa notifica (stesso `jobId` + `kind`), anche
 *    quelle di altri utenti: la decisione è una sola per tutti.
 *
 * ORDINE (anti doppia esecuzione): prima si esegue il servizio del job — che ha
 * già la sua guardia sullo stato (UPDATE condizionato in `resolvePlan`, lock
 * advisory + guardia in `startRun`), quindi in una corsa vince UNA sola
 * chiamata — e SOLO se ha successo si propaga `handled`. L'inverso lascerebbe
 * notifiche chiuse con il job intatto.
 */
export async function executeAction(
  db: Db,
  input: ExecuteActionInput,
): Promise<ExecuteActionResult> {
  const { notificationId, action, actor } = input;

  const [row] = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      status: notifications.status,
      ticketId: notifications.ticketId,
      jobId: notifications.jobId,
    })
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, actor.id)));
  if (!row) return { ok: false, error: "not_found" };

  if (action === "open") return { ok: false, error: "invalid_action" };

  if (action === "snooze") {
    const until = input.payload?.until;
    if (!isSnoozeUntil(until)) return { ok: false, error: "invalid_action" };
    const updated = await db
      .update(notifications)
      .set({ status: "snoozed", snoozedUntil: SNOOZE_DEADLINE[until] })
      .where(and(eq(notifications.id, row.id), ne(notifications.status, "handled")))
      .returning({ snoozedUntil: notifications.snoozedUntil });
    // 0 righe = la notifica è già stata chiusa nel frattempo: rinviare una
    // decisione già presa non ha senso, e riaprirla cancellerebbe `handledAt`
    // (che il CHECK `handled ⇔ handled_at` lega allo stato).
    if (updated.length === 0) return alreadyHandled(db, row.id);
    return { ok: true, action, snoozedUntil: updated[0]!.snoozedUntil ?? undefined };
  }

  if (action === "handled") {
    const updated = await db
      .update(notifications)
      .set({
        status: "handled",
        handledAt: sql`now()`,
        handledByUserId: actor.id,
        snoozedUntil: null,
      })
      .where(and(eq(notifications.id, row.id), ne(notifications.status, "handled")))
      .returning({ id: notifications.id });
    if (updated.length === 0) return alreadyHandled(db, row.id);
    return { ok: true, action };
  }

  // --- Azioni decisionali ---

  if (!roleAllows(row.kind, action, actor.role)) return { ok: false, error: "forbidden" };
  // Una decisione sul job ha bisogno di un ticket dietro: gli eventi d'istanza
  // (docs/monitor) non arrivano qui, ma una riga con `ticket_id` nullo sì.
  if (!row.ticketId) return { ok: false, error: "invalid_action" };

  // Già chiusa (da noi o da un collega): il messaggio giusto è "l'ha fatto X",
  // non "il piano non è più pendente". Va controllato PRIMA dello stato del job,
  // che dopo la decisione è per forza cambiato.
  if (row.status === "handled") return alreadyHandled(db, row.id);

  const jobStatus = await latestJobStatus(db, row.ticketId);
  if (!stateAllows(action, jobStatus)) {
    return action === "relaunch"
      ? { ok: false, error: "job_in_flight", ...(jobStatus ? { jobStatus } : {}) }
      : { ok: false, error: "plan_not_pending" };
  }

  const outcome = await runDecision(db, row.ticketId, action, input);
  if (!outcome.ok) {
    // `plan_not_pending` può voler dire due cose: nessuno ha ancora deciso e il
    // job è semplicemente andato avanti, oppure qualcuno ha appena approvato
    // dalla pagina ticket e la propagazione ci ha già chiuso la riga. Si guarda
    // la riga per rispondere la verità.
    if (outcome.error === "plan_not_pending") {
      const handled = await handledByOf(db, row.id);
      if (handled) return { ok: false, error: "already_handled", handledBy: handled };
    }
    return outcome;
  }

  await propagateHandled(db, {
    notificationId: row.id,
    jobId: row.jobId,
    kind: row.kind,
    actorId: actor.id,
  });
  return { ok: true, action, jobId: outcome.jobId };
}

/** Esegue l'azione decisionale sul servizio dei job e ne normalizza l'esito. */
async function runDecision(
  db: Db,
  ticketId: string,
  action: "approve_plan" | "reject_plan" | "relaunch",
  input: ExecuteActionInput,
): Promise<
  { ok: true; jobId: string } | { ok: false; error: ExecuteActionError; jobStatus?: string }
> {
  const { actor } = input;
  if (action === "relaunch") {
    const result = await startRun(db, {
      ticketId,
      actor,
      ...(input.publicUrl ? { publicUrl: input.publicUrl } : {}),
    });
    if (result.ok) return { ok: true, jobId: result.jobId };
    return result.error === "ticket_not_found"
      ? { ok: false, error: "not_found" }
      : {
          ok: false,
          error: "job_in_flight",
          ...(result.jobStatus ? { jobStatus: result.jobStatus } : {}),
        };
  }

  const instructions = input.payload?.instructions?.trim();
  const result = await resolvePlan(db, {
    ticketId,
    actor,
    mode: action === "approve_plan" ? "execute" : "fix",
    ...(action === "reject_plan" && instructions ? { instructions } : {}),
  });
  if (result.ok) return { ok: true, jobId: result.jobId };
  return {
    ok: false,
    error: result.error === "ticket_not_found" ? "not_found" : result.error,
  };
}

/**
 * Chiude TUTTE le copie ancora aperte della stessa notifica: stesso `jobId` e
 * stesso `kind`. Un solo UPDATE guardato su `status <> 'handled'`, quindi
 * atomico e idempotente — chi era già chiuso conserva il suo `handled_by`.
 *
 * Il `kind` fa parte della chiave apposta: sullo stesso job convivono notifiche
 * diverse (il `job.failed` di ieri e il `job.plan_review` di oggi), e approvare
 * il piano non archivia il fallimento precedente.
 *
 * Senza `jobId` (eventi non ancorati a un job) si chiude la sola riga d'origine.
 */
async function propagateHandled(
  db: Db,
  args: { notificationId: string; jobId: string | null; kind: NotificationKind; actorId: string },
): Promise<void> {
  const target = args.jobId
    ? and(eq(notifications.jobId, args.jobId), eq(notifications.kind, args.kind))
    : eq(notifications.id, args.notificationId);
  await db
    .update(notifications)
    .set({
      status: "handled",
      handledAt: sql`now()`,
      handledByUserId: args.actorId,
      snoozedUntil: null,
    })
    .where(and(target, ne(notifications.status, "handled")));
}

/** Esito "già gestita", completo di chi l'ha gestita (se lo sappiamo). */
async function alreadyHandled(db: Db, notificationId: string): Promise<ExecuteActionResult> {
  const handledBy = await handledByOf(db, notificationId);
  return { ok: false, error: "already_handled", ...(handledBy ? { handledBy } : {}) };
}

/**
 * Chi ha chiuso la notifica, o `undefined` se non è chiusa (o l'ha chiusa il
 * sistema: `handled_by_user_id` è nullo quando a chiudere è stato un evento).
 */
async function handledByOf(db: Db, notificationId: string): Promise<HandledBy | undefined> {
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.handledByUserId))
    .where(and(eq(notifications.id, notificationId), eq(notifications.status, "handled")));
  return row ?? undefined;
}

/** Stato dell'ultimo job del ticket (per createdAt, id come spareggio). */
async function latestJobStatus(db: Db, ticketId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: aiJobs.status })
    .from(aiJobs)
    .where(eq(aiJobs.ticketId, ticketId))
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
    .limit(1);
  return row?.status ?? null;
}

/** Una riga d'inbox pronta per la UI: testo già localizzato e azioni calcolate. */
export interface InboxItem {
  id: string;
  kind: NotificationKind;
  status: InboxStatus;
  /** Frase localizzata senza markup, dalla stessa fonte dei webhook. */
  text: string;
  /** Dove porta l'azione `open`. */
  url: string;
  actions: ActionId[];
  projectId: string | null;
  ticketId: string | null;
  jobId: string | null;
  createdAt: Date;
  readAt: Date | null;
  snoozedUntil: Date | null;
  handledAt: Date | null;
  handledBy: HandledBy | null;
}

export interface ListInboxInput {
  userId: string;
  /** Default `open`: l'inbox è la lista di ciò che resta da smaltire. */
  status?: InboxStatus;
  projectId?: string;
  limit?: number;
  /** Cursore keyset opaco restituito dalla pagina precedente. */
  cursor?: string;
  /** Lingua in cui rendere i testi (di norma `users.language` del destinatario). */
  lang: Language;
}

export interface ListInboxResult {
  items: InboxItem[];
  nextCursor: string | null;
  /** Presente solo se il cursore ricevuto era malformato (→ 400 lato rotta). */
  invalidCursor?: true;
}

/** Quante notifiche per pagina se il chiamante non lo dice, e il tetto massimo. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Pagina dell'inbox di un utente, dalla più recente.
 *
 * PRIMA della lettura riapre gli snooze scaduti (UPDATE lazy): non c'è un job
 * che li risveglia, quindi la sveglia è il primo che guarda l'inbox. È un
 * UPDATE mirato sull'utente e sull'indice `(user_id, status, created_at, id)`.
 *
 * Le azioni hanno bisogno dello stato dell'ultimo job di ogni ticket: si
 * risolve con UNA query sul batch di ticket della pagina (niente N+1), come per
 * gli utenti che hanno chiuso le notifiche.
 */
export async function listInbox(db: Db, input: ListInboxInput): Promise<ListInboxResult> {
  const { userId, lang } = input;
  const status = input.status ?? "open";
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !cursor) {
    return { items: [], nextCursor: null, invalidCursor: true };
  }

  await reopenExpiredSnoozes(db, userId);

  // Il ruolo del destinatario decide metà del catalogo azioni: senza utente
  // (cancellato fra due richieste) non c'è nemmeno un'inbox da mostrare.
  const [me] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!me) return { items: [], nextCursor: null };
  const actor: Actor = { id: userId, role: me.role };

  const conditions = [eq(notifications.userId, userId), eq(notifications.status, status)];
  if (input.projectId) conditions.push(eq(notifications.projectId, input.projectId));
  if (cursor) {
    conditions.push(
      sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      status: notifications.status,
      event: notifications.event,
      projectId: notifications.projectId,
      ticketId: notifications.ticketId,
      jobId: notifications.jobId,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      snoozedUntil: notifications.snoozedUntil,
      handledAt: notifications.handledAt,
      handledByUserId: notifications.handledByUserId,
      // `::text` preserva i microsecondi: il cursore deve poter puntare
      // esattamente alla riga letta.
      cursorTimestamp: sql<string>`${notifications.createdAt}::text`,
    })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    // Una riga in più del limite: se arriva, esiste una pagina successiva.
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ createdAt: last.cursorTimestamp, id: last.id })
      : null;

  const jobStatusByTicket = await latestJobStatusByTicket(
    db,
    page.map((r) => r.ticketId),
  );
  const handledByUser = await usersById(
    db,
    page.map((r) => r.handledByUserId),
  );

  const items = page.map((r): InboxItem => {
    const event = r.event as unknown as NotificationEvent;
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      text: formatNotificationText(event, lang),
      url: openUrl(event),
      actions: actionsFor(
        r,
        r.ticketId ? (jobStatusByTicket.get(r.ticketId) ?? null) : null,
        actor,
      ),
      projectId: r.projectId,
      ticketId: r.ticketId,
      jobId: r.jobId,
      createdAt: r.createdAt,
      readAt: r.readAt,
      snoozedUntil: r.snoozedUntil,
      handledAt: r.handledAt,
      handledBy: (r.handledByUserId && handledByUser.get(r.handledByUserId)) || null,
    };
  });

  return { items, nextCursor };
}

/**
 * Riporta a `open` gli snooze scaduti dell'utente. Idempotente e limitato alla
 * sua inbox: due richieste concorrenti fanno la stessa cosa, la seconda su zero
 * righe. `snoozed_until` va azzerato (fuori dallo stato `snoozed` non
 * significherebbe più nulla, e la scadenza vecchia confonderebbe la UI).
 */
async function reopenExpiredSnoozes(db: Db, userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "open", snoozedUntil: null })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.status, "snoozed"),
        sql`${notifications.snoozedUntil} <= now()`,
      ),
    );
}

/**
 * Stato dell'ultimo job per ciascun ticket del batch, in UNA query. I job di un
 * ticket sono pochissimi (il rilancio RIUSA la riga esistente invece di
 * accodarne una nuova), quindi si leggono ordinati e si tiene il primo per
 * ticket invece di pagare una `distinct on` per pagina.
 */
async function latestJobStatusByTicket(
  db: Db,
  ticketIds: (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(ticketIds.filter((id): id is string => id !== null))];
  const byTicket = new Map<string, string>();
  if (ids.length === 0) return byTicket;
  const rows = await db
    .select({ ticketId: aiJobs.ticketId, status: aiJobs.status })
    .from(aiJobs)
    .where(inArray(aiJobs.ticketId, ids))
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id));
  for (const row of rows) {
    if (!byTicket.has(row.ticketId)) byTicket.set(row.ticketId, row.status);
  }
  return byTicket;
}

/** Id → { id, email } per gli utenti del batch, in UNA query. */
async function usersById(db: Db, userIds: (string | null)[]): Promise<Map<string, HandledBy>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  const byId = new Map<string, HandledBy>();
  if (ids.length === 0) return byId;
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

/**
 * Quante notifiche l'utente ha ancora da smaltire: è il numero sulla campanella.
 *
 * DECISIONE: conta lo stato, non la lettura. `read_at` dice solo che l'utente ha
 * aperto la riga una volta, non che ha fatto ciò che chiedeva — un piano da
 * approvare letto e lasciato lì deve continuare a comparire. Il conteggio è
 * quindi "da smaltire": `open` più le snoozate GIÀ SCADUTE, che a un `listInbox`
 * successivo tornerebbero aperte comunque.
 *
 * NON scrive: la riapertura lazy è di `listInbox`. Così la campanella (polling
 * ogni 30 s da ogni scheda aperta) resta una lettura pura e dice comunque il
 * numero giusto.
 */
export async function unreadCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        sql`(${notifications.status} = 'open' or (${notifications.status} = 'snoozed' and ${notifications.snoozedUntil} <= now()))`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * Segna la notifica come letta, se non lo era già. Idempotente: `read_at` è il
 * momento della PRIMA apertura, quindi una seconda chiamata lo conserva.
 * Notifica inesistente o di un altro utente → `not_found`.
 */
export async function markRead(
  db: Db,
  args: { notificationId: string; userId: string },
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const updated = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.id, args.notificationId),
        eq(notifications.userId, args.userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  if (updated.length > 0) return { ok: true };

  // 0 righe: o la notifica non è sua (→ not_found), o era già letta (→ ok).
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, args.notificationId), eq(notifications.userId, args.userId)));
  return row ? { ok: true } : { ok: false, error: "not_found" };
}

// --- Cursore keyset ---
//
// Stessa forma delle liste esistenti (`routes/tickets.ts`, `routes/backlog.ts`):
// base64url di `createdAt|id`, ordinamento `(created_at, id)` DESC.

interface Cursor {
  createdAt: string;
  id: string;
}

/** Formato testuale di `timestamptz::text` di Postgres. */
const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;

/** Formato di un UUID (l'id della notifica nel cursore). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codifica il cursore opaco: base64url di `createdAt|id`. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** Decodifica e valida il cursore; `null` se malformato (il chiamante fa 400). */
function decodeCursor(raw: string): Cursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator === -1) return null;
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!CURSOR_TIMESTAMP_PATTERN.test(createdAt)) return null;
  if (!UUID_PATTERN.test(id)) return null;
  return { createdAt, id };
}
