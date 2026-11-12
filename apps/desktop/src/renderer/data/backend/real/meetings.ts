import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import type { MeetingSummary, MeetingTask } from "../../types";
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
