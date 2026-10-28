import type { ChannelNotifyPref, ChatMessage, ReadState } from "../../types";
import { CHAT_CHANNELS } from "./channels";
import { at } from "./helpers";
import { CHAT_MESSAGES } from "./messages";

// Fin dove ognuno ha letto. Di base tutto letto (fino all'ultimo messaggio
// del canale e, nei thread a cui si partecipa, all'ultima risposta); le
// eccezioni qui sotto danno alle persone «vedi come» non letti,
// menzioni e thread con novità diversi.

/** Persona → canale → letto fino a. */
const CHANNEL_READS: Record<string, Record<string, string>> = {
  "p-giulia": {
    "ch-aud-general": at(1, "17:00"),
    "ch-mkx-general": at(1, "12:00"),
    "ch-mkx-grafica": at(1, "12:00"),
    "dm-giulia-marco": at(1, "00:00"),
    "ch-announcements": at(1, "00:00"),
  },
  "p-marco": {
    "ch-aud-general": at(0, "09:45"),
  },
  "p-laura": {
    "ch-aud-general": at(2, "12:00"),
    "ch-announcements": at(7, "00:00"),
  },
  "p-sara": {
    "ch-stw-general": at(2, "12:00"),
    "dm-launch-week": at(1, "00:00"),
  },
  "p-roberta": {
    "ch-chit-chat": at(1, "15:00"),
    "dm-giulia-roberta": at(1, "12:00"),
  },
  "p-matteo": {
    "dm-elena-matteo": at(1, "00:00"),
  },
};

/** Persona → radice del thread → letto fino a (i thread con risposte nuove). */
const THREAD_READS: Record<string, Record<string, string>> = {
  // Chiara ha risposto alla domanda di Giulia sulla foto.
  "p-giulia": { "ch-mkx-grafica-m4": at(2, "00:00") },
  // La risposta di @Claude che Marco ha chiamato è arrivata dopo.
  "p-marco": { "ch-aud-general-m17": at(0, "09:40") },
  // Davide ha risposto di nuovo nel thread della guida.
  "p-laura": { "ch-stw-general-m3": at(20, "11:00") },
};

const byChannel = new Map<string, ChatMessage[]>();
for (const m of CHAT_MESSAGES) {
  const list = byChannel.get(m.channelId) ?? [];
  list.push(m);
  byChannel.set(m.channelId, list);
}

const latest = (list: ChatMessage[], fallback: string) =>
  list.reduce((max, m) => (m.createdAt > max ? m.createdAt : max), fallback);

/** I thread (radice → ultima risposta) a cui una persona partecipa in un canale. */
function threadsOf(personId: string, list: ChatMessage[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const root of list.filter((m) => m.threadOf === null)) {
    const replies = list.filter((m) => m.threadOf === root.id);
    if (replies.length === 0) continue;
    const inIt =
      root.authorId === personId ||
      replies.some((r) => r.authorId === personId || r.calledById === personId);
    if (inIt) out[root.id] = latest(replies, root.createdAt);
  }
  return out;
}

export const CHAT_READ_STATES: ReadState[] = CHAT_CHANNELS.flatMap((channel) => {
  const list = byChannel.get(channel.id) ?? [];
  return channel.memberIds.map((personId) => ({
    personId,
    channelId: channel.id,
    lastReadAt: CHANNEL_READS[personId]?.[channel.id] ?? latest(list, channel.createdAt),
    threadReads: { ...threadsOf(personId, list), ...pick(THREAD_READS[personId], list) },
  }));
});

/** Le eccezioni sui thread che stanno in questo canale. */
function pick(reads: Record<string, string> | undefined, list: ChatMessage[]) {
  if (!reads) return {};
  return Object.fromEntries(
    Object.entries(reads).filter(([rootId]) => list.some((m) => m.id === rootId)),
  );
}

/** Le preferenze di notifica diverse da «tutti i messaggi». */
export const CHAT_NOTIFY_PREFS: ChannelNotifyPref[] = [
  { personId: "p-marco", channelId: "ch-chit-chat", level: "muted" },
  { personId: "p-giulia", channelId: "ch-chit-chat", level: "muted" },
  { personId: "p-sara", channelId: "ch-announcements", level: "mentions" },
  { personId: "p-laura", channelId: "ch-aud-releases", level: "mentions" },
];
