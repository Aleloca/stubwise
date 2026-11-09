import type { AppNotification } from "../../types";
import { PEOPLE } from "../people";
import { CHAT_CHANNELS } from "./channels";
import { CHAT_MESSAGES } from "./messages";
import { CHAT_READ_STATES } from "./reads";

// Le notifiche di menzione del seme: per ogni menzione diretta (o domanda)
// che una persona non ha ancora letto, la riga che `sendMessage` avrebbe
// scritto allora. Solo chi è membro del canale (e quindi lo legge): un
// privato o un DM non avvisano chi sta fuori. Titolo, testo e link si
// derivano a lettura dal messaggio (`presentChatNotification`), come per
// quelle nuove; qui restano vuoti.

const named = (text: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text);
};

const readOf = new Map(CHAT_READ_STATES.map((r) => [`${r.personId}:${r.channelId}`, r]));
const channelOf = new Map(CHAT_CHANNELS.map((c) => [c.id, c]));

export const CHAT_NOTIFICATIONS: AppNotification[] = CHAT_MESSAGES.flatMap((m) => {
  if (m.kind !== "person" || m.deletedAt !== null) return [];
  const ch = channelOf.get(m.channelId)!;
  if (ch.archived) return [];
  return PEOPLE.filter(
    (p) =>
      !p.isClaude &&
      p.id !== m.authorId &&
      ch.memberIds.includes(p.id) &&
      (m.asksReplyOf.includes(p.id) || named(m.text, p.name)),
  ).flatMap((p): AppNotification[] => {
    const read = readOf.get(`${p.id}:${ch.id}`);
    if (!read) return [];
    const inFlow = m.threadOf === null || m.alsoInChannel === true;
    const since = inFlow ? read.lastReadAt : (read.threadReads[m.threadOf!] ?? read.lastReadAt);
    if (m.createdAt <= since) return [];
    return [
      {
        id: `n-chat-${m.id}-${p.id}`,
        kind: m.asksReplyOf.includes(p.id) ? "chat.question" : "chat.mention",
        projectId: ch.projectId,
        objectCode: "",
        departmentId: null,
        recipientIds: [p.id],
        title: "",
        body: "",
        createdAt: m.createdAt,
        read: false,
        archived: false,
        snoozedUntil: null,
        link: "",
        chatMessageId: m.id,
      },
    ];
  });
});
