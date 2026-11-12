import { calendarEvents, googleAccounts, notifications, users, type Db } from "@stubwise/db";
import { permissionForProposalAction, projectPermissionsOfUser } from "@stubwise/notifications";
import type { MailProposal } from "@stubwise/shared";
import { and, eq, isNotNull } from "drizzle-orm";
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
  if (outcome === "ignored" || outcome === "cancelled" || outcome === "declined" || outcome === "expired") return "ignored";
  return "confirmed";
}

export async function listCalendarProposals(db: Db, viewerId: string, filter: { id?: string | undefined } = {}): Promise<MailProposal[]> {
  const out: MailProposal[] = [];
  for (const row of await calendarRows(db, viewerId, filter)) {
    const projectId = row.event.projectId ?? (row.card as { projectId?: string } | null)?.projectId ?? null;
    if (!projectId) continue;
    const permissions = await projectPermissionsOfUser(db, viewerId, projectId);
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
  if (!row) return null;
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
