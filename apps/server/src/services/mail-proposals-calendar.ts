import { calendarEvents, calendarProposalRecipients, calendarProposals, googleAccounts, notifications, users, type Db } from "@stubwise/db";
import { permissionForProposalAction, projectPermissionsOfUser } from "@stubwise/notifications";
import type { MailProposal } from "@stubwise/shared";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { answerGoogleProposal } from "./google-proposal.js";
import type { DecideResult } from "./mail-proposals-decide.js";
import { legacyStatus, mapError, modelActions, type CardEvent } from "./mail-proposals-legacy.js";

/**
 * LE PROPOSTE DEL CALENDARIO in `/api/me/mail/proposals` (area 6, F3b, task
 * 7, decisione *(O)* di 46: una fonte sola per «Da decidere»). Sono le card
 * di sempre (`google.proposal`, `source: calendar`), della casella di CHI
 * GUARDA (`mailbox_owner`: l'id di chi guarda nella WHERE): qui si leggono e
 * si decidono passando dalla card, come le proposte di prima della posta.
 * `id` è quello dell'evento (`calendar_events.id`); `kind: "calendar"`,
 * `messageId` null, l'origine in `calendarOrigin`.
 *
 * Lotto 9, voce 2 (d): gli eventi SINGOLI sono proposte CONDIVISE fra gli
 * invitati (`calendar_proposals`, audience `event_invitees`). Le vede e le
 * decide SOLO un destinatario registrato in `calendar_proposal_recipients`
 * che non ha rifiutato l'invito, col progetto visibile ADESSO: un admin che
 * non è fra loro non la vede (404, come una che non c'è). `id` è quello della
 * proposta; l'estratto «titolo · data» lo vede ogni destinatario, l'origine
 * (`calendarOrigin`, l'evento) solo chi ha l'evento nel suo calendario;
 * `sharedWith` = gli altri destinatari che la vedono ancora. Le proposte di
 * prima (per casella, `calendar_events.proposal_notification_id`) restano
 * com'erano finché non si decidono.
 */

interface CalendarRow {
  event: typeof calendarEvents.$inferSelect;
  card: CardEvent | null;
  notificationId: string | null;
}

async function calendarRows(db: Db, viewerId: string, filter: { id?: string | undefined }): Promise<CalendarRow[]> {
  const conditions = [eq(googleAccounts.userId, viewerId), isNotNull(calendarEvents.proposalNotificationId)];
  if (filter.id) conditions.push(eq(calendarEvents.id, filter.id));
  const rows = await db
    .select({ event: calendarEvents, card: notifications.event, notificationId: notifications.id })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .leftJoin(notifications, eq(notifications.id, calendarEvents.proposalNotificationId))
    .where(and(...conditions))
    .orderBy(calendarEvents.startsAt);
  return rows.map((r) => ({ ...r, card: (r.card as CardEvent | null) ?? null }));
}

/** Lo stato pubblico: dall'esito dell'evento e dalla card. */
function calendarStatus(row: CalendarRow): MailProposal["status"] {
  const outcome = (row.event.outcome as { type?: string } | null)?.type;
  if (!outcome) return legacyStatus("proposed");
  if (outcome === "failed" || outcome === "error") return "failed";
  if (outcome === "ignored" || outcome === "cancelled" || outcome === "declined" || outcome === "expired" || outcome === "baseline") return "ignored";
  return "confirmed";
}

export async function listCalendarProposals(db: Db, viewerId: string, filter: { id?: string | undefined } = {}): Promise<MailProposal[]> {
  const out: MailProposal[] = [];
  // I permessi una volta per PROGETTO, non per riga (review F3b).
  const permissionsOf = new Map<string, Awaited<ReturnType<typeof projectPermissionsOfUser>>>();
  for (const row of await sharedRows(db, viewerId, filter)) {
    const view = await sharedView(db, viewerId, row);
    if (view) out.push(view);
  }
  for (const row of await calendarRows(db, viewerId, filter)) {
    // Il progetto della CARD prima: per un'occorrenza di serie è quello scelto
    // sulla serie, che può essere diverso da quello delle regole sulla riga.
    const projectId = (row.card as { projectId?: string } | null)?.projectId ?? row.event.projectId ?? null;
    if (!projectId) continue;
    if (!permissionsOf.has(projectId)) permissionsOf.set(projectId, await projectPermissionsOfUser(db, viewerId, projectId));
    const permissions = permissionsOf.get(projectId);
    if (!permissions) continue;
    const actions = modelActions(row.card);
    const status = calendarStatus(row);
    const open = status === "open" && row.notificationId !== null;
    const blockedIndices = actions.flatMap((a, i) => {
      const needed = permissionForProposalAction(a.action.type);
      return needed && !permissions.has(needed) ? [i] : [];
    });
    const canConfirm = open && actions.length > 0 && blockedIndices.length === 0;
    out.push({
      id: row.event.id,
      kind: "calendar",
      messageId: null,
      projectId,
      status,
      createdAt: row.event.createdAt.toISOString(),
      excerpt: "",
      actions: actions.map((a) => a.action),
      canConfirm,
      canHand: false,
      canReassign: false,
      editable: false,
      blockedIndices,
      outsiders: [],
      decidedBy: null,
      decidedAt: null,
      confirmedIndices: [],
      results: [],
      error: null,
      handedAt: null,
      handedBy: null,
      sharedWith: [],
      origin: null,
      calendarOrigin: { eventId: row.event.id, title: row.event.title, startsAt: row.event.startsAt.toISOString(), allDay: row.event.allDay },
      meetingOrigin: null,
    });
  }
  return out;
}

/** Decidere una proposta del calendario: passa dalla sua card, come una proposta di prima. */
export async function decideCalendar(
  db: Db,
  viewerId: string,
  id: string,
  decision: { kind: "confirm"; indices?: number[] | undefined; edits?: unknown } | { kind: "ignore" } | { kind: "hand" } | { kind: "reassign"; projectId: string },
): Promise<DecideResult | null> {
  const [row] = await calendarRows(db, viewerId, { id });
  if (!row) return decideShared(db, viewerId, id, decision);
  if (!row.notificationId || calendarStatus(row) !== "open") return { ok: false, error: "already_handled", decidedBy: null };
  if (decision.kind === "hand" || decision.kind === "reassign") return { ok: false, error: "invalid_selection" };
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, viewerId));
  const actor = { id: viewerId, role: user?.role ?? "member" };
  let optionIndices: number[];
  if (decision.kind === "confirm") {
    if (decision.edits !== undefined && Object.keys(decision.edits as object).length > 0) return { ok: false, error: "invalid_edits" };
    const actions = modelActions(row.card);
    const picked = decision.indices ?? actions.map((_, i) => i);
    if (picked.length === 0 || picked.some((i) => !Number.isInteger(i) || i < 0 || i >= actions.length)) return { ok: false, error: "invalid_selection" };
    optionIndices = picked.map((i) => actions[i]!.optionIndex);
  } else {
    const index = (row.card?.actions ?? []).findIndex((a) => a.type === "ignore");
    if (index < 0) return { ok: false, error: "invalid_selection" };
    optionIndices = [index];
  }
  const answered = await answerGoogleProposal(db, {
    notificationId: row.notificationId,
    actor,
    ...(optionIndices.length === 1 ? { optionIndex: optionIndices[0]! } : { optionIndices }),
  });
  if (!answered.ok) return mapError(answered.error);
  return decision.kind === "ignore" ? { ok: true, status: "ignored" } : { ok: true, status: "confirmed", results: [] };
}

// ---------------------------------------------------------------------------
// Lotto 9, voce 2 (d): le proposte CONDIVISE fra gli invitati.
// ---------------------------------------------------------------------------

interface SharedRow {
  proposal: typeof calendarProposals.$inferSelect;
  card: CardEvent | null;
  notificationId: string | null;
}

/** Le proposte condivise di cui chi guarda è destinatario e che non ha rifiutato. */
async function sharedRows(db: Db, viewerId: string, filter: { id?: string | undefined }): Promise<SharedRow[]> {
  const conditions = [eq(calendarProposalRecipients.userId, viewerId), isNull(calendarProposalRecipients.declinedAt)];
  if (filter.id) conditions.push(eq(calendarProposals.id, filter.id));
  const rows = await db
    .select({ proposal: calendarProposals, card: notifications.event, notificationId: notifications.id })
    .from(calendarProposalRecipients)
    .innerJoin(calendarProposals, eq(calendarProposals.id, calendarProposalRecipients.proposalId))
    .leftJoin(notifications, eq(notifications.id, calendarProposalRecipients.notificationId))
    .where(and(...conditions))
    .orderBy(asc(calendarProposals.startsAt));
  return rows.map((r) => ({ ...r, card: (r.card as CardEvent | null) ?? null }));
}

function sharedStatus(status: string): MailProposal["status"] {
  if (status === "actioned") return "confirmed";
  if (status === "ignored") return "ignored";
  if (status === "failed") return "failed";
  return "open";
}

/** Il nome di una persona, mai la sua email intera (come le condivise della posta). */
const personName = sql<string>`coalesce(${users.displayName}, split_part(${users.email}, '@', 1))`;

async function peopleByIds(db: Db, ids: readonly string[]): Promise<{ userId: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ userId: users.id, name: personName }).from(users).where(inArray(users.id, [...ids]));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Gli ALTRI destinatari che la vedono ancora: non hanno rifiutato e il
 * progetto gli è visibile adesso. Sono conosciuti per questa proposta (sono
 * fra gli invitati): la regola dei nomi di `maskMailDeciders`.
 */
export async function calendarSharedWith(db: Db, proposalId: string, projectId: string, viewerId: string | null): Promise<string[]> {
  const rows = await db
    .select({ userId: calendarProposalRecipients.userId })
    .from(calendarProposalRecipients)
    .where(and(eq(calendarProposalRecipients.proposalId, proposalId), isNull(calendarProposalRecipients.declinedAt)));
  const out: string[] = [];
  for (const { userId } of rows) {
    if (userId === viewerId) continue;
    if (await projectPermissionsOfUser(db, userId, projectId)) out.push(userId);
  }
  return out;
}

/** L'estratto che vede ogni destinatario: «titolo · data» (la data dell'evento, come la milestone proposta). */
function sharedExcerpt(proposal: typeof calendarProposals.$inferSelect): string {
  const day = proposal.startsAt.toISOString().slice(0, 10);
  const title = (proposal.title ?? "").trim();
  return (title ? `${title} · ${day}` : day).slice(0, 500);
}

async function sharedView(db: Db, viewerId: string, row: SharedRow): Promise<MailProposal | null> {
  const { proposal } = row;
  // Il progetto deve essere visibile ADESSO (la revoca vale a lettura).
  const permissions = await projectPermissionsOfUser(db, viewerId, proposal.projectId);
  if (!permissions) return null;
  const actions = modelActions(row.card);
  const status = sharedStatus(proposal.status);
  const open = status === "open" && row.notificationId !== null;
  const blockedIndices = actions.flatMap((a, i) => {
    const needed = permissionForProposalAction(a.action.type);
    return needed && !permissions.has(needed) ? [i] : [];
  });
  const canConfirm = open && actions.length > 0 && blockedIndices.length === 0;
  const sharedWith = await peopleByIds(db, await calendarSharedWith(db, proposal.id, proposal.projectId, viewerId));
  const [decidedBy] = proposal.decidedByUserId ? await peopleByIds(db, [proposal.decidedByUserId]) : [];
  // L'origine, l'evento: solo a chi lo ha nel SUO calendario (la sua copia).
  const [own] = await db
    .select({ id: calendarEvents.id, title: calendarEvents.title, startsAt: calendarEvents.startsAt, allDay: calendarEvents.allDay })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .where(and(eq(googleAccounts.userId, viewerId), eq(calendarEvents.calendarProposalId, proposal.id)))
    .orderBy(asc(calendarEvents.createdAt))
    .limit(1);
  const outcome = proposal.outcome as { chosenIndices?: unknown } | null;
  const chosen = Array.isArray(outcome?.chosenIndices) ? (outcome.chosenIndices as unknown[]).filter((i): i is number => typeof i === "number") : [];
  return {
    id: proposal.id,
    kind: "calendar",
    messageId: null,
    projectId: proposal.projectId,
    status,
    createdAt: proposal.createdAt.toISOString(),
    excerpt: sharedExcerpt(proposal),
    actions: actions.map((a) => a.action),
    canConfirm,
    // Il calendario non si passa né si sposta (ruling R37).
    canHand: false,
    canReassign: false,
    editable: false,
    blockedIndices,
    outsiders: [],
    decidedBy: decidedBy ?? null,
    decidedAt: proposal.decidedAt?.toISOString() ?? null,
    // Gli indici della card sono indici di OPZIONE: qui quelli delle azioni.
    confirmedIndices: status === "confirmed" ? actions.flatMap((a, i) => (chosen.includes(a.optionIndex) ? [i] : [])) : [],
    results: [],
    error: proposal.error,
    handedAt: null,
    handedBy: null,
    sharedWith,
    origin: null,
    calendarOrigin: own ? { eventId: own.id, title: own.title, startsAt: own.startsAt.toISOString(), allDay: own.allDay } : null,
    meetingOrigin: null,
  };
}

async function decidedByOf(db: Db, userId: string | null): Promise<{ userId: string; name: string } | null> {
  if (!userId) return null;
  const [person] = await peopleByIds(db, [userId]);
  return person ?? null;
}

/**
 * Decidere una proposta condivisa: la decide il PRIMO destinatario, per tutti.
 * Passa dalla sua card (`answerGoogleProposal`), che fa il claim su tutte le
 * card della proposta (lo stesso `proposalId`), controlla il permesso
 * dell'azione nel progetto prima del claim e scrive l'esito sulla riga
 * bloccata (`FOR UPDATE`, `closeSharedCalendarProposal`). Chi arriva dopo:
 * `already_handled` con chi l'ha decisa (mascherato dalla rotta).
 */
async function decideShared(
  db: Db,
  viewerId: string,
  id: string,
  decision: { kind: "confirm"; indices?: number[] | undefined; edits?: unknown } | { kind: "ignore" } | { kind: "hand" } | { kind: "reassign"; projectId: string },
): Promise<DecideResult | null> {
  const [row] = await sharedRows(db, viewerId, { id });
  if (!row) return null;
  if (!(await projectPermissionsOfUser(db, viewerId, row.proposal.projectId))) return null;
  if (row.proposal.status !== "proposed" || !row.notificationId) {
    return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, row.proposal.decidedByUserId) };
  }
  if (decision.kind === "hand" || decision.kind === "reassign") return { ok: false, error: "invalid_selection" };
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, viewerId));
  const actor = { id: viewerId, role: user?.role ?? "member" };
  let optionIndices: number[];
  if (decision.kind === "confirm") {
    if (decision.edits !== undefined && Object.keys(decision.edits as object).length > 0) return { ok: false, error: "invalid_edits" };
    const actions = modelActions(row.card);
    const picked = decision.indices ?? actions.map((_, i) => i);
    if (picked.length === 0 || picked.some((i) => !Number.isInteger(i) || i < 0 || i >= actions.length)) return { ok: false, error: "invalid_selection" };
    optionIndices = picked.map((i) => actions[i]!.optionIndex);
  } else {
    const index = (row.card?.actions ?? []).findIndex((a) => a.type === "ignore");
    if (index < 0) return { ok: false, error: "invalid_selection" };
    optionIndices = [index];
  }
  const answered = await answerGoogleProposal(db, {
    notificationId: row.notificationId,
    actor,
    ...(optionIndices.length === 1 ? { optionIndex: optionIndices[0]! } : { optionIndices }),
  });
  if (!answered.ok) {
    if (answered.error === "already_handled") {
      const [fresh] = await db.select({ decidedBy: calendarProposals.decidedByUserId }).from(calendarProposals).where(eq(calendarProposals.id, id));
      return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, fresh?.decidedBy ?? null) };
    }
    return mapError(answered.error);
  }
  return decision.kind === "ignore" ? { ok: true, status: "ignored" } : { ok: true, status: "confirmed", results: [] };
}

/** Le persone che una proposta condivisa del calendario nomina (per il 409 `already_handled`, come `mailParticipantIds`). */
export async function calendarParticipantIds(db: Db, proposalId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: calendarProposalRecipients.userId })
    .from(calendarProposalRecipients)
    .where(and(eq(calendarProposalRecipients.proposalId, proposalId), isNull(calendarProposalRecipients.declinedAt)));
  return rows.map((r) => r.userId);
}
