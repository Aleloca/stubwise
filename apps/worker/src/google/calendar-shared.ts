import { randomUUID } from "node:crypto";
import {
  calendarEvents as calendarEventsTable,
  calendarProposalRecipients,
  calendarProposals,
  googleAccounts,
  notifications,
  projectAccess,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import type { Language } from "@stubwise/i18n";
import { normalizeAddress, permissionForProposalAction, projectPermissionsOfUser, publishNotification } from "@stubwise/notifications";
import { hasDeclinedInvitation } from "@stubwise/shared";
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { getContentLanguage } from "../settings.js";
import { buildCalendarChooseEvent, buildCalendarProposalEvent, calendarDayUrl, googleProposalEventSchema } from "./proposal.js";

/**
 * LE PROPOSTE DEL CALENDARIO CONDIVISE FRA GLI INVITATI (lotto 9, voce 2 (d);
 * contratto §4 di `docs/plans/2026-11-24-rimandi-lotto8-contratti.md`).
 *
 * Un appuntamento SINGOLO (`recurring_event_id` nullo) non è più una proposta
 * per casella: è UNA proposta per (evento, progetto), `calendar_proposals`,
 * con l'evento riconosciuto fra le caselle dal suo `ical_uid` (le copie dello
 * stesso appuntamento nei calendari degli invitati sono un evento solo — la
 * riunione è la richiesta, come «UNA PROPOSTA PER RICHIESTA» per la posta).
 * La prima casella il cui giro trova il candidato la crea (`ON CONFLICT` sulla
 * chiave unica); le copie delle altre caselle ci si LEGANO
 * (`calendar_events.calendar_proposal_id`, il marcatore che toglie la riga dal
 * percorso per casella) e non creano né un'altra proposta né un'altra card per
 * lo stesso destinatario (la chiave primaria dei destinatari).
 *
 * Le occorrenze delle SERIE restano per casella, com'erano: `calendar_series`
 * è per casella, con la sua azione automatica (`runProposePhase` in
 * `poller.ts`).
 *
 * **Chi la riceve** (audience `event_invitees`, {@link eventInviteeIds}): gli
 * invitati che sono persone di Stubwise, che NON hanno rifiutato
 * (`hasDeclinedInvitation`) e sono membri ESPLICITI del progetto (una riga
 * `project_access`: anche di workspace, D17), più il proprietario della casella in cui l'evento è
 * stato trovato, trattato come un invitato che ha accettato (la casella
 * dell'organizzatore). Non include MAI gli admin in quanto tali: l'appartenenza
 * implicita di un full admin non conta, e non c'è un ramo `if (admin)`. Il
 * calendario collegato non serve: basta essere invitati.
 *
 * Ogni destinatario ha la SUA card `google.proposal`, consegnata con
 * l'audience `mailbox_owner` un destinatario alla volta (come le condivise
 * della posta, `publish-shared.ts`): vuol dire «solo questa persona, mai gli
 * admin». Tutte le card portano lo stesso `proposalId` (`calendar_proposals.id`):
 * è la chiave del claim con cui il primo che decide le chiude tutte.
 */

/** La chiave che riconosce lo stesso appuntamento fra le caselle. */
export function calendarShareKeySql(): SQL<string> {
  return sql<string>`coalesce(${calendarEventsTable.icalUid}, 'gcal:' || ${calendarEventsTable.googleEventId})`;
}

/** La stessa chiave, in memoria: un evento senza `iCalUID` si riconosce dal suo id di Google. */
export function calendarShareKey(row: { icalUid: string | null; googleEventId: string }): string {
  return row.icalUid ?? `gcal:${row.googleEventId}`;
}

type Attendee = { email: string; responseStatus: string | null };
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * I DESTINATARI di una proposta condivisa del calendario (audience
 * `event_invitees`): gli invitati di Stubwise che non hanno rifiutato, più il
 * proprietario della casella (un invitato che ha accettato), ristretti ai
 * membri ESPLICITI del progetto. Una persona con più indirizzi (email di
 * Stubwise, caselle collegate) che ha rifiutato con UNO di loro è fuori.
 */
export async function eventInviteeIds(
  db: DbOrTx,
  input: { attendees: readonly Attendee[]; mailboxOwnerUserId: string | null; projectId: string },
): Promise<string[]> {
  return inviteesOfAny(db, { attendees: input.attendees, mailboxOwnerUserId: input.mailboxOwnerUserId, projectIds: [input.projectId] });
}

/**
 * Lotto 9, voce 2 (a): la stessa regola per la «Quale progetto?», dove il
 * progetto non c'è ancora: gli altri invitati entrano se sono membri ESPLICITI
 * di ALMENO UNO dei candidati. Il titolare della casella, come sopra.
 */
async function inviteesOfAny(
  db: DbOrTx,
  input: { attendees: readonly Attendee[]; mailboxOwnerUserId: string | null; projectIds: readonly string[] },
): Promise<string[]> {
  const byAddress = await peopleByAddress(db, input.attendees.map((a) => a.email));
  const accepted = new Set<string>();
  const declined = new Set<string>();
  for (const attendee of input.attendees) {
    const userId = byAddress.get(normalizeAddress(attendee.email));
    if (!userId) continue;
    // La regola di `hasDeclinedInvitation`, l'unico posto in cui «quali risposte bloccano» è scritto.
    if (hasDeclinedInvitation([attendee], attendee.email)) declined.add(userId);
    else accepted.add(userId);
  }
  // Il TITOLARE della casella in cui è arrivato l'evento riceve SEMPRE la sua
  // card (`mailbox_owner`, com'era: correzione di 46), anche se non è membro
  // esplicito; se non può confermare nel progetto, vale la regola di sempre.
  // Il filtro dei membri ESPLICITI vale per gli ALTRI invitati.
  const owner = input.mailboxOwnerUserId && !declined.has(input.mailboxOwnerUserId) ? input.mailboxOwnerUserId : null;
  const candidates = [...accepted].filter((id) => !declined.has(id) && id !== owner);
  if (candidates.length === 0) return owner ? [owner] : [];
  // Membri ESPLICITI o di workspace (`project_access`, 0239, D17), mai
  // `projectViewerIds` (che aggiunge i full admin impliciti).
  const members = await db
    .selectDistinct({ userId: projectAccess.userId })
    .from(projectAccess)
    .innerJoin(users, eq(users.id, projectAccess.userId))
    .where(and(inArray(projectAccess.projectId, [...input.projectIds]), inArray(projectAccess.userId, candidates), eq(users.isAgent, false)));
  const memberIds = new Set(members.map((m) => m.userId));
  return [...candidates.filter((id) => memberIds.has(id)), ...(owner ? [owner] : [])].sort();
}

/** Da indirizzo (normalizzato) a persona: l'email di Stubwise o una casella collegata, mai un agente. */
async function peopleByAddress(db: DbOrTx, addresses: readonly string[]): Promise<Map<string, string>> {
  const all = [...new Set(addresses.map((a) => normalizeAddress(a)).filter((a) => a.includes("@")))];
  const out = new Map<string, string>();
  if (all.length === 0) return out;
  // `lower()`: un indirizzo salvato con le maiuscole è la stessa persona (come `attendeeProjectsByEvent`).
  const lowered = sql`array[${sql.join(all.map((a) => sql`${a}`), sql`, `)}]::text[]`;
  for (const row of await db.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.isAgent, false), sql`lower(${users.email}) = any(${lowered})`))) {
    out.set(normalizeAddress(row.email), row.id);
  }
  for (const row of await db
    .select({ id: googleAccounts.userId, email: googleAccounts.email })
    .from(googleAccounts)
    .innerJoin(users, eq(users.id, googleAccounts.userId))
    .where(and(eq(users.isAgent, false), sql`lower(${googleAccounts.email}) = any(${lowered})`))) {
    out.set(normalizeAddress(row.email), row.id);
  }
  return out;
}

export interface SharedCalendarDeps {
  db: Db;
  lang?: Language;
  publish?: typeof publishNotification;
  now?: () => Date;
  limit?: number;
  logger?: { info(line: string): void; warn(line: string): void };
}

/**
 * La pubblicazione per UNA casella: i suoi eventi singoli pronti e non ancora
 * legati diventano (o si legano a) la proposta condivisa del loro
 * appuntamento. Le stesse condizioni della `where` del percorso per casella
 * (`runProposePhase`) per il timing, il progetto e il RIFIUTO di chi ha la
 * casella: le DEVONO restare d'accordo, e il cancello vero resta
 * `isReadyForProposal`, riapplicato da `buildCalendarProposalEvent`.
 */
export async function publishSharedCalendarProposals(
  deps: SharedCalendarDeps,
  account: { id: string; userId: string; email: string },
): Promise<number> {
  const db = deps.db;
  const now = deps.now ? deps.now() : new Date();
  const rows = await db
    .select({
      id: calendarEventsTable.id,
      googleEventId: calendarEventsTable.googleEventId,
      icalUid: calendarEventsTable.icalUid,
      title: calendarEventsTable.title,
      startsAt: calendarEventsTable.startsAt,
      allDay: calendarEventsTable.allDay,
      organizer: calendarEventsTable.organizer,
      status: calendarEventsTable.status,
      projectId: calendarEventsTable.projectId,
      proposalNotificationId: calendarEventsTable.proposalNotificationId,
      outcome: calendarEventsTable.outcome,
      recurringEventId: calendarEventsTable.recurringEventId,
      attendees: calendarEventsTable.attendees,
    })
    .from(calendarEventsTable)
    .where(
      and(
        eq(calendarEventsTable.accountId, account.id),
        sql`exists (select 1 from ${googleAccounts} where ${googleAccounts.id} = ${calendarEventsTable.accountId} and ${googleAccounts.proposalsEnabled})`,
        eq(calendarEventsTable.proposalCandidate, true),
        sql`${calendarEventsTable.status} is distinct from 'cancelled'`,
        // SOLO gli eventi singoli: le serie restano per casella.
        isNull(calendarEventsTable.recurringEventId),
        isNull(calendarEventsTable.calendarProposalId),
        isNull(calendarEventsTable.proposalNotificationId),
        isNull(calendarEventsTable.outcome),
        isNotNull(calendarEventsTable.projectId),
        sql`${calendarEventsTable.startsAt} >= ${now.toISOString()}::timestamptz`,
        // Il RIFIUTO di chi ha la casella, come nella `where` del percorso per casella.
        sql`not exists (
          select 1
          from jsonb_array_elements(
            case when jsonb_typeof(${calendarEventsTable.attendees}) = 'array'
                 then ${calendarEventsTable.attendees}
                 else '[]'::jsonb end
          ) as attendee
          where lower(attendee ->> 'email') = lower(${account.email})
            and attendee ->> 'responseStatus' = 'declined'
        )`,
      ),
    )
    .orderBy(asc(calendarEventsTable.startsAt), asc(calendarEventsTable.id))
    .limit(deps.limit ?? 20);
  if (rows.length === 0) return 0;

  const lang = deps.lang ?? (await getContentLanguage(db));
  const publish = deps.publish ?? publishNotification;
  const projectIds = [...new Set(rows.map((r) => r.projectId!))];
  const projectNames = new Map(
    (await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))).map((r) => [r.id, r.name]),
  );

  let published = 0;
  for (const row of rows) {
    // Il cancello vero (`isReadyForProposal`), con la casella di chi l'ha trovata.
    const probe = buildCalendarProposalEvent({ lang, event: row, mailboxEmail: account.email, projectNames });
    if (!probe) continue;
    const projectId = row.projectId!;
    const key = calendarShareKey(row);

    const cards = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(calendarProposals)
        .values({
          icalUid: key,
          projectId,
          calendarEventId: row.id,
          googleEventId: row.googleEventId,
          title: row.title,
          startsAt: row.startsAt,
          allDay: row.allDay,
        })
        .onConflictDoNothing({ target: [calendarProposals.icalUid, calendarProposals.projectId] })
        .returning({ id: calendarProposals.id, status: calendarProposals.status });
      const proposal =
        created ??
        (
          await tx
            .select({ id: calendarProposals.id, status: calendarProposals.status })
            .from(calendarProposals)
            .where(and(eq(calendarProposals.icalUid, key), eq(calendarProposals.projectId, projectId)))
            .for("update")
        )[0];
      if (!proposal) return 0;
      // Il marcatore: questa copia non passa più dal percorso per casella.
      await tx
        .update(calendarEventsTable)
        .set({ calendarProposalId: proposal.id })
        .where(and(eq(calendarEventsTable.id, row.id), isNull(calendarEventsTable.calendarProposalId)));
      // Una proposta già decisa: la copia si lega e basta.
      if (proposal.status !== "proposed") return 0;

      const recipients = await eventInviteeIds(tx, { attendees: row.attendees, mailboxOwnerUserId: account.userId, projectId });
      if (recipients.length === 0) {
        // Nessuno la vedrebbe: si chiude, come una condivisa della posta senza destinatari.
        if (created) {
          await tx
            .update(calendarProposals)
            .set({ status: "ignored", outcome: { type: "no_recipients" } })
            .where(and(eq(calendarProposals.id, proposal.id), eq(calendarProposals.status, "proposed")));
        }
        return 0;
      }

      // La copia dell'evento di ogni destinatario, se ce l'ha: la sua card porta alla SUA riga.
      const own = new Map<string, { id: string; email: string }>();
      for (const copy of await tx
        .select({ id: calendarEventsTable.id, email: googleAccounts.email, userId: googleAccounts.userId })
        .from(calendarEventsTable)
        .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEventsTable.accountId))
        .where(and(sql`${calendarShareKeySql()} = ${key}`, inArray(googleAccounts.userId, recipients)))
        .orderBy(asc(calendarEventsTable.createdAt))) {
        if (!own.has(copy.userId)) own.set(copy.userId, { id: copy.id, email: copy.email });
      }
      const emails = new Map(
        (await tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, recipients))).map((u) => [u.id, u.email]),
      );
      const base = buildCalendarProposalEvent({ lang, event: row, mailboxEmail: account.email, projectNames, proposalId: proposal.id });
      if (!base || !googleProposalEventSchema.safeParse(base).success) return 0;

      let sent = 0;
      for (const userId of recipients) {
        // La chiave primaria: una card sola per destinatario, qualunque copia la trovi.
        const [inserted] = await tx
          .insert(calendarProposalRecipients)
          .values({ proposalId: proposal.id, userId })
          .onConflictDoNothing()
          .returning({ userId: calendarProposalRecipients.userId });
        if (!inserted) continue;
        const mine = own.get(userId);
        // Il link e l'ancora dell'appuntamento sono della SUA copia: chi non
        // ha l'evento nel calendario non riceve l'id della riga di un altro.
        const event: typeof base = { ...base, messageUrl: calendarDayUrl(mine?.email ?? emails.get(userId) ?? account.email, row.startsAt) };
        if (mine) event.calendarEventId = mine.id;
        else delete event.calendarEventId;
        // Audience `mailbox_owner` con UN destinatario alla volta: «solo questa persona», mai gli admin.
        const { notificationIds } = await publish(tx, event, { mailboxOwnerUserId: userId, projectId });
        await tx
          .update(calendarProposalRecipients)
          .set({ notificationId: notificationIds[0] ?? null })
          .where(and(eq(calendarProposalRecipients.proposalId, proposal.id), eq(calendarProposalRecipients.userId, userId)));
        sent += 1;
      }
      return sent > 0 && created ? 1 : 0;
    });
    published += cards;
  }
  return published;
}

/**
 * IL RIFIUTO SOPRAVVENUTO (punto 5 della decisione): un destinatario che
 * rifiuta l'invito DOPO la pubblicazione si vede chiudere la SUA card e non
 * vede più la proposta (`declined_at`); nient'altro si tocca — la proposta
 * resta aperta per gli altri, e una già decisa non si tocca affatto. Gli
 * invitati si rileggono a ogni giro: dalle copie dell'evento legate alla
 * proposta (in qualunque casella), per le proposte legate a QUESTA casella.
 * Gira dopo il sync del calendario, anche a proposte spente (come la chiusura
 * per rifiuto delle proposte per casella, in `syncCalendar`).
 */
export async function closeDeclinedCalendarRecipients(
  deps: Pick<SharedCalendarDeps, "db" | "logger">,
  accountId: string,
): Promise<number> {
  const db = deps.db;
  const open = await db
    .selectDistinct({ proposalId: calendarProposals.id })
    .from(calendarEventsTable)
    .innerJoin(calendarProposals, eq(calendarProposals.id, calendarEventsTable.calendarProposalId))
    .where(and(eq(calendarEventsTable.accountId, accountId), eq(calendarProposals.status, "proposed")));
  let closed = 0;
  for (const { proposalId } of open) {
    const copies = await db
      .select({ attendees: calendarEventsTable.attendees })
      .from(calendarEventsTable)
      .where(eq(calendarEventsTable.calendarProposalId, proposalId));
    const declinedAddresses = new Set(
      copies.flatMap((c) => c.attendees.filter((a) => hasDeclinedInvitation([a], a.email)).map((a) => normalizeAddress(a.email))),
    );
    if (declinedAddresses.size === 0) continue;
    const byAddress = await peopleByAddress(db, [...declinedAddresses]);
    const declinedUsers = [...new Set(byAddress.values())];
    if (declinedUsers.length === 0) continue;
    await db.transaction(async (tx) => {
      const gone = await tx
        .update(calendarProposalRecipients)
        .set({ declinedAt: new Date() })
        .where(
          and(
            eq(calendarProposalRecipients.proposalId, proposalId),
            inArray(calendarProposalRecipients.userId, declinedUsers),
            isNull(calendarProposalRecipients.declinedAt),
          ),
        )
        .returning({ notificationId: calendarProposalRecipients.notificationId, userId: calendarProposalRecipients.userId });
      const ids = gone.flatMap((g) => (g.notificationId ? [g.notificationId] : []));
      if (ids.length > 0) {
        await tx
          .update(notifications)
          .set({ status: "handled", handledAt: new Date() })
          .where(and(inArray(notifications.id, ids), eq(notifications.status, "open")));
      }
      closed += gone.length;
      for (const g of gone) deps.logger?.info(`google: proposta condivisa del calendario ${proposalId} chiusa per ${g.userId} — invito rifiutato`);
    });
  }
  return closed;
}

/**
 * Una copia di una proposta CONDIVISA cancellata su Google (dentro la
 * transazione di `closeCancelledEvents`). Se non ne resta nessuna viva, la
 * riunione non c'è più: la proposta aperta si chiude per tutti
 * (`ignored`, `cancelled`), con tutte le card. Altrimenti l'evento è sparito
 * solo dal calendario di chi ha QUESTA casella: per lui vale come un rifiuto
 * (la sua card si chiude), gli altri la tengono.
 */
export async function closeCancelledSharedCalendarProposals(tx: DbOrTx, accountId: string, proposalIds: readonly string[]): Promise<void> {
  const [owner] = await tx.select({ userId: googleAccounts.userId }).from(googleAccounts).where(eq(googleAccounts.id, accountId));
  for (const proposalId of proposalIds) {
    // Una proposta già decisa non si tocca.
    const [proposal] = await tx.select({ status: calendarProposals.status }).from(calendarProposals).where(eq(calendarProposals.id, proposalId)).for("update");
    if (proposal?.status !== "proposed") continue;
    const alive = await tx
      .select({ id: calendarEventsTable.id })
      .from(calendarEventsTable)
      .where(and(eq(calendarEventsTable.calendarProposalId, proposalId), sql`${calendarEventsTable.status} is distinct from 'cancelled'`))
      .limit(1);
    let cards: (string | null)[];
    if (alive.length === 0) {
      const closed = await tx
        .update(calendarProposals)
        .set({ status: "ignored", outcome: { type: "cancelled" } })
        .where(and(eq(calendarProposals.id, proposalId), eq(calendarProposals.status, "proposed")))
        .returning({ id: calendarProposals.id });
      if (closed.length === 0) continue;
      cards = (await tx.select({ id: calendarProposalRecipients.notificationId }).from(calendarProposalRecipients).where(eq(calendarProposalRecipients.proposalId, proposalId))).map((r) => r.id);
    } else {
      if (!owner) continue;
      cards = (
        await tx
          .update(calendarProposalRecipients)
          .set({ declinedAt: new Date() })
          .where(and(eq(calendarProposalRecipients.proposalId, proposalId), eq(calendarProposalRecipients.userId, owner.userId), isNull(calendarProposalRecipients.declinedAt)))
          .returning({ id: calendarProposalRecipients.notificationId })
      ).map((r) => r.id);
    }
    const ids = cards.filter((id): id is string => id !== null);
    if (ids.length > 0) {
      await tx
        .update(notifications)
        .set({ status: "handled", handledAt: new Date() })
        .where(and(inArray(notifications.id, ids), eq(notifications.status, "open")));
    }
  }
}

/**
 * La potatura (come `pruneOldCalendarEvents`): una proposta condivisa ancora
 * aperta su un appuntamento uscito dalla finestra si chiude `expired`, con
 * tutte le sue card. Le righe `calendar_events` se ne vanno per conto loro: la
 * proposta non punta a una riga per esistere.
 */
export async function expireOldSharedCalendarProposals(db: Db, cutoff: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(calendarProposals)
      .set({ status: "ignored", outcome: { type: "expired" } })
      .where(and(eq(calendarProposals.status, "proposed"), sql`${calendarProposals.startsAt} < ${cutoff.toISOString()}::timestamptz`))
      .returning({ id: calendarProposals.id });
    if (expired.length === 0) return 0;
    const cards = await tx
      .select({ id: calendarProposalRecipients.notificationId })
      .from(calendarProposalRecipients)
      .where(inArray(calendarProposalRecipients.proposalId, expired.map((e) => e.id)));
    const ids = cards.flatMap((c) => (c.id ? [c.id] : []));
    if (ids.length > 0) {
      await tx
        .update(notifications)
        .set({ status: "handled", handledAt: new Date() })
        .where(and(inArray(notifications.id, ids), eq(notifications.status, "open")));
    }
    return expired.length;
  });
}

/**
 * LA «QUALE PROGETTO?» CONDIVISA DEL CALENDARIO (lotto 9, voce 2 (a)).
 *
 * Un evento SINGOLO con più progetti candidati su cui il modello non è sicuro
 * (o i cui tentativi sono finiti: `calendar-guess.ts`) diventa UNA proposta
 * senza progetto (`calendar_proposals.project_id` nullo, i candidati in
 * `candidate_project_ids`), una per appuntamento (indice unico parziale su
 * `ical_uid`). Le copie delle altre caselle ci si legano come per le proposte
 * di progetto, e i loro candidati si AGGIUNGONO a quelli della domanda finché
 * è aperta.
 *
 * **Chi la riceve**: il TITOLARE della casella (se non ha rifiutato) e gli
 * altri invitati di Stubwise che non hanno rifiutato e sono membri ESPLICITI
 * di ALMENO UNO dei candidati — mai un admin in quanto tale. Ognuno ha la SUA
 * card, con i soli candidati in cui può CONFERMARE la proposta che ne
 * nascerebbe (il permesso della milestone, `permissionForProposalAction`):
 * chi non ne ha nessuno non riceve una card con il solo «Non fare nulla».
 *
 * Decisa dal primo (il server, `chooseCalendarProposalProject`): le card di
 * tutti si chiudono e l'evento torna al percorso di PROGETTO
 * ({@link publishSharedCalendarProposals}), che fa nascere la proposta vera
 * con i suoi destinatari.
 */
export async function publishCalendarChooseProposals(
  deps: SharedCalendarDeps,
  account: { id: string; userId: string; email: string },
): Promise<number> {
  const db = deps.db;
  const now = deps.now ? deps.now() : new Date();
  const rows = await db
    .select({
      id: calendarEventsTable.id,
      googleEventId: calendarEventsTable.googleEventId,
      icalUid: calendarEventsTable.icalUid,
      title: calendarEventsTable.title,
      startsAt: calendarEventsTable.startsAt,
      allDay: calendarEventsTable.allDay,
      organizer: calendarEventsTable.organizer,
      status: calendarEventsTable.status,
      projectId: calendarEventsTable.projectId,
      proposalNotificationId: calendarEventsTable.proposalNotificationId,
      outcome: calendarEventsTable.outcome,
      recurringEventId: calendarEventsTable.recurringEventId,
      attendees: calendarEventsTable.attendees,
      projectGuess: calendarEventsTable.projectGuess,
    })
    .from(calendarEventsTable)
    .where(
      and(
        eq(calendarEventsTable.accountId, account.id),
        sql`exists (select 1 from ${googleAccounts} where ${googleAccounts.id} = ${calendarEventsTable.accountId} and ${googleAccounts.proposalsEnabled})`,
        eq(calendarEventsTable.proposalCandidate, true),
        sql`${calendarEventsTable.status} is distinct from 'cancelled'`,
        isNull(calendarEventsTable.recurringEventId),
        isNull(calendarEventsTable.calendarProposalId),
        isNull(calendarEventsTable.proposalNotificationId),
        isNull(calendarEventsTable.outcome),
        isNull(calendarEventsTable.projectId),
        // La scelta c'è ed è «non so» (o i tentativi sono finiti), con almeno due candidati.
        isNotNull(calendarEventsTable.projectGuess),
        sql`${calendarEventsTable.projectGuess} ->> 'projectId' is null`,
        sql`jsonb_typeof(${calendarEventsTable.projectGuess} -> 'candidates') = 'array'`,
        sql`jsonb_array_length(${calendarEventsTable.projectGuess} -> 'candidates') >= 2`,
        sql`${calendarEventsTable.startsAt} >= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(calendarEventsTable.startsAt), asc(calendarEventsTable.id))
    .limit(deps.limit ?? 20);
  if (rows.length === 0) return 0;

  const lang = deps.lang ?? (await getContentLanguage(db));
  const publish = deps.publish ?? publishNotification;
  // La proposta che nascerebbe è la milestone dell'evento: il permesso per confermarla.
  const needed = permissionForProposalAction("create_milestone");

  let published = 0;
  for (const row of rows) {
    const candidates = [...new Set(row.projectGuess?.candidates ?? [])].sort();
    if (candidates.length < 2) continue;
    const names = new Map(
      (await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, candidates))).map((r) => [r.id, r.name]),
    );
    // Il cancello vero, con la casella di chi l'ha trovata (come le proposte di progetto).
    const probe = buildCalendarChooseEvent({ lang, event: row, mailboxEmail: account.email, projectNames: names, proposalId: randomUUID(), choose: candidates });
    if (!probe) continue;
    const key = calendarShareKey(row);

    const cards = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(calendarProposals)
        .values({
          icalUid: key,
          projectId: null,
          candidateProjectIds: candidates,
          calendarEventId: row.id,
          googleEventId: row.googleEventId,
          title: row.title,
          startsAt: row.startsAt,
          allDay: row.allDay,
        })
        .onConflictDoNothing({ target: calendarProposals.icalUid, where: sql`project_id is null` })
        .returning({ id: calendarProposals.id, status: calendarProposals.status });
      const proposal =
        created ??
        (
          await tx
            .select({ id: calendarProposals.id, status: calendarProposals.status })
            .from(calendarProposals)
            .where(and(eq(calendarProposals.icalUid, key), isNull(calendarProposals.projectId)))
            .for("update")
        )[0];
      if (!proposal) return 0;
      await tx
        .update(calendarEventsTable)
        .set({ calendarProposalId: proposal.id })
        .where(and(eq(calendarEventsTable.id, row.id), isNull(calendarEventsTable.calendarProposalId)));
      if (proposal.status !== "proposed") return 0;
      // Un'altra casella può avere candidati diversi (il SUO titolare vede altri progetti): si sommano.
      if (!created) {
        await tx
          .update(calendarProposals)
          .set({ candidateProjectIds: sql`array(select distinct unnest(${calendarProposals.candidateProjectIds} || ${sql`array[${sql.join(candidates.map((c) => sql`${c}`), sql`, `)}]::uuid[]`}) order by 1)` })
          .where(eq(calendarProposals.id, proposal.id));
      }

      const invitees = await inviteesOfAny(tx, { attendees: row.attendees, mailboxOwnerUserId: account.userId, projectIds: candidates });
      // Per ognuno i candidati in cui può CONFERMARE: gli altri non gli si offrono.
      const choosable = new Map<string, string[]>();
      for (const userId of invitees) {
        const mine: string[] = [];
        for (const projectId of candidates) {
          if (!names.has(projectId)) continue;
          const permissions = await projectPermissionsOfUser(tx, userId, projectId);
          if (permissions && (!needed || permissions.has(needed))) mine.push(projectId);
        }
        if (mine.length > 0) choosable.set(userId, mine);
      }
      if (choosable.size === 0) {
        if (created) {
          await tx
            .update(calendarProposals)
            .set({ status: "ignored", outcome: { type: "no_recipients" } })
            .where(and(eq(calendarProposals.id, proposal.id), eq(calendarProposals.status, "proposed")));
        }
        return 0;
      }
      const recipients = [...choosable.keys()];
      const own = await ownCopies(tx, key, recipients);
      const emails = new Map(
        (await tx.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, recipients))).map((u) => [u.id, u.email]),
      );
      let sent = 0;
      for (const userId of recipients) {
        const [inserted] = await tx
          .insert(calendarProposalRecipients)
          .values({ proposalId: proposal.id, userId })
          .onConflictDoNothing()
          .returning({ userId: calendarProposalRecipients.userId });
        if (!inserted) continue;
        const mine = own.get(userId);
        const event = buildCalendarChooseEvent({
          lang,
          event: row,
          mailboxEmail: account.email,
          projectNames: names,
          proposalId: proposal.id,
          choose: choosable.get(userId)!,
        });
        if (!event || !googleProposalEventSchema.safeParse(event).success) continue;
        event.messageUrl = calendarDayUrl(mine?.email ?? emails.get(userId) ?? account.email, row.startsAt);
        if (mine) event.calendarEventId = mine.id;
        else delete event.calendarEventId;
        // Audience `mailbox_owner` con UN destinatario alla volta: «solo questa persona», mai gli admin.
        const { notificationIds } = await publish(tx, event, { mailboxOwnerUserId: userId, projectId: choosable.get(userId)![0]! });
        await tx
          .update(calendarProposalRecipients)
          .set({ notificationId: notificationIds[0] ?? null })
          .where(and(eq(calendarProposalRecipients.proposalId, proposal.id), eq(calendarProposalRecipients.userId, userId)));
        sent += 1;
      }
      return sent > 0 && created ? 1 : 0;
    });
    published += cards;
  }
  return published;
}

/** La copia dell'evento di ogni destinatario, se ce l'ha: la sua card porta alla SUA riga. */
async function ownCopies(tx: DbOrTx, key: string, recipients: readonly string[]): Promise<Map<string, { id: string; email: string }>> {
  const own = new Map<string, { id: string; email: string }>();
  for (const copy of await tx
    .select({ id: calendarEventsTable.id, email: googleAccounts.email, userId: googleAccounts.userId })
    .from(calendarEventsTable)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEventsTable.accountId))
    .where(and(sql`${calendarShareKeySql()} = ${key}`, inArray(googleAccounts.userId, [...recipients])))
    .orderBy(asc(calendarEventsTable.createdAt))) {
    if (!own.has(copy.userId)) own.set(copy.userId, { id: copy.id, email: copy.email });
  }
  return own;
}
