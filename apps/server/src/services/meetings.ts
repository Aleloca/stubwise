import { calendarEvents, emailMessages, emailProposalRecipients, emailProposals, googleAccounts, meetingNotes, projects, tickets, type Db } from "@stubwise/db";
import { canSeeMeeting, projectPermissionsOfUser } from "@stubwise/notifications";
import type { MeetingNote, MeetingSummary, MeetingTask, MeetingTasks } from "@stubwise/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

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
    email: copy ? { threadId: copy.threadId, messageId: copy.id, at: copy.receivedAt.toISOString() } : null,
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
 * senza progetto. Le task nate dalle proposte già confermate, per data della
 * decisione e senza doppi; quante task propongono quelle ancora aperte che
 * chi guarda riceve (o che gli sono state passate).
 */
async function tasksOf(db: Db, viewerId: string, noteId: string | null, projectId: string | null, today: string): Promise<MeetingTasks> {
  if (!projectId || !(await projectPermissionsOfUser(db, viewerId, projectId))) return null;
  if (!noteId) return { tasks: [], proposedTasks: 0 };
  const proposals = await db
    .select({ proposal: emailProposals, recipient: emailProposalRecipients.userId })
    .from(emailProposals)
    .leftJoin(emailProposalRecipients, and(eq(emailProposalRecipients.proposalId, emailProposals.id), eq(emailProposalRecipients.userId, viewerId)))
    .where(and(eq(emailProposals.meetingNoteId, noteId), eq(emailProposals.projectId, projectId)));
  const ids = new Set<string>();
  let proposedTasks = 0;
  for (const { proposal, recipient } of proposals.sort((a, b) => (a.proposal.decidedAt?.getTime() ?? 0) - (b.proposal.decidedAt?.getTime() ?? 0))) {
    for (const r of proposal.results ?? []) if (r.kind === "task" && r.id) ids.add(r.id);
    const open = proposal.status === "classified" || proposal.status === "proposed";
    if (open && (recipient || proposal.handedAt)) {
      const actions = (proposal.classification as { actions?: { type: string }[] }).actions ?? [];
      proposedTasks += actions.filter((a) => a.type === "create_task").length;
    }
  }
  if (ids.size === 0) return { tasks: [], proposedTasks };
  const rows = await db
    .select({ id: tickets.id, number: tickets.number, title: tickets.title, status: tickets.status, dueDate: tickets.dueDate, departmentId: tickets.departmentId, code: projects.code })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(inArray(tickets.id, [...ids]), eq(tickets.projectId, projectId)));
  const order = [...ids];
  const tasks: MeetingTask[] = rows
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map((t) => {
      const done = t.status === "done" || t.status === "closed";
      return {
        kind: "task" as const,
        id: t.id,
        code: t.code ? `${t.code}-${t.number}` : null,
        title: t.title,
        status: done ? ("done" as const) : t.dueDate && t.dueDate < today ? ("late" as const) : ("open" as const),
        inProgress: t.status === "in_progress",
        dueDate: t.dueDate,
        departmentId: t.departmentId,
      };
    });
  return { tasks, proposedTasks };
}

/** Le task di una riga del calendario di chi guarda; `undefined` = la riga non è sua (404). */
export async function meetingTasksFor(db: Db, viewerId: string, rowId: string, today: string): Promise<MeetingTasks | undefined> {
  const found = await noteForEventRow(db, viewerId, rowId);
  if (!found) return undefined;
  return tasksOf(db, viewerId, found.noteId, found.row.projectId, today);
}

/** Le task di una riunione per id (l'invitato senza l'evento); `undefined` = non è fra chi la vede (404). */
export async function meetingTasksByNote(db: Db, viewerId: string, noteId: string, today: string): Promise<MeetingTasks | undefined> {
  const note = await noteById(db, noteId);
  if (!note || !(await canSeeMeeting(db, note.id, viewerId))) return undefined;
  return tasksOf(db, viewerId, note.id, note.projectId, today);
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
