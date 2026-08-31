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
 * DOVE VIVE IL CATALOGO (Task 9): `actionsFor` e i suoi predicati sono PURI e
 * non toccano il DB. Da quando il poller delle consegne compone i bottoni Block
 * Kit del DM Slack servono anche al worker — che NON può importare da
 * `apps/server` — quindi stanno in `@stubwise/notifications`
 * (`src/actions.ts`, coi loro test) e questo modulo li ri-esporta: gli import
 * dei suoi consumatori (rotte, test) restano validi.
 */
import { aiJobs, notifications, users, type Db } from "@stubwise/db";
import type { Language } from "@stubwise/i18n";
import {
  actionsFor,
  actorAllows,
  formatNotificationText,
  kindOffers,
  openUrl,
  stateAllows,
  type ActionId,
  type ActionableNotification,
  type NotificationEvent,
  type NotificationKind,
  type SnoozeUntil,
} from "@stubwise/notifications";
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { resolvePlan, startRun, type Actor } from "./jobs.js";
import { mirrorDecision, propagateDecision } from "./notifications-propagation.js";

// Catalogo delle azioni: implementazione in `@stubwise/notifications/actions`
// (condivisa col worker), ri-esportata qui per i consumatori del servizio.
export { actionsFor, openUrl };
export type { ActionId, ActionableNotification, SnoozeUntil };

/** Stato di una riga d'inbox (speculare all'enum DB `notification_status`). */
export type InboxStatus = "open" | "handled" | "snoozed";

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

/**
 * Esito di {@link executeAction}. Il ramo di successo porta abbastanza contesto
 * da permettere al chiamante di aggiornare le ALTRE superfici senza rileggere
 * nulla: il Task 10 deve ritoccare i DM Slack di tutte le copie chiuse (i loro
 * `ts` stanno in `notification_deliveries.external_ref`), e per farlo gli servono
 * il `kind`, la chiave `notificationJobId` e la lista delle righe toccate.
 */
export type ExecuteActionResult =
  | {
      ok: true;
      action: ActionId;
      /**
       * Kind della notifica su cui si è agito. Viene dalla COLONNA enum, non dal
       * jsonb `event`: è il dato di cui ci si può fidare.
       */
      kind: NotificationKind;
      /**
       * `notifications.job_id` della riga — la metà "job" della chiave di
       * propagazione. Distinto da `jobId`, che è l'id del job AI restituito dal
       * servizio: oggi coincidono (il rilancio riusa la riga del job) ma sono
       * due concetti diversi e un domani `startRun` potrebbe accodarne uno nuovo.
       */
      notificationJobId: string | null;
      /**
       * Righe d'inbox il cui stato è cambiato per effetto di questa azione: le
       * copie chiuse dalla propagazione, oppure la sola riga propria per le
       * azioni personali (snooze/handled). Vuoto se non ha cambiato nulla
       * (qualcuno ha chiuso tutto nel frattempo).
       */
      changedNotificationIds: string[];
      /** Id del job AI toccato da `resolvePlan`/`startRun`, se l'azione ne ha toccato uno. */
      jobId?: string;
      snoozedUntil?: Date;
    }
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
      // Chi ha chiesto il run dietro la notifica: è un permesso, non un dato di
      // visualizzazione (`answer` la può compiere lui oltre ai maintainer).
      // LEFT JOIN e non una query a parte: `notifications.job_id` è nullo sugli
      // eventi d'istanza, e una riga in più nella SELECT costa nulla.
      requestedByUserId: aiJobs.requestedByUserId,
    })
    .from(notifications)
    .leftJoin(aiJobs, eq(aiJobs.id, notifications.jobId))
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, actor.id)));
  if (!row) return { ok: false, error: "not_found" };

  if (action === "open") return { ok: false, error: "invalid_action" };

  // `answer` è già nel catalogo (la card e i DM la offrono a chi può
  // rispondere), ma la sua ESECUZIONE — validare la risposta contro la domanda
  // persistita, riprendere il job — vive in `answerQuestion`, che non esiste
  // ancora. Finché non c'è la si rifiuta qui, esplicitamente: lasciarla
  // scivolare nel ramo delle decisioni sul piano la manderebbe a `runDecision`,
  // che non saprebbe cosa farne.
  if (action === "answer") return { ok: false, error: "invalid_action" };

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
    const snoozedUntil = updated[0]!.snoozedUntil ?? undefined;
    // Il rinvio non "gestisce" nulla, ma il DM Slack della riga va comunque
    // ritoccato (i bottoni spariscono fino alla scadenza) — anche quando a
    // rinviare è stata l'inbox web, che di Slack non sa nulla.
    await mirrorDecision(db, {
      notificationIds: [row.id],
      action,
      actorId: actor.id,
      ...(snoozedUntil ? { snoozedUntil } : {}),
    });
    return {
      ok: true,
      action,
      kind: row.kind,
      notificationJobId: row.jobId,
      // Elenca le righe il cui STATO è cambiato: qui solo la propria.
      changedNotificationIds: [row.id],
      ...(snoozedUntil ? { snoozedUntil } : {}),
    };
  }

  if (action === "handled") {
    // L'archiviazione NON è offerta da tutti i kind: su una domanda dell'agente
    // il catalogo la nega (`archivable: false`), perché archiviarla lascerebbe
    // il job parcheggiato in `awaiting_input` senza che nessuno lo aspetti più.
    // È un invariante di COMPORTAMENTO, non di presentazione: va difeso qui —
    // dove l'archiviazione ha effetto — e non solo non disegnando il bottone,
    // altrimenti basterebbe una chiamata diretta alla rotta per aggirarlo.
    if (!kindOffers(row.kind, action)) return { ok: false, error: "invalid_action" };
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
    await mirrorDecision(db, { notificationIds: [row.id], action, actorId: actor.id });
    return {
      ok: true,
      action,
      kind: row.kind,
      notificationJobId: row.jobId,
      // Archiviazione personale: chiude SOLO la propria riga, mai le copie.
      changedNotificationIds: [row.id],
    };
  }

  // --- Azioni decisionali ---

  // Azione fuori dal catalogo del kind (`approve_plan` su un `job.failed`): non
  // è un permesso mancante, è una richiesta senza senso.
  if (!kindOffers(row.kind, action)) return { ok: false, error: "invalid_action" };
  if (!actorAllows({ kind: row.kind, requestedByUserId: row.requestedByUserId }, action, actor)) {
    return { ok: false, error: "forbidden" };
  }
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
    // job è semplicemente andato avanti, oppure qualcuno ha appena deciso da
    // un'altra superficie — la pagina ticket, un altro DM — e la propagazione di
    // `resolvePlan` ci ha già chiuso la riga. Si guarda la riga per rispondere
    // la verità.
    if (outcome.error === "plan_not_pending") {
      const handled = await handledByOf(db, row.id);
      if (handled) return { ok: false, error: "already_handled", handledBy: handled };
    }
    return outcome;
  }

  // Approve/reject: la chiusura delle copie e il rispecchiamento Slack li ha
  // già fatti `resolvePlan` — è lì che devono stare, perché li ottenga anche chi
  // decide dalla pagina ticket. Qui si riferiscono soltanto.
  // Relaunch: `startRun` NON propaga (non decide nulla, crea o riprende un run),
  // quindi la chiusura delle copie resta compito nostro.
  const changedNotificationIds =
    outcome.changedNotificationIds ??
    (await propagateDecision(db, {
      target: row.jobId ? { jobId: row.jobId, kind: row.kind } : { notificationId: row.id },
      action,
      actorId: actor.id,
    }));
  // Rete di sicurezza: `resolvePlan` chiude per (job risolto, kind), quindi una
  // riga senza `job_id` — anomala, ma il tipo la ammette — resterebbe aperta
  // sotto gli occhi di chi ha appena deciso. Nel caso normale la propria riga è
  // già nell'elenco e non si esegue nulla.
  if (!changedNotificationIds.includes(row.id)) {
    changedNotificationIds.push(
      ...(await propagateDecision(db, {
        target: { notificationId: row.id },
        action,
        actorId: actor.id,
      })),
    );
  }
  return {
    ok: true,
    action,
    kind: row.kind,
    notificationJobId: row.jobId,
    changedNotificationIds,
    jobId: outcome.jobId,
  };
}

/** Esegue l'azione decisionale sul servizio dei job e ne normalizza l'esito. */
async function runDecision(
  db: Db,
  ticketId: string,
  action: "approve_plan" | "reject_plan" | "relaunch",
  input: ExecuteActionInput,
): Promise<
  | {
      ok: true;
      jobId: string;
      /**
       * Righe già chiuse dal servizio dei job. Presente SOLO per approve/reject
       * (`resolvePlan` propaga); assente per il relaunch, che lascia la
       * propagazione al chiamante.
       */
      changedNotificationIds?: string[];
    }
  | { ok: false; error: ExecuteActionError; jobStatus?: string }
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
  if (result.ok) {
    // `resolvePlan` ha già chiuso le copie e accodato gli aggiornamenti Slack:
    // gli id risalgono al chiamante perché li riferisca, non perché li rifaccia.
    return {
      ok: true,
      jobId: result.jobId,
      changedNotificationIds: result.changedNotificationIds,
    };
  }
  return {
    ok: false,
    error: result.error === "ticket_not_found" ? "not_found" : result.error,
  };
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
  /**
   * Frase localizzata senza markup, dalla stessa fonte dei webhook. Se il
   * payload `event` è irrecuperabile ripiega sul `kind`: vedi {@link renderItem}.
   */
  text: string;
  /**
   * Dove porta l'azione `open`. ASSENTE se il payload non contiene un URL
   * utilizzabile: la UI mostra la card senza il link invece di portare l'utente
   * su `undefined`.
   */
  url?: string;
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

  const { latestStatusByTicket, requesterByJob } = await jobsOfTickets(
    db,
    page.map((r) => r.ticketId),
  );
  const handledByUser = await usersById(
    db,
    page.map((r) => r.handledByUserId),
  );

  const items = page.map((r): InboxItem => {
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      // La resa dal jsonb è l'unica parte che può esplodere: sta dentro il suo
      // recinto (vedi `renderItem`).
      ...renderItem(r.event, r.kind, lang),
      // Le azioni NON passano dal jsonb: la chiave del catalogo è la colonna
      // enum `kind`, che il DB garantisce valida. Una card col testo degradato
      // resta quindi azionabile.
      actions: actionsFor(
        {
          kind: r.kind,
          // Il richiedente è quello del job DELLA NOTIFICA (chi ha avviato il
          // run che ha posto la domanda), non quello dell'ultimo job del
          // ticket: è a lui che la domanda è rivolta.
          requestedByUserId: r.jobId ? (requesterByJob.get(r.jobId) ?? null) : null,
        },
        r.ticketId ? (latestStatusByTicket.get(r.ticketId) ?? null) : null,
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
 * RECINTO attorno alla resa del singolo item.
 *
 * `notifications.event` è un jsonb scritto da chi ha pubblicato l'evento, anche
 * mesi fa e da una versione precedente del codice: il cast a `NotificationEvent`
 * è una promessa che il DB non fa rispettare (nessun CHECK sulla forma del
 * payload). Un `kind` che non esiste più, un campo url sparito, un `limitUsd`
 * arrivato come stringa fanno lanciare `formatNotificationText`/`openUrl` — e
 * senza recinto UNA riga marcia manderebbe in 500 la lista INTERA, cioè
 * l'inbox dell'utente diventerebbe inaccessibile finché qualcuno non va a
 * pulire il DB a mano.
 *
 * Qui la riga degrada e basta: `text` ripiega sul `kind` (la colonna enum, di
 * cui ci si può fidare) e `url` viene omesso. La card resta visibile e — visto
 * che le azioni si calcolano dalla colonna, non dal jsonb — resta anche
 * azionabile: si può approvare un piano di cui non sappiamo più scrivere il
 * titolo.
 *
 * Non è solo un try/catch: un payload malformato può anche NON lanciare e
 * restituire `undefined` (`openUrl` su un kind sconosciuto esce dallo switch),
 * quindi l'esito viene comunque validato prima di uscire.
 */
function renderItem(
  rawEvent: Record<string, unknown>,
  kind: NotificationKind,
  lang: Language,
): { text: string; url?: string } {
  try {
    const event = rawEvent as unknown as NotificationEvent;
    const text = formatNotificationText(event, lang);
    const url: unknown = openUrl(event);
    return {
      text: typeof text === "string" && text.trim() !== "" ? text : kind,
      ...(typeof url === "string" && url !== "" ? { url } : {}),
    };
  } catch {
    return { text: kind };
  }
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
 * I job dei ticket del batch, in UNA query, nei due tagli che servono al
 * catalogo delle azioni:
 *
 *  - `latestStatusByTicket` — lo stato dell'ULTIMO job del ticket, che decide
 *    quali azioni lo stato ammette (`stateAllows`);
 *  - `requesterByJob` — il richiedente di CIASCUN job, che decide chi può
 *    rispondere alla domanda posta da quel job (`actorAllows` su `answer`).
 *
 * Due mappe da una sola query, e non due query: il job di una notifica è per
 * forza uno dei job del suo ticket, quindi le righe lette qui li contengono già
 * tutti. I job di un ticket sono pochissimi (il rilancio RIUSA la riga esistente
 * invece di accodarne una nuova), quindi si leggono ordinati e si tiene il primo
 * per ticket invece di pagare una `distinct on` per pagina.
 */
async function jobsOfTickets(
  db: Db,
  ticketIds: (string | null)[],
): Promise<{
  latestStatusByTicket: Map<string, string>;
  requesterByJob: Map<string, string | null>;
}> {
  const ids = [...new Set(ticketIds.filter((id): id is string => id !== null))];
  const latestStatusByTicket = new Map<string, string>();
  const requesterByJob = new Map<string, string | null>();
  if (ids.length === 0) return { latestStatusByTicket, requesterByJob };
  const rows = await db
    .select({
      id: aiJobs.id,
      ticketId: aiJobs.ticketId,
      status: aiJobs.status,
      requestedByUserId: aiJobs.requestedByUserId,
    })
    .from(aiJobs)
    .where(inArray(aiJobs.ticketId, ids))
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id));
  for (const row of rows) {
    if (!latestStatusByTicket.has(row.ticketId)) latestStatusByTicket.set(row.ticketId, row.status);
    requesterByJob.set(row.id, row.requestedByUserId);
  }
  return { latestStatusByTicket, requesterByJob };
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
 *
 * `changedNotificationIds` è vuoto quando la riga era GIÀ letta: come per
 * {@link executeAction}, elenca le righe il cui stato è cambiato davvero, così
 * il chiamante sa se c'è qualcosa da rispecchiare altrove.
 */
export async function markRead(
  db: Db,
  args: { notificationId: string; userId: string },
): Promise<{ ok: true; changedNotificationIds: string[] } | { ok: false; error: "not_found" }> {
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
  if (updated.length > 0) return { ok: true, changedNotificationIds: [updated[0]!.id] };

  // 0 righe: o la notifica non è sua (→ not_found), o era già letta (→ ok).
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, args.notificationId), eq(notifications.userId, args.userId)));
  return row ? { ok: true, changedNotificationIds: [] } : { ok: false, error: "not_found" };
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
