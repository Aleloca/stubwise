import { isOverdue } from "../../domain/due";
import { canReadEvent } from "../calendar/visibility";
import { familyOf, gate, state, visibleProjectIds, visibleTasks } from "../store";
import type {
  CalendarEvent,
  MailMessage,
  MeetingNote,
  MeetingSummary,
  MeetingTask,
  MeetingTranscript,
  ProjectRequest,
  Task,
} from "../types";
import { canSeeMessage, canSeeTranscript, isProjectMember } from "./visibility";

// Le riunioni registrate (area 6): l'email di Gemini, il Google Doc letto e
// le cose da fare nate dalla trascrizione. Riassunto e trascrizione sono
// testo generato e li vede SOLO chi era alla riunione (`canSeeTranscript`);
// le task e le richieste nate sono lavoro vero del progetto e le vedono i
// suoi membri (`memberIds`, R-I21), anche se non c'erano — non chi vede il
// progetto senza esserne membro (un full admin).

const eventOf = (t: MeetingTranscript): CalendarEvent | undefined =>
  t.eventId === null ? undefined : state.calendarEvents.find((e) => e.id === t.eventId);

const messageOf = (t: MeetingTranscript): MailMessage | undefined =>
  state.mailMessages.find((m) => m.id === t.messageId);

export { canSeeTranscript };

/** Riassunto e trascrizione ci sono solo col documento letto. */
const content = (t: MeetingTranscript) =>
  t.doc === "ready"
    ? { summary: t.summary, transcript: t.transcript }
    : { summary: null, transcript: null };

/** Le note di una riunione: la più recente collegata all'evento. */
function transcriptOfEvent(eventId: string): MeetingTranscript | undefined {
  return state.meetingTranscripts
    .filter((t) => t.eventId === eventId)
    .sort((a, b) => (messageOf(a)?.at ?? "").localeCompare(messageOf(b)?.at ?? ""))
    .at(-1);
}

/**
 * Il riassunto di una riunione per `me`; `null` se l'evento non lo legge, se
 * non ha note, o se non c'era. L'email di Gemini solo se la vede.
 */
export function summaryFor(me: string, eventId: string): MeetingSummary | null {
  const e = state.calendarEvents.find((x) => x.id === eventId);
  if (!e || !canReadEvent(me, e)) return null;
  const t = transcriptOfEvent(eventId);
  if (!t || !canSeeTranscript(me, t)) return null;
  const m = messageOf(t);
  return {
    eventId,
    docTitle: t.docTitle,
    doc: t.doc,
    ...content(t),
    email:
      m && canSeeMessage(me, m) ? { threadId: m.threadId, sourceId: m.messageId, at: m.at } : null,
  };
}

function taskItem(t: Task): MeetingTask {
  const family = familyOf(t);
  return {
    kind: "task",
    id: t.id,
    code: t.code,
    title: t.title,
    status: family === "closed" ? "done" : isOverdue(t.dueDate, family) ? "late" : "open",
    inProgress: family === "active",
    dueDate: t.dueDate,
    departmentId: t.departmentId,
  };
}

function requestItem(r: ProjectRequest): MeetingTask {
  return {
    kind: "request",
    id: r.id,
    code: r.code,
    title: r.title,
    status: r.status === "archived" ? "done" : "open",
    inProgress: false,
    dueDate: null,
    departmentId: null,
  };
}

/**
 * Le task e le richieste nate da una riunione, per un membro dei loro
 * progetti (R-I21): i codici creati confermando le proposte delle sue note
 * (`resultCodes`), in ordine di decisione. `visibleTasks` dice se la task
 * esiste ancora per chi guarda; l'appartenenza al progetto, se gli spetta.
 * Una richiesta già convertita compare come le sue task.
 */
export function bornFrom(me: string, eventId: string): MeetingTask[] {
  const sources = new Set(
    state.meetingTranscripts
      .filter((t) => t.eventId === eventId)
      .flatMap((t) => {
        const m = messageOf(t);
        return m ? [m.messageId] : [];
      }),
  );
  const codes = state.mailProposals
    .filter((p) => p.source === "transcript" && sources.has(p.sourceId))
    .sort((a, b) => (a.decidedAt ?? "").localeCompare(b.decidedAt ?? ""))
    .flatMap((p) => p.resultCodes);
  const tasks = new Map(
    visibleTasks(me)
      .filter((t) => isProjectMember(me, t.projectId))
      .map((t) => [t.code, t]),
  );
  const projects = visibleProjectIds(me);
  const out: MeetingTask[] = [];
  const push = (item: MeetingTask) => {
    if (!out.some((x) => x.kind === item.kind && x.id === item.id)) out.push(item);
  };
  for (const code of codes) {
    const task = tasks.get(code);
    if (task) {
      push(taskItem(task));
      continue;
    }
    const request = state.requests.find((r) => r.code === code);
    if (!request || !projects.has(request.projectId) || !isProjectMember(me, request.projectId))
      continue;
    if (request.status !== "converted") {
      push(requestItem(request));
      continue;
    }
    for (const id of request.taskIds) {
      const converted = state.tasksById.get(id);
      if (converted && tasks.has(converted.code)) push(taskItem(converted));
    }
  }
  return out;
}

/**
 * Le note di una riunione sull'email di Gemini, come le legge un suo
 * destinatario: riassunto e trascrizione solo a chi c'era, l'evento solo a
 * chi lo vede.
 */
export function meetingNote(me: string, m: MailMessage): MeetingNote | undefined {
  if (m.kind !== "transcript") return undefined;
  const t = state.meetingTranscripts.find((x) => x.messageId === m.id);
  if (!t) return undefined;
  const visible = canSeeTranscript(me, t);
  const e = eventOf(t);
  return {
    // A chi non c'era nulla del Google Doc: né il titolo né se si legge.
    docTitle: visible ? t.docTitle : null,
    doc: visible ? t.doc : null,
    visible,
    ...(visible ? content(t) : { summary: null, transcript: null }),
    event:
      e && canReadEvent(me, e)
        ? {
            id: e.id,
            title: e.title,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            people: e.attendees.length,
          }
        : null,
  };
}

/**
 * Il riassunto di una riunione passata con le note («Meeting summary»), per
 * chi ha partecipato; `null` per chiunque altro, senza dire se esiste.
 */
export async function getMeetingSummary(eventId: string): Promise<MeetingSummary | null> {
  const me = await gate("mail.getMeetingSummary");
  return summaryFor(me, eventId);
}

/**
 * «Tasks from this meeting»: le task e le richieste nate, per un membro del
 * progetto dell'evento; `null` per chiunque altro (R-I21) — anche per un
 * partecipante che ne legge il riassunto: la sezione per lui non c'è.
 */
export async function tasksBornFrom(eventId: string): Promise<MeetingTask[] | null> {
  const me = await gate("mail.tasksBornFrom");
  const e = state.calendarEvents.find((x) => x.id === eventId);
  if (!e || e.projectId === null || !isProjectMember(me, e.projectId)) return null;
  return bornFrom(me, eventId);
}
