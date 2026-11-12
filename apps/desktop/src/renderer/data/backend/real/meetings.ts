import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import type { MeetingDocReason, MeetingNote, MeetingSummary, MeetingTask } from "../../types";
import { appClient } from "./client";

// Le riunioni registrate nella build app (area 6, F5). Le rotte sono quelle
// della BOZZA del piano (`docs/plans/2026-11-12-integrazione-area6-fetta5-plan.md`,
// branch docs/area6-f5-plan): finché 72 non le fissa e non mette i metodi in
// `client.calendar`, si chiamano con `request`. Chi vede cosa lo decide il
// SERVER — tutti gli invitati di Stubwise, mai un membro che non c'era né un
// admin (decisione M) —: qui un 404 vuol dire «non lo sai», e la pagina non
// dice nemmeno che un riassunto esista. La trascrizione intera non arriva mai
// al client (il prototipo mostra il riassunto e un link al Doc).

type Mail = typeof Fake.mail;
type ServerSummary = {
  eventId: string;
  docTitle: string | null;
  doc: MeetingSummary["doc"] | null;
  summary: string | null;
  docUrl?: string | null;
  email: { threadId: string; messageId: string; at: string } | null;
};

const eventPath = (id: string) => `/api/me/calendar/events/${encodeURIComponent(id)}`;

/** Una lettura che il server può non avere (un server di prima) o non mostrare (404): `null`. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export const getMeetingSummary: Mail["getMeetingSummary"] = async (eventId) => {
  const s = await orNull(
    () =>
      appClient().request("GET", `${eventPath(eventId)}/summary`) as Promise<ServerSummary | null>,
  );
  if (!s) return null;
  return {
    eventId: s.eventId,
    docTitle: s.docTitle ?? "",
    doc: s.doc ?? "unreachable",
    summary: s.summary ?? null,
    transcript: null,
    docUrl: s.docUrl ?? null,
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
  const out = await orNull(
    () =>
      appClient().request("GET", `${eventPath(eventId)}/tasks`) as Promise<{
        tasks?: MeetingTask[];
        proposedTasks?: number;
      } | null>,
  );
  if (!out) return null;
  return {
    tasks: (out.tasks ?? []).map((t) => ({
      kind: t.kind === "request" ? "request" : "task",
      id: t.id,
      code: t.code,
      title: t.title,
      status: t.status,
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

export const meetingFunctions: Partial<Mail> = {
  getMeetingSummary,
  tasksBornFrom,
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
const GOOGLE_DOC = /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:[/?#].*)?$/;

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
      docUrl: visible && n.docUrl && GOOGLE_DOC.test(n.docUrl) ? n.docUrl : null,
      event: n.event ?? null,
    },
  };
}
