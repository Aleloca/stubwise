import { fold, MIN_QUERY, searchWords } from "../../pages/chat/search";
import { copy, gate, now, state, visibleProjectIds } from "../store";
import type {
  MailboxView,
  MailClassification,
  MailImportance,
  MailMessage,
  MailMessageView,
  MailSearchHit,
  MailThreadDetail,
  MailThreadFilters,
  MailThreadRow,
} from "../types";
import { canSeeMailProposal, visibleMessages } from "./visibility";

// Le letture della Posta (area 6). Chi vede che cosa lo decide
// `visibility.ts`: ogni riga, conteggio e risultato si calcola sui soli
// messaggi che chi guarda vede, e nomina solo i progetti che può vedere.
// Nessuna lettura segna un messaggio come letto: lo fa `markRead`.

/** Oltre questa distanza dall'ultimo allineamento una casella è «vecchia». */
export const MAIL_STALE_MS = 5 * 60_000;

const RANK: Record<MailImportance, number> = { high: 3, normal: 2, low: 1 };

const notFound = () => new Error("not_found");

/** La classificazione come la vede chi guarda: solo i progetti che vede. */
function classificationFor(me: string, c: MailClassification): MailClassification {
  if (c.state !== "done") return { ...c };
  const visible = visibleProjectIds(me);
  return {
    ...c,
    projectIds: c.projectIds.filter((id) => visible.has(id)),
    uncertainProjectIds: c.uncertainProjectIds.filter((id) => visible.has(id)),
  };
}

function messageView(me: string, m: MailMessage): MailMessageView {
  const rest: Omit<MailMessage, "readByPersonIds"> & { readByPersonIds?: string[] } = copy(m);
  delete rest.readByPersonIds;
  return {
    ...rest,
    classification: classificationFor(me, m.classification),
    read: m.readByPersonIds.includes(me),
  };
}

const byTime = (a: MailMessage, b: MailMessage) => a.at.localeCompare(b.at);

/** I messaggi visibili raggruppati per conversazione, ognuna dal più vecchio. */
function threadsOf(messages: MailMessage[]): Map<string, MailMessage[]> {
  const threads = new Map<string, MailMessage[]>();
  for (const m of [...messages].sort(byTime)) {
    const list = threads.get(m.threadId) ?? [];
    list.push(m);
    threads.set(m.threadId, list);
  }
  return threads;
}

/** Il testo in cui si cerca: oggetto, mittente e corpo. */
const searchable = (m: MailMessage) =>
  fold(`${m.subject}\n${m.from.name} ${m.from.email}\n${m.text}`);

const matchesAll = (text: string, words: string[]) => words.every((w) => text.includes(w));

function threadRow(me: string, messages: MailMessage[]): MailThreadRow {
  const visible = visibleProjectIds(me);
  const done = messages.flatMap((m) =>
    m.classification.state === "done" ? [m.classification] : [],
  );
  const participants = new Map<string, MailMessage["from"]>();
  for (const m of messages)
    if (!participants.has(m.from.email)) participants.set(m.from.email, m.from);
  const projectIds = new Set(done.flatMap((c) => c.projectIds).filter((id) => visible.has(id)));
  const importance = done.reduce<MailImportance | null>(
    (best, c) => (best === null || RANK[c.importance] > RANK[best] ? c.importance : best),
    null,
  );
  const dueDates = done.flatMap((c) => (c.dueDate ? [c.dueDate] : [])).sort();
  const rfcIds = new Set(messages.map((m) => m.messageId));
  return {
    threadId: messages[0]!.threadId,
    subject: messages[0]!.subject,
    lastAt: messages[messages.length - 1]!.at,
    participants: [...participants.values()].map(copy),
    projectIds: [...projectIds],
    importance,
    dueDate: dueDates[0] ?? null,
    unread: messages.filter((m) => !m.readByPersonIds.includes(me)).length,
    openProposals: state.mailProposals.filter(
      (p) => p.status === "open" && rfcIds.has(p.sourceId) && canSeeMailProposal(me, p),
    ).length,
    analysing: messages.some((m) => m.classification.state === "pending"),
  };
}

/** Le righe dell'elenco per chi guarda, dalla più recente. */
function rowsFor(me: string, filters: MailThreadFilters): MailThreadRow[] {
  let messages = visibleMessages(me);
  if (filters.mailbox !== undefined) {
    const box = state.mailboxes.find((b) => b.email === filters.mailbox && b.personId === me);
    messages = box ? messages.filter((m) => m.mailboxPersonIds.includes(box.personId)) : [];
  }
  const words = filters.q ? searchWords(filters.q) : [];
  return [...threadsOf(messages).values()]
    .filter((list) => words.length === 0 || matchesAll(list.map(searchable).join("\n"), words))
    .map((list) => threadRow(me, list))
    .filter(
      (r) =>
        (filters.importance === undefined || r.importance === filters.importance) &&
        (filters.projectId === undefined || r.projectIds.includes(filters.projectId)),
    )
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.threadId.localeCompare(b.threadId));
}

/**
 * L'elenco della Posta per conversazione: filtri per casella (solo le mie),
 * importanza (quella della riga, la più alta), progetto (fra quelli che
 * vedo) e testo (tutte le parole, senza accenti).
 */
export async function listMailThreads(filters: MailThreadFilters = {}): Promise<MailThreadRow[]> {
  const me = await gate("mail.listMailThreads");
  return rowsFor(me, filters);
}

/**
 * Una conversazione: i messaggi che chi guarda vede, dal più vecchio. Un
 * thread di cui non vede nessun messaggio è `not_found`, come uno che non
 * esiste (R-G5). Note della riunione (Task 6) e proposte (Task 3) si
 * aggiungono qui.
 */
export async function getMailThread(threadId: string): Promise<MailThreadDetail> {
  const me = await gate("mail.getMailThread");
  const messages = visibleMessages(me)
    .filter((m) => m.threadId === threadId)
    .sort(byTime);
  if (messages.length === 0) throw notFound();
  return {
    threadId,
    subject: messages[0]!.subject,
    messages: messages.map((m) => messageView(me, m)),
  };
}

/** Le mie caselle, con quanto sono aggiornate e se il collegamento è scaduto. */
export async function listMailboxes(): Promise<MailboxView[]> {
  const me = await gate("mail.listMailboxes");
  const at = Date.parse(now());
  return state.mailboxes
    .filter((b) => b.personId === me)
    .map((b) => ({
      ...copy(b),
      stale: at - Date.parse(b.syncedAt) > MAIL_STALE_MS,
      expired: state.googleAccounts.find((a) => a.personId === me)?.status === "expired",
    }));
}

/**
 * «Email importanti» per la Home: le conversazioni con almeno un messaggio
 * di importanza alta che non ho letto, dalla più recente.
 */
export async function listImportantMail(): Promise<MailThreadRow[]> {
  const me = await gate("mail.listImportantMail");
  const threads = new Set(
    visibleMessages(me)
      .filter(
        (m) =>
          m.classification.state === "done" &&
          m.classification.importance === "high" &&
          !m.readByPersonIds.includes(me),
      )
      .map((m) => m.threadId),
  );
  return rowsFor(me, {}).filter((r) => threads.has(r.threadId));
}

/** La ricerca nella posta (⌘K): da 2 caratteri, tutte le parole, dal più recente. */
export async function searchMail(q: string): Promise<MailSearchHit[]> {
  const me = await gate("mail.searchMail");
  if (q.trim().length < MIN_QUERY) return [];
  const words = searchWords(q);
  return visibleMessages(me)
    .filter((m) => matchesAll(searchable(m), words))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      threadId: m.threadId,
      subject: m.subject,
      from: copy(m.from),
      at: m.at,
      snippet: m.text.replace(/\s+/g, " ").slice(0, 140),
    }));
}
