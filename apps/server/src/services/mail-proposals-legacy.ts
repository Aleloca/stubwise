import { emailMessages, emailProposals, googleAccounts, notifications, users, type Db } from "@stubwise/db";
import { permissionForProposalAction, projectPermissionsOfUser } from "@stubwise/notifications";
import type { MailProposal, MailProposalAction, MailProposalStatus } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { answerGoogleProposal, handGoogleProposal } from "./google-proposal.js";
import type { DecideResult } from "./mail-proposals-decide.js";
import { decideCalendar } from "./mail-proposals-calendar.js";

/**
 * LE PROPOSTE DI PRIMA nella stessa forma delle condivise (area 6, F2, scelta
 * *(O)* per UNA fonte sola nel renderer): le `email_proposals` per casella
 * (`audience = mailbox_owner`), viste SOLO dal proprietario della casella,
 * come oggi. La vista si costruisce dalla loro CARD (le azioni del modello, in
 * ordine, con l'indice dell'opzione), e si decidono dal servizio dell'inbox di
 * oggi (`google-proposal.ts`): la card si chiude come prima, e l'app mobile
 * non vede differenze. Limiti dichiarati: niente `edits` (il servizio di oggi
 * non li conosce: `invalid_edits`), `decidedBy` e `results` vuoti.
 */

/** I tipi del modello sulla card (le opzioni «Sposta» e «Non fare nulla» no). */
const MODEL_TYPES = new Set(["create_backlog_item", "create_milestone", "update_ticket", "comment_ticket", "record_decision", "acknowledge_reminder"]);

export interface CardEvent {
  options?: { label?: string }[];
  actions?: ({ type?: string } & Record<string, unknown>)[];
}

interface LegacyRow {
  proposal: typeof emailProposals.$inferSelect;
  message: typeof emailMessages.$inferSelect;
  card: CardEvent | null;
  notificationId: string | null;
}

/** Le proposte di prima delle caselle di chi guarda, filtrate. */
export async function legacyRows(
  db: Db,
  viewerId: string,
  filter: { id?: string | undefined; messageId?: string | undefined; thread?: { threadId: string; accountId: string } | undefined },
): Promise<LegacyRow[]> {
  const conditions = [eq(emailProposals.audience, "mailbox_owner"), eq(googleAccounts.userId, viewerId)];
  if (filter.id) conditions.push(eq(emailProposals.id, filter.id));
  if (filter.messageId) conditions.push(eq(emailProposals.emailMessageId, filter.messageId));
  if (filter.thread) conditions.push(eq(emailMessages.threadId, filter.thread.threadId), eq(emailMessages.accountId, filter.thread.accountId));
  const rows = await db
    .select({ proposal: emailProposals, message: emailMessages, card: notifications.event, notificationId: notifications.id })
    .from(emailProposals)
    .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .leftJoin(notifications, eq(notifications.id, emailProposals.proposalNotificationId))
    .where(and(...conditions))
    .orderBy(emailProposals.createdAt);
  return rows.map((r) => ({ ...r, card: (r.card as CardEvent | null) ?? null }));
}

/** Le azioni del modello della card, con l'indice dell'opzione corrispondente. */
export function modelActions(card: CardEvent | null): { action: MailProposalAction; optionIndex: number }[] {
  const out: { action: MailProposalAction; optionIndex: number }[] = [];
  for (const [optionIndex, raw] of (card?.actions ?? []).entries()) {
    if (!raw.type || !MODEL_TYPES.has(raw.type)) continue;
    const { type, ...rest } = raw;
    const args: Record<string, unknown> = { ...rest };
    if (type === "create_backlog_item") args.description = rest.body ?? "";
    if (type === "update_ticket") args.patch = { ...(rest.status ? { status: rest.status } : {}), ...(rest.priority ? { priority: rest.priority } : {}) };
    out.push({ action: { type: type as MailProposalAction["type"], args, label: card?.options?.[optionIndex]?.label ?? "" }, optionIndex });
  }
  return out;
}

export function legacyStatus(status: string): MailProposalStatus {
  if (status === "actioned") return "confirmed";
  if (status === "ignored") return "ignored";
  if (status === "failed") return "failed";
  return "open";
}

/** La vista di una proposta di prima, coi permessi veri del proprietario. */
export async function legacyView(db: Db, viewerId: string, row: LegacyRow): Promise<MailProposal | null> {
  const permissions = await projectPermissionsOfUser(db, viewerId, row.proposal.projectId);
  if (!permissions) return null;
  const actions = modelActions(row.card);
  const status = legacyStatus(row.proposal.status);
  const open = status === "open" && row.notificationId !== null;
  const blockedIndices = actions.flatMap((a, i) => {
    const needed = permissionForProposalAction(a.action.type);
    return needed && !permissions.has(needed) ? [i] : [];
  });
  const canConfirm = open && actions.length > 0 && blockedIndices.length === 0;
  return {
    id: row.proposal.id,
    kind: "email",
    calendarOrigin: null,
    meetingOrigin: null,
    messageId: row.message.id,
    projectId: row.proposal.projectId,
    status,
    createdAt: row.proposal.createdAt.toISOString(),
    excerpt: (row.message.textExcerpt ?? "").slice(0, 500),
    actions: actions.map((a) => a.action),
    canConfirm,
    canHand: open && !canConfirm,
    canReassign: open && (row.card?.actions ?? []).some((a) => a.type === "reassign_project"),
    // Il servizio di prima non conosce le modifiche ai campi.
    editable: false,
    blockedIndices,
    outsiders: [],
    decidedBy: null,
    decidedAt: null,
    confirmedIndices: [],
    results: [],
    error: row.proposal.error,
    handedAt: null,
    handedBy: null,
    sharedWith: [],
    origin: {
      threadId: row.message.threadId,
      accountId: row.message.accountId,
      from: row.message.fromName ? `${row.message.fromName} <${row.message.fromAddress}>` : row.message.fromAddress,
      subject: row.message.subject,
    },
  };
}

/** Decidere una proposta di prima, dal servizio dell'inbox. `null` = non è una proposta di prima di chi guarda. */
export async function decideLegacy(
  db: Db,
  viewerId: string,
  id: string,
  decision:
    | { kind: "confirm"; indices?: number[] | undefined; edits?: unknown }
    | { kind: "ignore" }
    | { kind: "hand" }
    | { kind: "reassign"; projectId: string },
): Promise<DecideResult | null> {
  const [row] = await legacyRows(db, viewerId, { id });
  // F3b: un id che non è una proposta di prima può essere una proposta del calendario.
  if (!row) return decideCalendar(db, viewerId, id, decision);
  if (!row.notificationId || legacyStatus(row.proposal.status) !== "open") {
    return { ok: false, error: "already_handled", decidedBy: null };
  }
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, viewerId));
  const actor = { id: viewerId, role: user?.role ?? "member" };
  const cardActions = row.card?.actions ?? [];
  if (decision.kind === "hand") {
    const handed = await handGoogleProposal(db, { notificationId: row.notificationId, actor });
    return handed.ok ? { ok: true, status: "handed" } : mapError(handed.error);
  }
  let optionIndices: number[];
  let projectId: string | undefined;
  if (decision.kind === "confirm") {
    if (decision.edits !== undefined && Object.keys(decision.edits as object).length > 0) return { ok: false, error: "invalid_edits" };
    const actions = modelActions(row.card);
    const picked = decision.indices ?? actions.map((_, i) => i);
    if (picked.length === 0 || picked.some((i) => !Number.isInteger(i) || i < 0 || i >= actions.length) || new Set(picked).size !== picked.length) {
      return { ok: false, error: "invalid_selection" };
    }
    optionIndices = picked.map((i) => actions[i]!.optionIndex);
  } else {
    const wanted = decision.kind === "ignore" ? "ignore" : "reassign_project";
    const index = cardActions.findIndex((a) => a.type === wanted);
    if (index < 0) return { ok: false, error: "invalid_selection" };
    optionIndices = [index];
    if (decision.kind === "reassign") projectId = decision.projectId;
  }
  const answered = await answerGoogleProposal(db, {
    notificationId: row.notificationId,
    actor,
    ...(optionIndices.length === 1 ? { optionIndex: optionIndices[0]! } : { optionIndices }),
    ...(projectId ? { projectId } : {}),
  });
  if (!answered.ok) return mapError(answered.error);
  if (decision.kind === "ignore") return { ok: true, status: "ignored" };
  if (decision.kind === "reassign") return { ok: true, status: "moved", projectId: projectId! };
  return { ok: true, status: "confirmed", results: [] };
}

export function mapError(error: string): DecideResult {
  if (error === "already_handled") return { ok: false, error: "already_handled", decidedBy: null };
  if (error === "forbidden") return { ok: false, error: "forbidden" };
  if (error === "not_found") return { ok: false, error: "not_found" };
  if (error === "invalid_project" || error === "target_gone") return { ok: false, error: "invalid_target" };
  return { ok: false, error: "invalid_selection" };
}
