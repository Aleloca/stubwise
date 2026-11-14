import type { InboxItem, SnoozeUntil } from "@stubwise/shared";
import type * as Fake from "../../api";
import { featureIntegrated, isIntegrated } from "../../integration";
import type { AppNotification } from "../../types";
import { daysFromToday } from "./clock";
import { appClient } from "./client";
import { listPeople } from "./people";

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
  // Fetta 2: spostata da altri, ricevuta da altri. Aprono il pannello della task.
  "planning.changed",
  "task.assigned",
]);

export interface PresentContext {
  /**
   * L'origine dell'istanza (`https://stubwise.example.com`): un URL della card
   * con questa origine diventa il suo percorso, uno con un'altra resta
   * assoluto (una PR su GitHub, Gmail, Calendar).
   */
  instanceOrigin?: string;
  /** `ticketId` → codice della task (`AUD-12`), letto dal server a lettura. */
  taskCodes: ReadonlyMap<string, string>;
  /** `projectId` → codice del progetto. */
  projectCodes: ReadonlyMap<string, string>;
  /** Il nome di una persona per chi guarda (`null` se non la vede), per «Claude on behalf of …». */
  personName?: (personId: string) => string | null;
}

/**
 * «via Claude» (chat, fetta 3): il server lo deriva a lettura (azione e
 * richiedente); il nome si risolve qui. Un server vecchio non manda i campi:
 * nessun segno.
 */
function viaClaudeOf(item: InboxItem, ctx: PresentContext): Pick<AppNotification, "viaClaude" | "viaClaudeName"> {
  const { viaClaude, viaClaudeActionId, viaClaudeRequesterId } = item as Partial<InboxItem>;
  if (viaClaude !== true || !viaClaudeActionId || !viaClaudeRequesterId) return {};
  return {
    viaClaude: { personId: viaClaudeRequesterId, actionId: viaClaudeActionId },
    viaClaudeName: ctx.personName?.(viaClaudeRequesterId) ?? null,
  };
}

/**
 * Dove apre una card, come la sua inbox del web vecchio (`inbox-item.tsx`):
 * un percorso dell'istanza, o l'URL assoluto di una pagina fuori
 * dall'istanza (http(s) soltanto).
 */
export function webHrefFor(
  item: Pick<InboxItem, "kind" | "url" | "jobId" | "ticketId">,
  instanceOrigin?: string,
): string {
  if (item.kind === "job.awaiting_input" && item.jobId && item.ticketId) {
    return `/agents/job/${item.jobId}?ticketId=${item.ticketId}`;
  }
  if (item.url) {
    try {
      const relative = item.url.startsWith("/") && !item.url.startsWith("//");
      const url = new URL(item.url, "http://instance.invalid");
      if (relative || url.origin === instanceOrigin) return `${url.pathname}${url.search}${url.hash}`;
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch {
      // un url illeggibile: si ripiega sul ticket o sull'inbox
    }
  }
  if (item.ticketId) return `/tickets/${item.ticketId}`;
  return "/inbox";
}

/**
 * Area 8, F2 (R4): le card dei tipi del catalogo arrivano senza ticket, col
 * link all'app nel campo `url` (`/app/#/p/<PRJ>/…`, il server lo scrive alla
 * pubblicazione). Diventa il percorso nell'app (`#/p/…`) solo se è
 * dell'istanza e porta a una pagina ACCESA in questa build: il rilascio
 * (`releases`), il pannello di una PR (`releases-prs`, `?pr=<repository>#<n>`)
 * e i Docs del progetto. Altrimenti `null`: la card resta «Open in web».
 */
export function appLinkFor(rawUrl: string | null | undefined, instanceOrigin?: string): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl, "http://instance.invalid");
  } catch {
    return null;
  }
  const relative = rawUrl.startsWith("/") && !rawUrl.startsWith("//");
  if (!relative && url.origin !== instanceOrigin) return null;
  if (url.pathname !== "/app/" && url.pathname !== "/app") return null;
  const m = /^#\/p\/[^/?#]+\/(releases|docs)(\/[^?#]+)?(\?[^#]*)?$/.exec(url.hash);
  if (!m) return null;
  const [, section, rest, query] = m;
  if (!isIntegrated({ kind: "projectSection", name: section! })) return null;
  if (section === "releases") {
    const pr = new URLSearchParams(query ?? "").has("pr");
    if (rest && !featureIntegrated("releases")) return null;
    if (pr && !featureIntegrated("releases-prs") && !featureIntegrated("releases")) return null;
  } else if (rest || query) {
    return null;
  }
  return url.hash;
}

/** Una card dell'inbox come notifica del prototipo. Non lancia mai, nemmeno su un kind ignoto. */
export function presentInboxItem(item: InboxItem, ctx: PresentContext): AppNotification {
  const projectCode = item.projectId ? ctx.projectCodes.get(item.projectId) : undefined;
  // La task della card è stata eliminata («Elimina task»): la notifica resta
  // com'era, col codice in testo e senza nessun link (`objectGone`).
  if (item.objectGone) {
    return {
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      objectCode: item.taskCode ?? projectCode ?? "",
      departmentId: null,
      recipientIds: [],
      title: item.text,
      body: item.summary ?? "",
      createdAt: item.createdAt,
      read: item.readAt !== null,
      archived: item.status === "handled",
      snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
      link: "",
      objectGone: true,
      ...viaClaudeOf(item, ctx),
    };
  }
  // Area 4, fetta 1: una menzione della Chat apre il messaggio nel suo canale
  // (o nel suo thread). Tutto derivato a lettura dal server (`item.chat`).
  const chat = (item as Partial<InboxItem>).chat;
  if (item.kind === "chat.mention" && chat) {
    return {
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      objectCode: projectCode ? `${projectCode} · ${chat.channelName}` : chat.channelName,
      departmentId: null,
      recipientIds: [],
      title: item.text,
      body: chat.excerpt,
      createdAt: item.createdAt,
      read: item.readAt !== null,
      archived: item.status === "handled",
      snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
      link: chat.threadRootId
        ? `#/chat/${chat.channelId}?thread=${chat.threadRootId}&message=${chat.messageId}`
        : `#/chat/${chat.channelId}?message=${chat.messageId}`,
      chatMessageId: chat.messageId,
      ...viaClaudeOf(item, ctx),
    };
  }
  // Area 7, F1: una card di un'automazione apre l'esecuzione (o l'automazione),
  // dai campi derivati a lettura (`item.automation`); solo a destinazione
  // accesa, o porterebbe a «in arrivo». Gli indirizzi sono quelli di `routes.ts`.
  const automation = (item as Partial<InboxItem>).automation;
  if (automation && isIntegrated({ kind: "destination", name: "automations" })) {
    const n = automation.runCode ? /#(\d+)$/.exec(automation.runCode)?.[1] : undefined;
    return {
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      objectCode: n ? automation.runCode! : automation.automationCode,
      departmentId: null,
      recipientIds: [],
      title: item.text,
      body: item.summary ?? "",
      createdAt: item.createdAt,
      read: item.readAt !== null,
      archived: item.status === "handled",
      snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
      link: n
        ? `#/automations/${automation.automationCode}/runs/${n}`
        : `#/automations/${automation.automationCode}`,
      ...viaClaudeOf(item, ctx),
    };
  }
  const appLink = appLinkFor(item.url, ctx.instanceOrigin);
  if (appLink) {
    return {
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      objectCode: projectCode ?? "",
      departmentId: null,
      recipientIds: [],
      title: item.text,
      body: item.summary ?? "",
      createdAt: item.createdAt,
      read: item.readAt !== null,
      archived: item.status === "handled",
      snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
      link: appLink,
      ...viaClaudeOf(item, ctx),
    };
  }
  const taskCode = item.ticketId ? ctx.taskCodes.get(item.ticketId) : undefined;
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
    ...(integrated ? {} : { webHref: webHrefFor(item, ctx.instanceOrigin) }),
    ...viaClaudeOf(item, ctx),
  };
}

const PAGE = 100;

/** L'origine dell'istanza: sul desktop quella scelta al primo avvio, sul web questa pagina. */
async function instanceOriginOf(): Promise<string | undefined> {
  try {
    const url = window.stubwise?.instance ? await window.stubwise.instance.get() : window.location.href;
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

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
  const instanceOrigin = await instanceOriginOf();
  // I nomi per «Claude on behalf of …»: le persone si leggono solo se una card è via Claude.
  const people = items.some((i) => (i as Partial<InboxItem>).viaClaude === true)
    ? await listPeople().catch(() => [])
    : [];
  const personName = (personId: string) => people.find((p) => p.id === personId)?.name ?? null;
  return items
    .map((item) => presentInboxItem(item, { taskCodes, projectCodes, instanceOrigin, personName }))
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
