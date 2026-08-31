import {
  aiJobs,
  notificationDeliveries,
  notifications,
  projectFollows,
  tickets,
  users,
} from "@stubwise/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { loadSettings, shouldSendWebhook, type DbOrTx } from "./dispatch.js";
import type { NotificationEvent } from "./format.js";
import { audienceFor, recipientsFor, type RoutingContext } from "./routing.js";

/**
 * PUBBLICAZIONE di una notifica: il punto d'ingresso unico della Fase 0.
 *
 * Scrive due cose e non parla con l'esterno:
 *  - l'INBOX (`notifications`): una riga per destinatario, con l'evento intero
 *    dentro, così la UI può renderla senza risalire a ticket e job;
 *  - l'OUTBOX (`notification_deliveries`): una riga per (evento, canale). Il
 *    DM Slack è per DESTINATARIO (legato alla sua notifica), il webhook
 *    d'istanza è per EVENTO (nessuna notifica dietro, evento copiato sulla
 *    riga) — la forma è imposta anche dai CHECK della tabella.
 *
 * L'INVIO è del poller nel worker: qui non si fa I/O di rete, così pubblicare
 * una notifica costa quanto un paio di insert e può stare dentro la
 * transazione del chiamante.
 */

/** Ancore verso l'entità di origine, note al chiamante. */
export interface PublishOpts {
  /** Progetto dell'evento: instrada verso chi lo segue. */
  projectId?: string;
  /** Ticket dell'evento: instrada verso l'assegnatario. */
  ticketId?: string;
  /** Job dell'evento: instrada verso l'operatore che l'ha lanciato. */
  jobId?: string;
}

/**
 * Pubblica l'evento: calcola i destinatari, riempie inbox e outbox.
 *
 * `db` può essere una TRANSAZIONE: se il chiamante ne ha una aperta (es. il
 * server che crea un ticket) passa il suo `tx` e la notifica nasce o non nasce
 * insieme all'entità che la genera.
 *
 * `opts` è OBBLIGATORIO, anche quando è `{}`: le ancore sono la parte che si
 * dimentica per prima e senza di loro l'evento raggiunge i soli admin senza che
 * nulla lo segnali. Un parametro esplicito costringe ogni punto di emissione a
 * dichiarare cosa sa dell'origine dell'evento.
 *
 * NON LANCIA MAI: come {@link dispatchNotification}, una notifica mancata non
 * deve far fallire l'ingestion né un job — su errore restituisce
 * `{ published: 0 }`.
 *
 * Per poterlo garantire davvero il corpo gira in una transazione ANNIDATA:
 *  - su un `Db` è una transazione vera, quindi inbox e outbox sono atomiche (mai
 *    le notifiche senza le consegne);
 *  - su un `tx` del chiamante drizzle emette un SAVEPOINT, così un errore SQL
 *    qui dentro rientra fin lì e NON aborta la transazione del chiamante (che
 *    altrimenti si vedrebbe "current transaction is aborted" alla statement
 *    successiva, cioè esattamente la rottura che l'inghiottimento vorrebbe
 *    evitare).
 *
 * @returns quante righe di inbox sono state scritte (destinatari raggiunti).
 */
export async function publishNotification(
  db: DbOrTx,
  event: NotificationEvent,
  opts: PublishOpts,
): Promise<{ published: number }> {
  try {
    return await db.transaction(async (inner) => {
      const ctx = await resolveRoutingContext(inner, event, opts);
      const recipients = recipientsFor(event, ctx);

      const settings = await loadSettings(inner);
      const withWebhook = shouldSendWebhook(settings, event.kind);
      if (recipients.length === 0 && !withWebhook) return { published: 0 };

      // Le colonne jsonb sono tipizzate `Record<string, unknown>` perché `db`
      // non può importare l'unione da qui (sarebbe un ciclo): il cast è il punto
      // in cui il tipo forte entra nel jsonb, e i consumatori lo rifanno
      // all'inverso.
      const payload = event as unknown as Record<string, unknown>;

      // Inbox: una riga per destinatario, tutte insieme.
      const inserted =
        recipients.length > 0
          ? await inner
              .insert(notifications)
              .values(
                recipients.map((userId) => ({
                  userId,
                  projectId: opts.projectId ?? null,
                  ticketId: opts.ticketId ?? null,
                  jobId: opts.jobId ?? null,
                  kind: event.kind,
                  event: payload,
                  status: "open" as const,
                })),
              )
              .returning({ id: notifications.id, userId: notifications.userId })
          : [];

      // Outbox. Le consegne `slack_dm` vanno solo a chi ha un'identità Slack e
      // non ha spento i DM: chi non ce l'ha non genera riga (lo stato `skipped`
      // è del poller, per il bot non configurato al momento dell'invio).
      const slackReady = await slackRecipients(inner, recipients);
      const deliveries: (typeof notificationDeliveries.$inferInsert)[] = inserted
        .filter((row) => slackReady.has(row.userId))
        .map((row) => ({ notificationId: row.id, channel: "slack_dm" as const }));
      if (withWebhook) {
        deliveries.push({
          channel: "webhook" as const,
          event: payload,
        });
      }
      if (deliveries.length > 0) {
        await inner.insert(notificationDeliveries).values(deliveries);
      }

      return { published: inserted.length };
    });
  } catch {
    // Inghiottito di proposito: vedi docblock della funzione. Il rollback della
    // transazione annidata ha già rimesso a posto le eventuali scritture
    // parziali.
    return { published: 0 };
  }
}

/**
 * Risolve in id utente il contesto che serve al routing, leggendo SOLO ciò che
 * il pubblico del kind userà davvero: per i kind ai soli admin si ferma agli
 * admin, per quelli rivolti al richiedente aggiunge la sola query sul job.
 * Sono query in meno per notifica, non un'ottimizzazione prematura: `publish`
 * gira dentro la transazione di chi emette l'evento.
 */
async function resolveRoutingContext(
  db: DbOrTx,
  event: NotificationEvent,
  opts: PublishOpts,
): Promise<RoutingContext> {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .then((rows) => rows.map((row) => row.id));

  // Switch e non if-chain: come in `recipientsFor`, un pubblico nuovo non
  // compila finché non gli si dice quali letture servono — cadere di default
  // nel ramo `broadcast` significherebbe perdere in silenzio l'unica ragione
  // d'essere di questa funzione.
  switch (audienceFor(event.kind)) {
    case "admins":
      return { admins, followers: [] };
    case "requester":
      // Bastano gli admin e chi ha lanciato il job: le query su follower e
      // ticket non cambierebbero l'esito, quindi non si fanno.
      return { admins, followers: [], requestedBy: await resolveRequestedBy(db, opts.jobId) };
    case "broadcast":
      return await resolveBroadcastContext(db, admins, opts);
  }
}

/**
 * Contesto COMPLETO del pubblico `broadcast`: oltre agli admin servono i
 * follower del progetto e le persone del ticket.
 */
async function resolveBroadcastContext(
  db: DbOrTx,
  admins: string[],
  opts: PublishOpts,
): Promise<RoutingContext> {
  const followers = opts.projectId
    ? await db
        .select({ userId: projectFollows.userId })
        .from(projectFollows)
        .where(eq(projectFollows.projectId, opts.projectId))
        .then((rows) => rows.map((row) => row.userId))
    : [];

  const requestedBy = await resolveRequestedBy(db, opts.jobId);

  // `reporter` non ha ancora una colonna in `tickets` (i ticket nascono da
  // ingestion/widget/Slack, senza autore interno): il routing lo prevede, qui
  // resta non risolto finché lo schema non lo espone.
  const assignee = opts.ticketId
    ? await db
        .select({ assigneeId: tickets.assigneeId })
        .from(tickets)
        .where(eq(tickets.id, opts.ticketId))
        .then((rows) => rows[0]?.assigneeId ?? undefined)
    : undefined;

  return { admins, followers, requestedBy, assignee };
}

/**
 * Operatore che ha lanciato il job (`ai_jobs.requested_by_user_id`), se il
 * chiamante ha dichiarato il job d'origine. Estratta perché la usano due
 * pubblici diversi (`broadcast` e `requester`).
 */
async function resolveRequestedBy(db: DbOrTx, jobId?: string): Promise<string | undefined> {
  if (!jobId) return undefined;
  return await db
    .select({ userId: aiJobs.requestedByUserId })
    .from(aiJobs)
    .where(eq(aiJobs.id, jobId))
    .then((rows) => rows[0]?.userId ?? undefined);
}

/**
 * Sottoinsieme dei destinatari raggiungibili via DM Slack (identità Slack
 * presente e preferenza attiva). UNA query per tutti, non una per destinatario.
 */
async function slackRecipients(db: DbOrTx, recipients: string[]): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, recipients),
        isNotNull(users.slackUserId),
        eq(users.notifySlackDm, true),
      ),
    );
  return new Set(rows.map((row) => row.id));
}
