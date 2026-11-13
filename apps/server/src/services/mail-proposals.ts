import {
  emailMessages,
  emailProposalRecipients,
  emailProposals,
  googleAccounts,
  projects,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { canSeeMeeting, permissionForMailAction, projectPermissionsOfUser, projectViewerIds } from "@stubwise/notifications";
import type { Language, MailProposal, MailProposalAction, MailProposalStatus, ProjectPermission } from "@stubwise/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { coversAll } from "./mail-proposals-decide.js";
import { listCalendarProposals } from "./mail-proposals-calendar.js";
import { legacyRows, legacyView } from "./mail-proposals-legacy.js";
import { meetingOriginFor } from "./meetings.js";

/**
 * LE PROPOSTE CONDIVISE DELLA POSTA, IN LETTURA (area 6, fetta 2, D4).
 *
 * Chi le vede: SOLO i destinatari registrati in `email_proposal_recipients`
 * (i destinatari dell'email che sono persone di Stubwise e membri del progetto,
 * scritti dal publish), e solo finché il progetto gli è visibile. Non c'è un
 * ramo per gli admin: un admin non destinatario non è in quella tabella, e la
 * proposta per lui non esiste (404, come una che non c'è).
 *
 * I campi che il client usa per decidere (`canConfirm`, `canHand`,
 * `canReassign`, `blockedIndices`, `outsiders`) si calcolano QUI, coi permessi
 * veri di chi guarda nel progetto (`projectPermissionsFor`): il client li
 * legge, non li deduce. Lo stato della decisione («Confermata da X», «2 di 3»,
 * i codici nati) si deriva dalla riga, mai dalla notifica.
 *
 * Solo le proposte `audience = mail_recipients` (la classificazione nuova):
 * quelle di prima restano nella loro card di `/api/inbox` *(O)*.
 */

/** I tipi che si possono SPOSTARE su un altro progetto (il prototipo). */
const PORTABLE_TYPES = new Set(["create_task", "create_backlog_item", "record_decision", "create_milestone"]);

/** La classificazione v2 come la conserva `email_proposals.classification`. */
interface StoredV2 {
  version?: number;
  summary?: string;
  actions?: { type: string; args?: Record<string, unknown> }[];
  choose?: { projectIds?: string[] };
}

/** Chi guarda: basta l'id, i permessi si leggono dal DB (anche dall'inbox). */
type Viewer = { id: string };

/** Il nome di una persona, mai la sua email intera. */
const personName = sql<string>`coalesce(${users.displayName}, split_part(${users.email}, '@', 1))`;

export interface MailProposalFilter {
  /** `email_messages.id` di un messaggio della casella di chi guarda. */
  messageId?: string | undefined;
  /** Una proposta sola. */
  id?: string | undefined;
  /** Una conversazione di una casella di chi guarda (thread Gmail + casella). */
  thread?: { threadId: string; accountId: string } | undefined;
  status?: MailProposalStatus | undefined;
  /** F3b: col flag della dottrina nuova anche le proposte del calendario (della casella di chi guarda). */
  includeCalendar?: boolean | undefined;
}

/** Lo stato pubblico di una riga. */
export function publicStatus(row: { status: string; handedAt: Date | null }): MailProposalStatus {
  if (row.status === "actioned") return "confirmed";
  if (row.status === "ignored") return "ignored";
  if (row.status === "failed") return "failed";
  return row.handedAt ? "handed" : "open";
}

/**
 * Le proposte condivise che chi guarda può vedere, filtrate. Elenco vuoto per
 * un messaggio non suo o per un filtro che non trova niente: nessuna
 * distinzione fra «non esiste» e «non è tua».
 */
export async function listMailProposals(
  db: Db,
  viewer: Viewer,
  filter: MailProposalFilter,
  lang: Language,
): Promise<MailProposal[]> {
  const conditions = [
    // F5a: anche le proposte di una riunione registrata (le stesse regole, i destinatari sono gli invitati).
    inArray(emailProposals.audience, ["mail_recipients", "meeting_invitees"]),
    // Destinatario, o una proposta PASSATA (chi ha i permessi di ogni azione
    // nel progetto la vede: il controllo vero è riga per riga, sotto).
    sql`(${emailProposalRecipients.userId} is not null or ${emailProposals.handedAt} is not null)`,
  ];
  if (filter.id) conditions.push(eq(emailProposals.id, filter.id));
  if (filter.messageId) {
    // Il messaggio deve essere nella casella di chi guarda; da lì la chiave.
    // F5a: sotto l'email di Gemini, anche le proposte della SUA riunione.
    conditions.push(
      sql`(${emailProposals.rfcMessageId} = (
        select coalesce(m.rfc_message_id, 'gmail:' || m.account_id || ':' || m.gmail_message_id)
        from ${emailMessages} m join ${googleAccounts} a on a.id = m.account_id
        where m.id = ${filter.messageId} and a.user_id = ${viewer.id}
      ) or ${emailProposals.meetingNoteId} in (
        select n.id from meeting_notes n join ${emailMessages} m on m.rfc_message_id = n.rfc_message_id join ${googleAccounts} a on a.id = m.account_id
        where m.id = ${filter.messageId} and a.user_id = ${viewer.id}
      ))`,
    );
  }
  if (filter.thread) {
    // I messaggi di quella conversazione, nella casella di chi guarda; da lì le chiavi.
    conditions.push(
      sql`(${emailProposals.rfcMessageId} in (
        select coalesce(m.rfc_message_id, 'gmail:' || m.account_id || ':' || m.gmail_message_id)
        from ${emailMessages} m join ${googleAccounts} a on a.id = m.account_id
        where m.thread_id = ${filter.thread.threadId} and m.account_id = ${filter.thread.accountId} and a.user_id = ${viewer.id}
      ) or ${emailProposals.meetingNoteId} in (
        select n.id from meeting_notes n join ${emailMessages} m on m.rfc_message_id = n.rfc_message_id join ${googleAccounts} a on a.id = m.account_id
        where m.thread_id = ${filter.thread.threadId} and m.account_id = ${filter.thread.accountId} and a.user_id = ${viewer.id}
      ))`,
    );
  }
  const rows = await db
    .select({ proposal: emailProposals, excerpt: emailMessages.textExcerpt, recipient: emailProposalRecipients.userId })
    .from(emailProposals)
    .leftJoin(
      emailProposalRecipients,
      and(eq(emailProposalRecipients.proposalId, emailProposals.id), eq(emailProposalRecipients.userId, viewer.id)),
    )
    .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
    .where(and(...conditions))
    .orderBy(emailProposals.createdAt);

  const out: MailProposal[] = [];
  for (const { proposal, excerpt, recipient } of rows) {
    // Il progetto deve essere visibile ADESSO (la revoca vale a lettura).
    const permissions = await proposalPermissionsOf(db, viewer.id, proposal);
    if (!permissions) continue;
    // Un non destinatario vede solo una proposta passata di cui può decidere
    // OGNI azione (la stessa regola di `mail-proposals-decide.ts`).
    if (!recipient && !coversAll(proposal, permissions)) continue;
    // F5a: una proposta di riunione la vede solo chi vede la riunione ADESSO
    // (un invitato tolto da Google non è più fra loro), salvo una passata.
    if (proposal.audience === "meeting_invitees" && recipient && !proposal.handedAt && !(proposal.meetingNoteId && (await canSeeMeeting(db, proposal.meetingNoteId, viewer.id)))) continue;
    const view = await buildView(db, viewer, proposal, recipient ? excerpt : "", permissions, lang);
    if (filter.status && view.status !== filter.status) continue;
    out.push(view);
  }
  // Le proposte di PRIMA (per casella), nella stessa forma: UNA fonte sola.
  for (const row of await legacyRows(db, viewer.id, { id: filter.id, messageId: filter.messageId, thread: filter.thread })) {
    const view = await legacyView(db, viewer.id, row);
    if (!view || (filter.status && view.status !== filter.status)) continue;
    out.push(view);
  }
  // F3b: le proposte del calendario, una fonte sola per «Da decidere». Non
  // hanno un messaggio né una conversazione: i filtri per email le escludono.
  if (filter.includeCalendar && !filter.messageId && !filter.thread) {
    for (const view of await listCalendarProposals(db, viewer.id, { id: filter.id })) {
      if (filter.status && view.status !== filter.status) continue;
      out.push(view);
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function buildView(
  db: Db,
  viewer: Viewer,
  proposal: typeof emailProposals.$inferSelect,
  excerpt: string | null,
  permissions: ReadonlySet<ProjectPermission>,
  lang: Language,
): Promise<MailProposal> {
  const stored = proposal.classification as StoredV2;
  const status = publicStatus(proposal);
  // «Quale progetto?»: solo i progetti incerti che chi guarda vede (review F2, punto 7).
  const choose = stored.choose?.projectIds ? await seenOf(db, viewer.id, stored.choose.projectIds) : undefined;
  const rawActions = choose ? [{ type: "choose_project", args: { projectIds: choose } }] : (stored.actions ?? []);

  // I codici delle task nominate, in una query.
  const ticketIds = rawActions.map((a) => a.args?.ticketId).filter((id): id is string => typeof id === "string");
  const codes = new Map<string, string>();
  if (ticketIds.length > 0) {
    const rows = await db
      .select({ id: tickets.id, number: tickets.number, code: projects.code })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(inArray(tickets.id, ticketIds));
    for (const row of rows) codes.set(row.id, row.code ? `${row.code}-${row.number}` : `#${row.number}`);
  }
  const actions: MailProposalAction[] = rawActions.map((a) => ({
    type: a.type as MailProposalAction["type"],
    args: a.args ?? {},
    label: t(lang, `mailProposal.action.${a.type}`, {
      title: String(a.args?.title ?? ""),
      name: String(a.args?.name ?? ""),
      ticket: codes.get(String(a.args?.ticketId ?? "")) ?? "",
    }),
  }));

  const open = status === "open";
  const blockedIndices = choose
    ? []
    : actions.flatMap((a, index) => {
        const needed = permissionForMailAction(a.type);
        return needed && !permissions.has(needed) ? [index] : [];
      });
  // Una proposta PASSATA resta da decidere: la conferma chi ha i permessi.
  const decidable = open || status === "handed";
  const canConfirm = decidable && !choose && actions.length > 0 && blockedIndices.length === 0;

  const outside = await outsiderIdsOf(db, proposal.projectId, rawActions);
  const outsiders: { userId: string; name: string }[] = outside.length > 0 ? await peopleByIds(db, outside) : [];

  const recipients = await db
    .select({ userId: emailProposalRecipients.userId })
    .from(emailProposalRecipients)
    .where(eq(emailProposalRecipients.proposalId, proposal.id));
  const sharedWith = await peopleByIds(
    db,
    recipients.map((r) => r.userId).filter((id) => id !== viewer.id),
  );
  const [decidedBy] = proposal.decidedByUserId ? await peopleByIds(db, [proposal.decidedByUserId]) : [];
  const [handedBy] = proposal.handedByUserId ? await peopleByIds(db, [proposal.handedByUserId]) : [];

  // La riga d'origine: il messaggio nella casella di chi guarda, se ce l'ha.
  const [own] = await db
    .select({
      id: emailMessages.id,
      threadId: emailMessages.threadId,
      accountId: emailMessages.accountId,
      fromAddress: emailMessages.fromAddress,
      fromName: emailMessages.fromName,
      subject: emailMessages.subject,
    })
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(
      and(
        eq(googleAccounts.userId, viewer.id),
        sql`coalesce(${emailMessages.rfcMessageId}, 'gmail:' || ${emailMessages.accountId} || ':' || ${emailMessages.gmailMessageId}) = ${proposal.rfcMessageId}`,
      ),
    )
    .limit(1);

  // F5a: una proposta di riunione dice da QUALE riunione viene; il messaggio è
  // la MIA copia dell'email di Gemini, se l'ho (mai la copia di un altro).
  const meeting = proposal.audience === "meeting_invitees" && proposal.meetingNoteId ? await meetingOriginFor(db, viewer.id, proposal.meetingNoteId) : null;
  return {
    id: proposal.id,
    kind: meeting ? "meeting" : "email",
    calendarOrigin: null,
    meetingOrigin: meeting?.origin ?? null,
    messageId: meeting ? meeting.ownMessageId : (own?.id ?? proposal.emailMessageId),
    // Un «Quale progetto?» sta sotto un progetto che chi guarda vede.
    projectId: choose?.[0] ?? proposal.projectId,
    status,
    createdAt: proposal.createdAt.toISOString(),
    excerpt: (excerpt ?? "").slice(0, 500),
    actions,
    canConfirm,
    canHand: open && !choose && !canConfirm,
    canReassign: open && !choose && actions.length > 0 && actions.every((a) => PORTABLE_TYPES.has(a.type)),
    editable: canConfirm,
    blockedIndices,
    outsiders,
    decidedBy: decidedBy ?? null,
    decidedAt: proposal.decidedAt?.toISOString() ?? null,
    confirmedIndices: proposal.confirmedIndices ?? [],
    results: (proposal.results ?? []).map((r) => ({ kind: r.kind as MailProposal["results"][number]["kind"], id: r.id, code: r.code })),
    error: proposal.error,
    handedAt: proposal.handedAt?.toISOString() ?? null,
    handedBy: handedBy ?? null,
    sharedWith,
    origin: own
      ? {
          threadId: own.threadId,
          accountId: own.accountId,
          from: own.fromName ? `${own.fromName} <${own.fromAddress}>` : own.fromAddress,
          subject: own.subject,
        }
      : null,
  };
}

async function peopleByIds(db: Db, ids: readonly string[]): Promise<{ userId: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ userId: users.id, name: personName }).from(users).where(inArray(users.id, [...ids]));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Gli incaricati proposti che NON vedono il progetto: membri espliciti E full
 * admin impliciti (`projectViewerIds`), la stessa regola che la decisione
 * accetta — un full admin incaricato non è un esterno (review renderer F2).
 * È anche l'unico elenco che «aggiungi come Contributor» può toccare.
 */
export async function outsiderIdsOf(db: Db, projectId: string, actions: readonly { type: string; args?: Record<string, unknown> }[]): Promise<string[]> {
  const assignees = assigneeIdsOf(actions);
  if (assignees.length === 0) return [];
  const viewers = new Set(await projectViewerIds(db, projectId));
  return [...new Set(assignees.filter((id) => !viewers.has(id)))];
}

/** Gli incaricati proposti dalle azioni (create_task, la patch di update_ticket). */
export function assigneeIdsOf(actions: readonly { type: string; args?: Record<string, unknown> }[]): string[] {
  return [
    ...new Set(
      actions
        .map((a) => (a.type === "update_ticket" ? (a.args?.patch as Record<string, unknown> | undefined)?.assigneeId : a.args?.assigneeId))
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
}

async function seenOf(db: Db, userId: string, projectIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of projectIds) if (await projectPermissionsOfUser(db, userId, id)) out.push(id);
  return out;
}

/**
 * I permessi con cui chi guarda vede una proposta condivisa: quelli del suo
 * progetto — o, per un «Quale progetto?», del primo progetto incerto che vede
 * (la domanda arriva a chi ne vede ALMENO UNO, review F2, punto 7). `null` =
 * non la vede.
 */
export async function proposalPermissionsOf(
  db: Db,
  userId: string,
  proposal: { projectId: string; classification: unknown },
): Promise<ReadonlySet<ProjectPermission> | null> {
  const choose = (proposal.classification as { choose?: { projectIds?: string[] } } | null)?.choose?.projectIds;
  if (!choose) return projectPermissionsOfUser(db, userId, proposal.projectId);
  for (const id of choose) {
    const permissions = await projectPermissionsOfUser(db, userId, id);
    if (permissions) return permissions;
  }
  return null;
}

