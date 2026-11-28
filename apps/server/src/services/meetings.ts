import { backlogItems, backlogItemTickets, backlogJobs, calendarEvents, emailMessages, emailProposalRecipients, emailProposals, googleAccounts, meetingNotes, projects, tickets, type Db, ticketStatusSql } from "@stubwise/db";
import { canSeeMeeting, projectPermissionsOfUser } from "@stubwise/notifications";
import type { MeetingNote, MeetingSummary, MeetingTask, MeetingTasks } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { requestVisibility } from "./project-requests.js";
import { visibleTasksCondition } from "./task-view.js";

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

/**
 * LE RIUNIONI REGISTRATE, IN LETTURA (area 6, F5a, task 4). Chi vede cosa lo
 * decide `canSeeMeeting` (`@stubwise/notifications`, l'eccezione dichiarata a
 * «Posta e Calendario personali»): tutti gli invitati di Stubwise, anche
 * senza l'evento nel loro calendario; senza evento, chi ha ricevuto l'email.
 * Mai un membro che non c'era, mai un admin non invitato: per chi non è nel
 * calcolo la riunione non esiste (404, `visible: false`).
 *
 * La trascrizione intera non esce: il riassunto (narrativa) e il link al Doc
 * (i permessi li applica Google, Q2).
 */

type NoteRow = typeof meetingNotes.$inferSelect;

export const docUrlOf = (docFileId: string) => `https://docs.google.com/document/d/${encodeURIComponent(docFileId)}`;

/** La riga dell'evento nel calendario di CHI GUARDA, se ce l'ha (stesso iCalUID e stessa data). */
async function ownEventRow(db: Db, viewerId: string, note: NoteRow) {
  if (!note.icalUid) return null;
  const conditions = [eq(googleAccounts.userId, viewerId), eq(calendarEvents.icalUid, note.icalUid), sql`${calendarEvents.status} is distinct from 'cancelled'`];
  if (note.eventStartsAt) conditions.push(eq(calendarEvents.startsAt, note.eventStartsAt));
  const [row] = await db
    .select({ id: calendarEvents.id, title: calendarEvents.title, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, attendees: calendarEvents.attendees })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .where(and(...conditions))
    .orderBy(desc(calendarEvents.updatedAt))
    .limit(1);
  return row ?? null;
}

/** La copia dell'email di Gemini nella casella di chi guarda, se l'ha ricevuta. */
async function ownCopy(db: Db, viewerId: string, note: NoteRow) {
  const [row] = await db
    .select({ id: emailMessages.id, threadId: emailMessages.threadId, accountId: emailMessages.accountId, receivedAt: emailMessages.receivedAt })
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(and(eq(googleAccounts.userId, viewerId), note.rfcMessageId ? eq(emailMessages.rfcMessageId, note.rfcMessageId) : eq(emailMessages.id, note.sourceMessageId)))
    .limit(1);
  return row ?? null;
}

async function noteById(db: Db, noteId: string): Promise<NoteRow | null> {
  const [note] = await db.select().from(meetingNotes).where(eq(meetingNotes.id, noteId));
  return note ?? null;
}

/** `MeetingNote` per il messaggio di Gemini: a chi non c'era, `visible` falso e niente contenuto. */
export async function meetingNoteView(db: Db, viewerId: string, noteId: string): Promise<MeetingNote | null> {
  const note = await noteById(db, noteId);
  if (!note) return null;
  if (!(await canSeeMeeting(db, note.id, viewerId))) {
    return { noteId: note.id, docTitle: null, doc: null, docReason: null, visible: false, summary: null, docUrl: null, event: null };
  }
  const event = await ownEventRow(db, viewerId, note);
  return {
    noteId: note.id,
    docTitle: note.docTitle,
    doc: note.docStatus,
    docReason: note.docReason,
    visible: true,
    summary: note.docStatus === "ready" ? note.summary : null,
    docUrl: docUrlOf(note.docFileId),
    event: event ? { id: event.id, title: event.title, startsAt: event.startsAt.toISOString(), endsAt: event.endsAt?.toISOString() ?? null, people: event.attendees.length } : null,
  };
}

/** Il riassunto, o `null` (404) per chi non è nel calcolo. */
export async function meetingSummaryFor(db: Db, viewerId: string, noteId: string): Promise<MeetingSummary | null> {
  const note = await noteById(db, noteId);
  if (!note || !(await canSeeMeeting(db, note.id, viewerId))) return null;
  const event = await ownEventRow(db, viewerId, note);
  const copy = await ownCopy(db, viewerId, note);
  return {
    noteId: note.id,
    eventId: event?.id ?? null,
    docTitle: note.docTitle,
    doc: note.docStatus,
    docReason: note.docReason,
    summary: note.docStatus === "ready" ? note.summary : null,
    docUrl: docUrlOf(note.docFileId),
    email: copy ? { threadId: copy.threadId, accountId: copy.accountId, messageId: copy.id, at: copy.receivedAt.toISOString() } : null,
  };
}

/** La riunione di una riga del calendario di chi guarda (stesso iCalUID, stessa data), se c'è. */
export async function noteForEventRow(db: Db, viewerId: string, rowId: string): Promise<{ noteId: string | null; row: { projectId: string | null; startsAt: Date } } | null> {
  const [row] = await db
    .select({ icalUid: calendarEvents.icalUid, startsAt: calendarEvents.startsAt, projectId: calendarEvents.projectId })
    .from(calendarEvents)
    .innerJoin(googleAccounts, eq(googleAccounts.id, calendarEvents.accountId))
    .where(and(eq(calendarEvents.id, rowId), eq(googleAccounts.userId, viewerId)));
  if (!row) return null;
  if (!row.icalUid) return { noteId: null, row };
  const [note] = await db
    .select({ id: meetingNotes.id })
    .from(meetingNotes)
    .where(and(eq(meetingNotes.icalUid, row.icalUid), eq(meetingNotes.eventStartsAt, row.startsAt)))
    .orderBy(desc(meetingNotes.createdAt))
    .limit(1);
  return { noteId: note?.id ?? null, row };
}

/**
 * «Task da questa riunione» (R-I21): solo ai MEMBRI del progetto della
 * riunione; `null` a chi non lo è (anche se ha il riassunto) e a una riunione
 * senza progetto. Le task e le RICHIESTE nate dalle proposte già confermate,
 * per data della decisione e nell'ordine dei loro esiti, senza doppi; quante
 * task propongono quelle ancora aperte che chi guarda riceve (o che gli sono
 * state passate).
 *
 * Rimandi, lotto 4 (§3, la specifica è `bornFrom` del prototipo). Una
 * richiesta si risolve A LETTURA dal suo job d'intake (`results[].id` è l'id
 * del job; `backlog_jobs.result_item_id` la voce): aperta → la voce; convertita
 * → al suo posto le sue task (`converted_to`); fusa a mano → la sorgente,
 * «done»; ancora in intake → `pending` senza codice; fallita o senza voce →
 * niente. Tutto dal SOLO progetto della riunione, e coi filtri di
 * visibilità degli elenchi nella WHERE (`requestVisibility`,
 * `visibleTasksCondition`): una riga visibile non apre mai un 404.
 */
async function tasksOf(db: Db, viewer: Viewer, noteId: string | null, projectId: string | null, today: string): Promise<MeetingTasks> {
  const permissions = projectId ? await projectPermissionsOfUser(db, viewer.id, projectId) : null;
  if (!projectId || !permissions) return null;
  if (!noteId) return { tasks: [], proposedTasks: 0 };
  const proposals = await db
    .select({ proposal: emailProposals, recipient: emailProposalRecipients.userId })
    .from(emailProposals)
    .leftJoin(emailProposalRecipients, and(eq(emailProposalRecipients.proposalId, emailProposals.id), eq(emailProposalRecipients.userId, viewer.id)))
    .where(and(eq(emailProposals.meetingNoteId, noteId), eq(emailProposals.projectId, projectId)));
  const sequence: { kind: "task" | "request"; id: string }[] = [];
  let proposedTasks = 0;
  for (const { proposal, recipient } of proposals.sort((a, b) => (a.proposal.decidedAt?.getTime() ?? 0) - (b.proposal.decidedAt?.getTime() ?? 0))) {
    for (const r of proposal.results ?? []) if ((r.kind === "task" || r.kind === "request") && r.id) sequence.push({ kind: r.kind, id: r.id });
    const open = proposal.status === "classified" || proposal.status === "proposed";
    if (open && (recipient || proposal.handedAt)) {
      const actions = (proposal.classification as { actions?: { type: string }[] }).actions ?? [];
      proposedTasks += actions.filter((a) => a.type === "create_task").length;
    }
  }
  if (sequence.length === 0) return { tasks: [], proposedTasks };
  const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  const projectCode = project?.code ?? null;

  // Le richieste: i job del progetto, poi le voci visibili, poi le task delle convertite.
  const jobIds = sequence.filter((e) => e.kind === "request").map((e) => e.id);
  const jobs = jobIds.length
    ? await db
        .select({ id: backlogJobs.id, status: backlogJobs.status, itemId: backlogJobs.resultItemId, payload: backlogJobs.payload })
        .from(backlogJobs)
        .where(and(inArray(backlogJobs.id, jobIds), eq(backlogJobs.projectId, projectId)))
    : [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const itemIds = [...new Set(jobs.flatMap((j) => (j.status === "done" && j.itemId ? [j.itemId] : [])))];
  const items = itemIds.length
    ? await db
        .select({ id: backlogItems.id, number: backlogItems.number, title: backlogItems.title, status: backlogItems.status })
        .from(backlogItems)
        .where(and(inArray(backlogItems.id, itemIds), eq(backlogItems.projectId, projectId), await requestVisibility(db, viewer)))
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));
  const convertedIds = items.filter((i) => i.status === "converted").map((i) => i.id);
  const conversions = convertedIds.length
    ? await db
        .select({ itemId: backlogItemTickets.itemId, ticketId: backlogItemTickets.ticketId })
        .from(backlogItemTickets)
        .where(and(inArray(backlogItemTickets.itemId, convertedIds), eq(backlogItemTickets.role, "converted_to")))
        .orderBy(asc(backlogItemTickets.createdAt))
    : [];
  const ticketIds = [...new Set([...sequence.filter((e) => e.kind === "task").map((e) => e.id), ...conversions.map((c) => c.ticketId)])];
  const rows = ticketIds.length
    ? await db
        .select({ id: tickets.id, number: tickets.number, title: tickets.title, status: ticketStatusSql, dueDate: tickets.dueDate, departmentId: tickets.departmentId, code: projects.code })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(and(inArray(tickets.id, ticketIds), eq(tickets.projectId, projectId), await visibleTasksCondition(db, viewer)))
    : [];
  const ticketById = new Map(rows.map((t) => [t.id, t]));
  const taskRow = (id: string): MeetingTask | null => {
    const t = ticketById.get(id);
    if (!t) return null;
    const done = t.status === "done" || t.status === "closed";
    return {
      kind: "task",
      id: t.id,
      code: t.code ? `${t.code}-${t.number}` : null,
      title: t.title,
      status: done ? "done" : t.dueDate && t.dueDate < today ? "late" : "open",
      inProgress: t.status === "in_progress",
      dueDate: t.dueDate,
      departmentId: t.departmentId,
      projectCode,
      pending: false,
    };
  };
  const viewsAllRequests = permissions.has("backlog.view_all");
  const out: MeetingTask[] = [];
  const seen = new Set<string>();
  const push = (row: MeetingTask | null) => {
    if (!row || seen.has(`${row.kind}:${row.id}`)) return;
    seen.add(`${row.kind}:${row.id}`);
    out.push(row);
  };
  for (const entry of sequence) {
    if (entry.kind === "task") {
      push(taskRow(entry.id));
      continue;
    }
    const job = jobById.get(entry.id);
    if (!job) continue;
    if (job.status === "queued" || job.status === "running") {
      // D-3.1 = b: ancora in intake. La vede chi vedrà la voce: chi ha
      // `backlog.view_all`, o chi l'ha chiesta.
      const payload = job.payload as { title?: unknown; requestedByUserId?: unknown };
      if (!viewsAllRequests && payload.requestedByUserId !== viewer.id) continue;
      push({ kind: "request", id: job.id, code: null, title: typeof payload.title === "string" ? payload.title : "", status: "open", inProgress: false, dueDate: null, departmentId: null, projectCode, pending: true });
      continue;
    }
    const item = job.status === "done" && job.itemId ? itemById.get(job.itemId) : undefined;
    if (!item) continue;
    if (item.status === "converted") {
      for (const c of conversions) if (c.itemId === item.id) push(taskRow(c.ticketId));
      continue;
    }
    push({
      kind: "request",
      id: item.id,
      code: projectCode ? `${projectCode}-R${item.number}` : null,
      title: item.title,
      status: item.status === "archived" ? "done" : "open",
      inProgress: false,
      dueDate: null,
      departmentId: null,
      projectCode,
      pending: false,
    });
  }
  return { tasks: out, proposedTasks };
}

/** Le task di una riga del calendario di chi guarda; `undefined` = la riga non è sua (404). */
export async function meetingTasksFor(db: Db, viewer: Viewer, rowId: string, today: string): Promise<MeetingTasks | undefined> {
  const found = await noteForEventRow(db, viewer.id, rowId);
  if (!found) return undefined;
  return tasksOf(db, viewer, found.noteId, found.row.projectId, today);
}

/** Le task di una riunione per id (l'invitato senza l'evento); `undefined` = non è fra chi la vede (404). */
export async function meetingTasksByNote(db: Db, viewer: Viewer, noteId: string, today: string): Promise<MeetingTasks | undefined> {
  const note = await noteById(db, noteId);
  if (!note || !(await canSeeMeeting(db, note.id, viewer.id))) return undefined;
  return tasksOf(db, viewer, note.id, note.projectId, today);
}

/** L'origine di una proposta di riunione, per chi guarda. */
export async function meetingOriginFor(db: Db, viewerId: string, noteId: string) {
  const note = await noteById(db, noteId);
  if (!note) return null;
  const event = await ownEventRow(db, viewerId, note);
  const copy = await ownCopy(db, viewerId, note);
  return {
    origin: { noteId: note.id, eventId: event?.id ?? null, threadId: copy?.threadId ?? null, accountId: copy?.accountId ?? null, title: note.eventTitle ?? note.docTitle, at: (note.eventStartsAt ?? note.createdAt).toISOString() },
    ownMessageId: copy?.id ?? null,
  };
}
