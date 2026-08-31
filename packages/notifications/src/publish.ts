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
import { isAdminOnlyKind, recipientsFor, type RoutingContext } from "./routing.js";

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
 * NON LANCIA MAI: come {@link dispatchNotification}, una notifica mancata non
 * deve far fallire l'ingestion né un job — su errore restituisce
 * `{ published: 0 }`. Attenzione: dentro una transazione un errore qui lascia
 * comunque la transazione abortita lato Postgres, quindi è il chiamante a
 * decidere cosa farne.
 *
 * @returns quante righe di inbox sono state scritte (destinatari raggiunti).
 */
export async function publishNotification(
  db: DbOrTx,
  event: NotificationEvent,
  opts: PublishOpts = {},
): Promise<{ published: number }> {
  try {
    const ctx = await resolveRoutingContext(db, event, opts);
    const recipients = recipientsFor(event, ctx);

    const settings = await loadSettings(db);
    const withWebhook = shouldSendWebhook(settings, event.kind);
    if (recipients.length === 0 && !withWebhook) return { published: 0 };

    // Le colonne jsonb sono tipizzate `Record<string, unknown>` perché `db` non
    // può importare l'unione da qui (sarebbe un ciclo): il cast è il punto in
    // cui il tipo forte entra nel jsonb, e i consumatori lo rifanno all'inverso.
    const payload = event as unknown as Record<string, unknown>;

    // Inbox: una riga per destinatario, tutte insieme.
    const inserted =
      recipients.length > 0
        ? await db
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
    const slackReady = await slackRecipients(db, recipients);
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
      await db.insert(notificationDeliveries).values(deliveries);
    }

    return { published: inserted.length };
  } catch {
    // Inghiottito di proposito: vedi docblock della funzione.
    return { published: 0 };
  }
}

/**
 * Risolve in id utente il contesto che serve al routing. Per i kind destinati
 * ai SOLI admin si ferma agli admin: follower, ticket e job non cambierebbero
 * l'esito, e sono tre query in meno per notifica.
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

  if (isAdminOnlyKind(event.kind)) return { admins, followers: [] };

  const followers = opts.projectId
    ? await db
        .select({ userId: projectFollows.userId })
        .from(projectFollows)
        .where(eq(projectFollows.projectId, opts.projectId))
        .then((rows) => rows.map((row) => row.userId))
    : [];

  const requestedBy = opts.jobId
    ? await db
        .select({ userId: aiJobs.requestedByUserId })
        .from(aiJobs)
        .where(eq(aiJobs.id, opts.jobId))
        .then((rows) => rows[0]?.userId ?? undefined)
    : undefined;

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
