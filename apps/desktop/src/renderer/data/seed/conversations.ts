import type { Conversation, ConversationEvent } from "../types";
import { AUTOMATIC_CONVERSATIONS } from "./conversations/automatic";
import { FREE_CONVERSATIONS } from "./conversations/free";
import type { Seeded } from "./conversations/helpers";
import { WORK_CONVERSATIONS } from "./conversations/work";

// Le conversazioni con Claude del seed: libere, sessioni di lavoro (task e
// refine) e sessioni automatiche, ognuna col suo flusso di eventi già
// accaduti. I file in `conversations/` le scrivono per famiglia.

const ALL: Seeded[] = [...FREE_CONVERSATIONS, ...WORK_CONVERSATIONS, ...AUTOMATIC_CONVERSATIONS];

export const CONVERSATIONS: Conversation[] = ALL.map((s) => s.conversation);

/** Il flusso di ogni conversazione, per id, in ordine di tempo. */
export const CONVERSATION_EVENTS: Record<string, ConversationEvent[]> = Object.fromEntries(
  ALL.map((s) => [s.conversation.id, s.events]),
);
