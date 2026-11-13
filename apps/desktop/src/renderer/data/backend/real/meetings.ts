import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import type { MeetingDocReason, MeetingNote, MeetingSummary, MeetingTask } from "../../types";
import { googleDocUrl } from "../../googleDoc";
import { appClient } from "./client";

// Le riunioni registrate nella build app (area 6, F5a), sopra i metodi di
// `client.calendar` di 72 (`eventSummary`, `eventTasks`, `meeting`,
// `meetingTasks`). Chi vede cosa lo decide il SERVER — tutti gli invitati di
// Stubwise, mai un membro che non c'era né un admin (decisione M) —: qui un
// 404 vuol dire «non lo sai», e la pagina non dice nemmeno che un riassunto
// esista. La trascrizione intera non arriva mai al client.

type Mail = typeof Fake.mail;
type ServerSummary = Awaited<ReturnType<ReturnType<typeof appClient>["calendar"]["eventSummary"]>>;

/** Una lettura che il server può non avere (un server di prima) o non mostrare (404): `null`. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export const getMeetingSummary: Mail["getMeetingSummary"] = async (eventId) =>
  summaryView(await orNull(() => appClient().calendar.eventSummary(eventId)));

/**
 * La riunione per nota (F5a, Q-A = a): lo stesso riassunto, per l'invitato
 * che ci arriva senza l'email di Gemini o senza l'evento (`eventId` è quello
 * di chi guarda, o null). 404 a chi non c'era.
 */
const getMeetingByNote: Mail["getMeetingByNote"] = async (noteId) =>
  summaryView(await orNull(() => appClient().calendar.meeting(noteId)));

function summaryView(s: ServerSummary | null): MeetingSummary | null {
  if (!s) return null;
  return {
    ...(s.noteId ? { noteId: s.noteId } : {}),
    eventId: s.eventId ?? null,
    docTitle: s.docTitle ?? "",
    // Un valore che il client non conosce (un server più nuovo) si legge come «non si legge».
    doc: s.doc === "reading" || s.doc === "ready" ? s.doc : "unreachable",
    summary: s.summary ?? null,
    transcript: null,
    docReason: s.docReason && DOC_REASONS.has(s.docReason) ? (s.docReason as MeetingDocReason) : null,
    // Solo un link di Google Docs (review F5a, 5), come sul messaggio.
    docUrl: googleDocUrl(s.docUrl),
    // L'email di Gemini, se chi guarda la vede: `sourceId` è il messaggio, come per le proposte.
    email: s.email
      ? { threadId: s.email.threadId, sourceId: s.email.messageId, at: s.email.at }
      : null,
  };
};

/**
 * Le task nate dalla riunione e quante ne sono ancora proposte, solo ai
 * membri del progetto (R-I21): `null` agli altri (e a un server di prima).
 */
export async function meetingTasksOf(
  eventId: string,
): Promise<{ tasks: MeetingTask[]; proposedTasks: number } | null> {
  return tasksView(await orNull(() => appClient().calendar.eventTasks(eventId)));
}

type ServerTasks = Awaited<ReturnType<ReturnType<typeof appClient>["calendar"]["eventTasks"]>>;

function tasksView(out: ServerTasks | null): { tasks: MeetingTask[]; proposedTasks: number } | null {
  if (!out) return null;
  return {
    tasks: (out.tasks ?? []).map((t) => ({
      kind: t.kind === "request" ? "request" : "task",
      id: t.id,
      // Una richiesta nata da poco può non avere ancora il codice.
      code: t.code ?? "",
      title: t.title,
      status: t.status === "done" || t.status === "late" ? t.status : "open",
      inProgress: t.inProgress === true,
      dueDate: t.dueDate ?? null,
      departmentId: t.departmentId ?? null,
    })),
    proposedTasks: out.proposedTasks ?? 0,
  };
}

/** Le task nate dalla riunione, solo ai membri del progetto (R-I21): `null` agli altri. */
const tasksBornFrom: Mail["tasksBornFrom"] = async (eventId) =>
  (await meetingTasksOf(eventId))?.tasks ?? null;

/** Le task per nota (F5a): le stesse regole (R-I21), per l'invitato senza l'evento. */
const tasksOfNote: Mail["tasksOfNote"] = async (noteId) =>
  tasksView(await orNull(() => appClient().calendar.meetingTasks(noteId)))?.tasks ?? null;

export const meetingFunctions: Partial<Mail> = {
  getMeetingSummary,
  getMeetingByNote,
  tasksBornFrom,
  tasksOfNote,
};

type ServerMeetingNote = {
  noteId?: string;
  docTitle?: string | null;
  doc?: "reading" | "ready" | "unreachable" | null;
  docReason?: string | null;
  visible?: boolean;
  summary?: string | null;
  docUrl?: string | null;
  event?: MeetingNote["event"];
};

const DOC_REASONS: ReadonlySet<string> = new Set([
  "scope_missing",
  "not_shared",
  "deleted",
  "too_long",
]);

/**
 * L'email di Gemini sul messaggio (F5a, forme di 72): il server la deriva a
 * lettura. Chi non c'era (`visible` falso) non ha titolo, riassunto né link,
 * qualunque cosa arrivi; il testo intero non arriva mai (`transcript: null`):
 * «Open the transcript» apre il Doc, e solo un link di Google Docs.
 */
export function meetingOfMessage(m: { kind?: string; meeting?: ServerMeetingNote | null }): {
  kind: "email" | "transcript";
  meeting?: MeetingNote;
} {
  const n = m.meeting;
  if (m.kind !== "transcript" || !n) return { kind: "email" };
  const visible = n.visible === true;
  return {
    kind: "transcript",
    meeting: {
      ...(n.noteId ? { noteId: n.noteId } : {}),
      docTitle: visible ? (n.docTitle ?? null) : null,
      doc: n.doc ?? null,
      ...(n.docReason && DOC_REASONS.has(n.docReason)
        ? { docReason: n.docReason as MeetingDocReason }
        : {}),
      visible,
      summary: visible ? (n.summary ?? null) : null,
      transcript: null,
      docUrl: visible ? googleDocUrl(n.docUrl) : null,
      event: n.event ?? null,
    },
  };
}
