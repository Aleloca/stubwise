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
export async function calendarSharedWith(db: Db, proposalId: string, projectId: string | readonly string[], viewerId: string | null): Promise<string[]> {
  const rows = await db
    .select({ userId: calendarProposalRecipients.userId })
    .from(calendarProposalRecipients)
    .where(and(eq(calendarProposalRecipients.proposalId, proposalId), isNull(calendarProposalRecipients.declinedAt)));
  // Lotto 9, voce 2 (a): per una «Quale progetto?» basta vedere UNO dei candidati.
  const projectIds = typeof projectId === "string" ? [projectId] : projectId;
  const out: string[] = [];
  for (const { userId } of rows) {
    if (userId === viewerId) continue;
    for (const id of projectIds) {
      if (await projectPermissionsOfUser(db, userId, id)) {
        out.push(userId);
        break;
      }
    }
  }
  return out;
}

/**
 * Lotto 9, voce 2 (a): la «Quale progetto?» condivisa del calendario
 * (`calendar_proposals.project_id` nullo). Per chi guarda: i candidati che
 * VEDE (`seen`, decide se la vede) e, fra questi, quelli in cui può
 * CONFERMARE la proposta che ne nascerebbe (`choosable`, il permesso della
 * milestone — lo stesso della conferma di una proposta del calendario): solo
 * questi gli si offrono, e solo questi può scegliere.
 */
async function chooseScopeOf(db: Db, viewerId: string, candidates: readonly string[]): Promise<{ seen: string[]; choosable: string[] }> {
  const needed = permissionForProposalAction("create_milestone");
  const seen: string[] = [];
  const choosable: string[] = [];
  for (const id of candidates) {
    const permissions = await projectPermissionsOfUser(db, viewerId, id);
    if (!permissions) continue;
    seen.push(id);
    if (!needed || permissions.has(needed)) choosable.push(id);
  }
  return { seen, choosable };
}

/** L'estratto che vede ogni destinatario: «titolo · data» (la data dell'evento, come la milestone proposta). */
function sharedExcerpt(proposal: typeof calendarProposals.$inferSelect): string {
  const day = proposal.startsAt.toISOString().slice(0, 10);
  const title = (proposal.title ?? "").trim();
  return (title ? `${title} · ${day}` : day).slice(0, 500);
}

async function sharedView(db: Db, viewerId: string, row: SharedRow): Promise<MailProposal | null> {
  const { proposal } = row;
  if (proposal.projectId === null) return chooseView(db, viewerId, row);
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

/** L'origine, l'evento: solo a chi lo ha nel SUO calendario (la sua copia). */
async function ownOrigin(db: Db, viewerId: string, proposalId: string): Promise<MailProposal["calendarOrigin"]> {
  const [own] = await db
    .select({ id: calendarEvents.id, title: calendarEvents.title, startsAt: calendarEvents.startsAt, allDay: calendarEvents.allDay })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .where(and(eq(googleAccounts.userId, viewerId), eq(calendarEvents.calendarProposalId, proposalId)))
    .orderBy(asc(calendarEvents.createdAt))
    .limit(1);
  return own ? { eventId: own.id, title: own.title, startsAt: own.startsAt.toISOString(), allDay: own.allDay } : null;
}

/**
 * La vista di una «Quale progetto?» del calendario (lotto 9, voce 2 (a)), con
 * la forma di quella della posta (`buildView` in `mail-proposals.ts`): UN'azione
 * `choose_project` con i soli progetti fra cui chi guarda può scegliere, e
 * `projectId` = il primo che vede (la vista non porta mai l'id di un progetto
 * che chi guarda non vede, e il campo resta obbligatorio per i client).
 * Chi non vede nessun candidato non la vede affatto (404).
 */
async function chooseView(db: Db, viewerId: string, row: SharedRow): Promise<MailProposal | null> {
  const { proposal } = row;
  const { seen, choosable } = await chooseScopeOf(db, viewerId, proposal.candidateProjectIds ?? []);
  if (seen.length === 0) return null;
  const status = sharedStatus(proposal.status);
  const sharedWith = await peopleByIds(db, await calendarSharedWith(db, proposal.id, proposal.candidateProjectIds ?? [], viewerId));
  const [decidedBy] = proposal.decidedByUserId ? await peopleByIds(db, [proposal.decidedByUserId]) : [];
  const chosen = (proposal.outcome as { projectId?: unknown } | null)?.projectId;
  return {
    id: proposal.id,
    kind: "calendar",
    messageId: null,
    projectId: (typeof chosen === "string" && seen.includes(chosen) ? chosen : choosable[0]) ?? seen[0]!,
    status,
    createdAt: proposal.createdAt.toISOString(),
    excerpt: sharedExcerpt(proposal),
    actions: [{ type: "choose_project", args: { projectIds: choosable }, label: "" }],
    canConfirm: false,
    canHand: false,
    canReassign: false,
    editable: false,
    blockedIndices: [],
    outsiders: [],
    decidedBy: decidedBy ?? null,
    decidedAt: proposal.decidedAt?.toISOString() ?? null,
    confirmedIndices: [],
    results: [],
    error: proposal.error,
    handedAt: null,
    handedBy: null,
    sharedWith,
    origin: null,
    calendarOrigin: await ownOrigin(db, viewerId, proposal.id),
    meetingOrigin: null,
  };
}

/**
 * Decidere la «Quale progetto?» del calendario: chi la riceve sceglie UNO dei
 * candidati in cui può confermare. La domanda si chiude per tutti (riga
 * bloccata `FOR UPDATE`, stato ricontrollato: la prima scelta vince, chi
 * arriva dopo ha `already_handled` con chi l'ha decisa) e l'evento torna al
 * percorso di PROGETTO: le copie legate prendono il progetto scelto e si
 * slegano, e il giro dopo del worker fa nascere la proposta condivisa vera
 * (`publishSharedCalendarProposals`), con i SUOI destinatari (il titolare di
 * ogni casella e gli invitati membri espliciti del progetto). Una copia il cui
 * titolare non vede il progetto scelto resta senza progetto: non gli nasce una
 * card su un progetto che per lui non esiste.
 *
 * Stessa semantica della «Quale progetto?» della posta condivisa
 * (`chooseMailProposalProject`: la domanda se ne va, la proposta vera la
 * pubblica il worker), con un servizio suo: NON passa da `dispatchAction` di
 * `google-proposal.ts`, che su una proposta del calendario rifiuta
 * `choose_project` apposta (le due semantiche di là non si toccano). Il
 * registro decisioni non si scrive: è una scelta di smistamento, come per la
 * posta.
 */
export async function chooseCalendarProposalProject(db: Db, viewerId: string, id: string, projectId: string): Promise<DecideResult> {
  const [row] = await sharedRows(db, viewerId, { id });
  if (!row) return { ok: false, error: "not_found" };
  if (row.proposal.projectId !== null) return { ok: false, error: "invalid_selection" };
  const candidates = row.proposal.candidateProjectIds ?? [];
  const { seen, choosable } = await chooseScopeOf(db, viewerId, candidates);
  // Invisibile = inesistente: chi non vede nessun candidato ha il 404 di una che non c'è.
  if (seen.length === 0) return { ok: false, error: "not_found" };
  if (row.proposal.status !== "proposed") return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, row.proposal.decidedByUserId) };
  // Un progetto fuori dai candidati, o che chi sceglie non vede: non c'è.
  if (!seen.includes(projectId)) return { ok: false, error: "invalid_target" };
  // Lo vede ma non può confermarvi la proposta: non è suo da scegliere.
  if (!choosable.includes(projectId)) return { ok: false, error: "forbidden" };
  const decided = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: calendarProposals.status }).from(calendarProposals).where(eq(calendarProposals.id, id)).for("update");
    if (!locked || locked.status !== "proposed") return false;
    await tx
      .update(calendarProposals)
      .set({ status: "actioned", outcome: { type: "project_chosen", projectId }, decidedByUserId: viewerId, decidedAt: new Date() })
      .where(and(eq(calendarProposals.id, id), eq(calendarProposals.status, "proposed")));
    await closeCalendarCards(tx, id);
    // Le copie tornano al percorso di progetto: solo dove il titolare lo vede.
    const copies = await tx
      .select({ id: calendarEvents.id, ownerId: googleAccounts.userId })
      .from(calendarEvents)
      .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
      .where(and(eq(calendarEvents.calendarProposalId, id), isNull(calendarEvents.outcome)));
    for (const copy of copies) {
      const sees = Boolean(await projectPermissionsOfUser(tx, copy.ownerId, projectId));
      await tx
        .update(calendarEvents)
        .set({
          calendarProposalId: null,
          projectGuess: sql`jsonb_set(jsonb_set(coalesce(${calendarEvents.projectGuess}, '{}'::jsonb), '{projectId}', to_jsonb(${projectId}::text)), '{by}', '"person"'::jsonb)`,
          ...(sees ? { projectId, projectBy: "manual" as const } : {}),
        })
        .where(eq(calendarEvents.id, copy.id));
    }
    return true;
  });
  if (!decided) {
    const [fresh] = await db.select({ decidedBy: calendarProposals.decidedByUserId }).from(calendarProposals).where(eq(calendarProposals.id, id));
    return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, fresh?.decidedBy ?? null) };
  }
  return { ok: true, status: "moved", projectId };
}

/**
 * «Non fare nulla» sulla «Quale progetto?» del calendario: la chiude per
 * tutti (`ignored`), come la decide il primo. Basta vederla.
 */
export async function ignoreCalendarChoose(db: Db, viewerId: string, id: string): Promise<DecideResult> {
  const [row] = await sharedRows(db, viewerId, { id });
  if (!row) return { ok: false, error: "not_found" };
  if (row.proposal.projectId !== null) return { ok: false, error: "invalid_selection" };
  const { seen } = await chooseScopeOf(db, viewerId, row.proposal.candidateProjectIds ?? []);
  if (seen.length === 0) return { ok: false, error: "not_found" };
  const decided = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: calendarProposals.status }).from(calendarProposals).where(eq(calendarProposals.id, id)).for("update");
    if (!locked || locked.status !== "proposed") return false;
    await tx
      .update(calendarProposals)
      .set({ status: "ignored", outcome: { type: "ignored" }, decidedByUserId: viewerId, decidedAt: new Date() })
      .where(and(eq(calendarProposals.id, id), eq(calendarProposals.status, "proposed")));
    await closeCalendarCards(tx, id);
    return true;
  });
  if (!decided) {
    const [fresh] = await db.select({ decidedBy: calendarProposals.decidedByUserId }).from(calendarProposals).where(eq(calendarProposals.id, id));
    return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, fresh?.decidedBy ?? null) };
  }
  return { ok: true, status: "ignored" };
}

/** Le card di TUTTI i destinatari, chiuse insieme (come `closeSharedCalendarProposal`). */
async function closeCalendarCards(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], proposalId: string): Promise<void> {
  const cards = await tx.select({ id: calendarProposalRecipients.notificationId }).from(calendarProposalRecipients).where(eq(calendarProposalRecipients.proposalId, proposalId));
  const ids = cards.flatMap((c) => (c.id ? [c.id] : []));
  if (ids.length > 0) {
    await tx
      .update(notifications)
      .set({ status: "handled", handledAt: new Date() })
      .where(and(inArray(notifications.id, ids), eq(notifications.status, "open")));
  }
}

/** La «Quale progetto?» del calendario di cui questa card è la copia di chi guarda, se lo è. */
export async function calendarChooseOfNotification(db: Db, userId: string, notificationId: string): Promise<string | null> {
  const [row] = await db
    .select({ proposalId: calendarProposals.id })
    .from(calendarProposalRecipients)
    .innerJoin(calendarProposals, eq(calendarProposals.id, calendarProposalRecipients.proposalId))
    .where(and(eq(calendarProposalRecipients.notificationId, notificationId), eq(calendarProposalRecipients.userId, userId), isNull(calendarProposals.projectId)));
  return row?.proposalId ?? null;
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
  // Lotto 9, voce 2 (a): la «Quale progetto?» si sceglie (`/choose-project`) o si ignora; non si conferma.
  if (row.proposal.projectId === null) {
    if (decision.kind === "ignore") return ignoreCalendarChoose(db, viewerId, id);
    const { seen } = await chooseScopeOf(db, viewerId, row.proposal.candidateProjectIds ?? []);
    if (seen.length === 0) return null;
    if (row.proposal.status !== "proposed") return { ok: false, error: "already_handled", decidedBy: await decidedByOf(db, row.proposal.decidedByUserId) };
    return { ok: false, error: "invalid_selection" };
  }
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
