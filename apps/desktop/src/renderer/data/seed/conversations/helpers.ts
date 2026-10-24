import type { Conversation, ConversationEvent } from "../../types";
import { daysFromToday } from "../dates";

/** Data-ora ISO a `days` giorni fa (0 = oggi), all'ora `hm` («HH:MM», UTC). */
export function at(days: number, hm: string): string {
  return `${daysFromToday(-days)}T${hm}:00Z`;
}

/** Un evento senza id: l'id lo dà `seeded`, in ordine, dalla conversazione. */
export type Draft = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? Omit<E, "id">
    : never
  : never;

export interface Seeded {
  conversation: Conversation;
  events: ConversationEvent[];
}

type Meta = Pick<Conversation, "id" | "kind" | "title" | "ownerId" | "state"> &
  Partial<Omit<Conversation, "id" | "kind" | "title" | "ownerId" | "state">>;

/**
 * Una conversazione seminata col suo flusso. Le date di creazione e di
 * aggiornamento, se non date, sono quelle del primo e dell'ultimo evento;
 * la visibilità di base segue il tipo (libera e posta private, le altre
 * sessioni seguono il progetto).
 */
export function seeded(meta: Meta, drafts: Draft[]): Seeded {
  const events = drafts.map((d, i) => ({ ...d, id: `${meta.id}-e${i + 1}` }) as ConversationEvent);
  const conversation: Conversation = {
    projectId: null,
    contextProjectId: null,
    taskId: null,
    requestId: null,
    outcome: null,
    visibility: meta.kind === "free" || meta.kind === "mail_classify" ? "private" : "project",
    publishedAt: null,
    publishedById: null,
    touchedProjectIds: [],
    privateFromIndex: null,
    continuesFromId: null,
    createdAt: events[0]!.at,
    updatedAt: events.at(-1)!.at,
    archived: false,
    ...meta,
  };
  return { conversation, events };
}

/** Un'azione di Claude già conclusa (la forma più comune nel flusso). */
export function done(
  at: string,
  tool: string,
  label: string,
  extra: { input?: string; result?: string; truncated?: boolean } = {},
): Draft {
  return { at, type: "action", tool, label, state: "done", ...extra };
}

/** Un messaggio di Claude completo. */
export function says(at: string, text: string): Draft {
  return { at, type: "assistant", text, done: true };
}

/** Un messaggio di una persona, consegnato e senza allegati. */
export function asks(at: string, authorId: string, text: string): Draft {
  return { at, type: "user", authorId, text, attachments: [], delivery: "delivered" };
}
