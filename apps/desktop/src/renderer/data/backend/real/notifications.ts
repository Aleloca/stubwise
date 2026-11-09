import type { InboxItem, SnoozeUntil } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { AppNotification } from "../../types";
import { daysFromToday } from "./clock";
import { appClient } from "./client";

// Le notifiche della build app (integrazione area 2, fetta 1): la stessa
// inbox del web vecchio e del mobile (`/api/inbox`), con lo stato «letta»
// condiviso. Si mostrano TUTTE le card: quelle delle aree integrate aprono
// la task nel pannello; le altre (piani, domande di Claude, proposte della
// posta e del pulse… e ogni kind che questa app non conosce) aprono la pagina
// del web vecchio («Open in web»).

/** I kind che l'app nuova risolve sul posto: aprono il pannello della task. */
export const INTEGRATED_KINDS: ReadonlySet<string> = new Set([
  "decision.requested",
  "decision.answered",
  "ticket.activity",
]);

export interface PresentContext {
  /** `ticketId` → codice della task (`AUD-12`), letto dal server a lettura. */
  taskCodes: ReadonlyMap<string, string>;
  /** `projectId` → codice del progetto. */
  projectCodes: ReadonlyMap<string, string>;
}

/** Il percorso del web vecchio di una card, come lo apre la sua inbox (`inbox-item.tsx`). */
export function webHrefFor(item: Pick<InboxItem, "kind" | "url" | "jobId" | "ticketId">): string {
  if (item.kind === "job.awaiting_input" && item.jobId && item.ticketId) {
    return `/agents/job/${item.jobId}?ticketId=${item.ticketId}`;
  }
  if (item.url) {
    try {
      const url = new URL(item.url, "http://instance.invalid");
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      // un url illeggibile: si ripiega sul ticket o sull'inbox
    }
  }
  if (item.ticketId) return `/tickets/${item.ticketId}`;
  return "/inbox";
}

/** Una card dell'inbox come notifica del prototipo. Non lancia mai, nemmeno su un kind ignoto. */
export function presentInboxItem(item: InboxItem, ctx: PresentContext): AppNotification {
  const taskCode = item.ticketId ? ctx.taskCodes.get(item.ticketId) : undefined;
  const projectCode = item.projectId ? ctx.projectCodes.get(item.projectId) : undefined;
  const integrated = INTEGRATED_KINDS.has(item.kind) && taskCode !== undefined && projectCode !== undefined;
  return {
    id: item.id,
    kind: item.kind,
    projectId: item.projectId,
    objectCode: taskCode ?? projectCode ?? "",
    departmentId: null,
    recipientIds: [],
    title: item.text,
    body: item.summary ?? "",
    createdAt: item.createdAt,
    read: item.readAt !== null,
    archived: item.status === "handled",
    snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
    link: integrated ? `#/p/${projectCode}/tasks?task=${taskCode}` : "",
    ...(integrated ? {} : { webHref: webHrefFor(item) }),
  };
}

const PAGE = 100;

export const listNotifications: typeof Fake.listNotifications = async () => {
  const client = appClient();
  const [open, snoozed, handled, projects] = await Promise.all([
    client.inbox.list({ status: "open" }, undefined, PAGE),
    client.inbox.list({ status: "snoozed" }, undefined, PAGE),
    client.inbox.list({ status: "handled" }, undefined, 50),
    client.projects.list(),
  ]);
  const items = [...open.items, ...snoozed.items, ...handled.items] as InboxItem[];
  const projectCodes = new Map(
    (projects as unknown as { id: string; slug: string; code?: string }[]).map((p) => [
      p.id,
      p.code ?? p.slug.toUpperCase(),
    ]),
  );
  // Il codice della task si DERIVA a lettura (numero e codice di adesso),
  // mai dal testo della card: un codice di progetto cambiato non lo sbaglia.
  // Il server lo dà già (`taskCode`, derivato a lettura); da un server che
  // non lo manda ancora si legge il ticket.
  const taskCodes = new Map<string, string>();
  for (const i of items) {
    const code = (i as { taskCode?: string | null }).taskCode;
    if (i.ticketId && code) taskCodes.set(i.ticketId, code);
  }
  const ticketIds = [
    ...new Set(
      items.flatMap((i) =>
        INTEGRATED_KINDS.has(i.kind) && i.ticketId && !taskCodes.has(i.ticketId) ? [i.ticketId] : [],
      ),
    ),
  ];
  const tickets = await Promise.all(ticketIds.map((id) => client.tickets.get(id).catch(() => null)));
  for (const t of tickets) {
    const code = t ? projectCodes.get(t.projectId) : undefined;
    if (t && code) taskCodes.set(t.id, `${code}-${t.number}`);
  }
  return items
    .map((item) => presentInboxItem(item, { taskCodes, projectCodes }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

/** L'istante di un rinvio del prototipo → l'opzione del server (un'ora, domani, tre giorni). */
function snoozeOption(until: string): SnoozeUntil {
  if (until.slice(0, 10) === daysFromToday(1)) return "tomorrow";
  if (Date.parse(until) - Date.now() <= 2 * 3_600_000) return "1h";
  return "3d";
}

/**
 * Letta, archiviata, rinviata. Il server non sa togliere «letta» né
 * ripristinare un'archiviata o una rinviata: quei cambi non si scrivono (il
 * pannello rilegge l'inbox e mostra lo stato vero).
 */
export const markNotification: typeof Fake.markNotification = async (id, change) => {
  const inbox = appClient().inbox;
  if (change.read === true) await inbox.read(id);
  if (change.archived === true) await inbox.handled(id);
  if (typeof change.snoozedUntil === "string") await inbox.snooze(id, snoozeOption(change.snoozedUntil));
};
