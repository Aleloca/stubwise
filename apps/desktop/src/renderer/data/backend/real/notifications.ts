import { ApiError } from "@stubwise/api-client";
import { isPersonPlaceholder, type InboxItem, type SnoozeUntil } from "@stubwise/shared";
import type * as Fake from "../../api";
import { featureIntegrated, isIntegrated } from "../../integration";
import type { AppNotification, MandatoryReason, ProductAnswerChoice } from "../../types";
import { daysFromToday } from "./clock";
import { appClient, session } from "./client";
import { listPeople } from "./people";
import { reasonOf, sourceViewFrom } from "./productClaude";

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
  /** Chi legge: il destinatario di un obbligo (`alertMandatory`). */
  viewerId?: string;
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

/** Le card del monitor che aprono la pagina del server (S12). */
const MONITOR_KINDS: ReadonlySet<string> = new Set(["monitor.alert", "monitor.recovered"]);

export const MANDATORY_REASONS: ReadonlySet<string> = new Set([
  "merged",
  "pr_author",
  "task_author",
  "assignee",
  // Area 8, F4b: chi ha chiesto a mano un'analisi riceve sempre il suo esito.
  "analysis_requester",
  // Area 10, F5: la persona aggiunta a un progetto riceve sempre `member.added`.
  "added",
  // Area 11, F2: chi è menzionato in un commento della doc di prodotto, e chi
  // segue la pagina per le card di Claude (N-1 = a, catalogo di 72).
  "mentioned",
  "follower",
] satisfies MandatoryReason[]);

/**
 * Area 8, F2: una card arrivata a chi legge da OBBLIGATORIO porta il motivo
 * (`alertMandatory`, scritto alla pubblicazione per ogni destinatario): il
 * pannello lo dice («You get this because…») e non offre «Don't alert me».
 * Un motivo che l'app non conosce (server più nuovo) non si mostra.
 */
function mandatoryOf(item: InboxItem, ctx: PresentContext): Pick<AppNotification, "mandatory"> {
  const reason = (item as Partial<InboxItem>).alertMandatory;
  if (!reason || !MANDATORY_REASONS.has(reason)) return {};
  return { mandatory: [{ personId: ctx.viewerId ?? "", reason: reason as MandatoryReason }] };
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
  const m = /^#\/p\/[^/?#]+\/(releases|docs|requests)(\/[^?#]+)?(\?[^#]*)?$/.exec(
    url.hash,
  );
  if (!m) return null;
  const [, section, rest, query] = m;
  if (!isIntegrated({ kind: "projectSection", name: section! })) return null;
  // Area 8, F3: nessuna card porta a Support (`support.customer_replied` è uscito).
  if (section === "requests") {
    // Area 8, F3: la richiesta nel suo pannello (`support.request`), solo `?request=`.
    const params = new URLSearchParams(query ?? "");
    if (rest || [...params.keys()].join() !== "request") return null;
  } else if (section === "releases") {
    const pr = new URLSearchParams(query ?? "").has("pr");
    if (rest && !featureIntegrated("releases")) return null;
    if (pr && !featureIntegrated("releases-prs") && !featureIntegrated("releases")) return null;
  } else if (rest || query) {
    return null;
  }
  return url.hash;
}

/**
 * Area 10, F5 (D-11 = b): `member.added` coi valori che il server deriva a
 * lettura (`memberAdded`): la card del prototipo li compone nella lingua di
 * chi guarda («You've been added…» per chi è entrato, «A added B…» per chi
 * gestisce i membri, `memberName`). Chi è entrato lo dice `addedUserId`.
 * «Undone by» da `undoneBy` (un ingresso di Claude tolto con «Annulla»): per
 * chi era entrato la card non apre più il progetto, che non vede ([SC 16]).
 * Una card di un server di prima, senza `memberAdded`: `null`, il testo del
 * server com'è.
 */
function memberAddedOf(item: InboxItem, ctx: PresentContext, projectCode: string | undefined): AppNotification | null {
  const m = (item as Partial<InboxItem>).memberAdded;
  if (!m) return null;
  const undoneBy = (item as Partial<InboxItem>).undoneBy ?? null;
  const isMe = m.addedUserId === ctx.viewerId;
  const notOpenable = isMe && undoneBy !== null;
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
    link: projectCode && !notOpenable ? `#/p/${projectCode}/overview` : "",
    roleName: m.roleName,
    actorName: m.actorName,
    ...(isMe ? {} : { memberName: m.addedName }),
    ...(notOpenable ? { notOpenable: true } : {}),
    ...mandatoryOf(item, ctx),
    ...viaClaudeOf(item, ctx),
    // R-G5 (lotto 2, M2 di 72): chi annulla e chi guarda non conosce arriva
    // `{ id: "hidden-n", name: "" }`; come `undoneByNameOf` del prototipo,
    // la riga «Undone by» allora non c'è (null), ma la card resta annullata.
    ...(undoneBy ? { undoneByName: undoneBy.name || null } : {}),
  };
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
      // Una card della doc di prodotto sparita non dice né la pagina né il
      // progetto (R-G5, come il prototipo): la frase lo dice senza codice.
      objectCode: item.kind.startsWith("product_doc.") ? "" : (item.taskCode ?? projectCode ?? ""),
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
  // Area 11, F2 (R11-2): la menzione in un commento della doc di prodotto, coi
  // valori che il server deriva a lettura (`item.productDoc`): il titolo di
  // adesso, chi ha scritto (`null` se chi guarda non lo vede), il filo da
  // aprire.
  const productDoc = (item as Partial<InboxItem>).productDoc;
  // Area 11, F5 (Task 5 di 72): le card di Claude sulla doc, `updated` e
  // `question`, da `productDoc.claude` (già vista per chi legge). `updated`
  // porta al primo segno a vista (`?mark=`), altrimenti alla cronologia della
  // revisione (`?history=`), come `updateLink` del prototipo; `question` alla
  // pagina sul filo della domanda.
  if ((item.kind === "product_doc.updated" || item.kind === "product_doc.question") && productDoc?.claude) {
    const page = `#/p/${productDoc.projectCode}/docs/product/${productDoc.pageCode}`;
    const c = productDoc.claude;
    const link =
      item.kind === "product_doc.question"
        ? productDoc.threadRootId
          ? `${page}?comment=${productDoc.threadRootId}`
          : page
        : c.markAnchorId
          ? `${page}?mark=${encodeURIComponent(c.markAnchorId)}`
          : c.revisionId
            ? `${page}?history=${encodeURIComponent(c.revisionId)}`
            : page;
    return {
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      objectCode: productDoc.pageCode,
      departmentId: null,
      recipientIds: [],
      title: item.text,
      body: "",
      createdAt: item.createdAt,
      read: item.readAt !== null,
      archived: item.status === "handled",
      snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
      link,
      productPageTitle: productDoc.pageTitle,
      ...(item.kind === "product_doc.updated" ? { undoneByName: c.undoneByName } : {}),
      productCard: {
        sources: c.sources.map(sourceViewFrom),
        changes: c.changes,
        onBehalfOfName: c.onBehalfOfName,
        // I motivi dell'attesa nelle parole del prototipo (`AiBlock["reason"]`).
        waited: c.waited === "budget" ? "monthly_budget" : c.waited === "paused" ? "queue_paused" : null,
        ...(c.question
          ? {
              question: {
                ...c.question,
                reason: reasonOf(c.question.reason),
                answer: c.question.answer as ProductAnswerChoice | null,
              },
            }
          : {}),
      },
      ...mandatoryOf(item, ctx),
      ...viaClaudeOf(item, ctx),
    };
  }
  if (item.kind === "product_doc.mention" && productDoc) {
    const page = `#/p/${productDoc.projectCode}/docs/product/${productDoc.pageCode}`;
    return {
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      objectCode: productDoc.pageCode,
      departmentId: null,
      recipientIds: [],
      title: item.text,
      // Il testo del commento, derivato dal server (`excerpt`, nullable): il
      // server non manda `summary` per la menzione (review di R11-2, 2).
      body: productDoc.excerpt ?? "",
      createdAt: item.createdAt,
      read: item.readAt !== null,
      archived: item.status === "handled",
      snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
      link: productDoc.threadRootId ? `${page}?comment=${productDoc.threadRootId}` : page,
      productPageTitle: productDoc.pageTitle,
      actorName: productDoc.authorName,
      ...mandatoryOf(item, ctx),
      ...viaClaudeOf(item, ctx),
    };
  }
  // Lotto 4, §2 (D-2.0 del maintainer; 72, 83dff2dc7): la card di una
  // proposta CONDIVISA passata al progetto (`google.sourceProposalId`) si
  // mostra come nel prototipo: apre la Home, dove la proposta è in «Da
  // decidere», col testo composto dalla card. Chi l'ha passata da
  // `google.handedByUser` (il nome solo se chi guarda lo conosce: un
  // segnaposto o un nome null è «Someone»); «Already decided» da
  // `google.proposalDecided`, derivato dal server (una card archiviata a mano
  // non è una decisione). Una card di PRIMA resta «Open in web».
  const handed = item.kind === "google.proposal_handed" ? (item as Partial<InboxItem>).google : undefined;
  if (handed?.sourceProposalId && isIntegrated({ kind: "destination", name: "mail" })) {
    const by = handed.handedByUser ?? null;
    return {
      id: item.id,
      kind: item.kind,
      projectId: item.projectId,
      objectCode: projectCode ?? "",
      departmentId: null,
      recipientIds: [],
      title: "",
      body: "",
      createdAt: item.createdAt,
      read: item.readAt !== null,
      archived: item.status === "handled",
      snoozedUntil: item.status === "snoozed" ? item.snoozedUntil : null,
      link: "#/home",
      actorName: by && !isPersonPlaceholder(by.id) ? by.name : null,
      ...(handed.proposalDecided === true ? { proposalDecided: true } : {}),
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
  // Area 8, F4a (S12): una card del monitor apre il server nell'app per codice
  // (derivato a lettura dal server): nel progetto dell'ancora, o
  // nell'Amministrazione senza ancora (zero o più progetti: `monitor.manage`).
  // Senza codice (un server rimosso) resta «Open in web» (I1).
  // Area 8, F4b: «Diagnosis ready» apre la sua task; senza task (causa non
  // determinata, fallita, bloccata, o una task che chi legge non vede) la
  // pagina del server, come le card del monitor.
  const diagnosis = item.kind === "server.diagnosis_ready";
  const diagnosisTask = diagnosis && item.ticketId ? ctx.taskCodes.get(item.ticketId) : undefined;
  const serverLink =
    diagnosisTask && projectCode
      ? `#/p/${projectCode}/tasks?task=${diagnosisTask}`
      : (MONITOR_KINDS.has(item.kind) || diagnosis) &&
          item.serverCode &&
          isIntegrated({ kind: "projectSection", name: "servers" })
      ? projectCode
        ? `#/p/${projectCode}/servers/${item.serverCode}`
        : item.projectId === null && isIntegrated({ kind: "admin", name: "servers" })
          ? `#/admin/servers/${item.serverCode}`
          : null
      : null;
  const appLink = serverLink ?? appLinkFor(item.url, ctx.instanceOrigin);
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
      ...mandatoryOf(item, ctx),
      ...viaClaudeOf(item, ctx),
    };
  }
  const member = item.kind === "member.added" ? memberAddedOf(item, ctx, projectCode) : null;
  if (member) return member;
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
    ...mandatoryOf(item, ctx),
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
    .map((item) => presentInboxItem(item, {
        taskCodes,
        projectCodes,
        instanceOrigin,
        personName,
        ...(session.personId ? { viewerId: session.personId } : {}),
      }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

/** L'istante di un rinvio del prototipo → l'opzione del server (un'ora, domani, tre giorni). */
function snoozeOption(until: string): SnoozeUntil {
  if (until.slice(0, 10) === daysFromToday(1)) return "tomorrow";
  if (Date.parse(until) - Date.now() <= 2 * 3_600_000) return "1h";
  return "3d";
}

/**
 * Letta, archiviata, rinviata; dall'area 9 (F1, R10) anche il ritorno:
 * «non letta» (`unread`), da archiviata a nuova (`restore`), da rinviata a
 * nuova (`move-to-new`). Un passaggio che dallo stato di adesso non ha senso
 * (409 `invalid_state`, per esempio una card chiusa da una decisione) non si
 * scrive: il pannello rilegge l'inbox e mostra lo stato vero.
 */
export const markNotification: typeof Fake.markNotification = async (id, change) => {
  const inbox = appClient().inbox;
  try {
    if (change.read === true) await inbox.read(id);
    if (change.read === false) await inbox.unread(id);
    if (change.archived === true) await inbox.handled(id);
    if (change.archived === false) await inbox.restore(id);
    if (typeof change.snoozedUntil === "string") await inbox.snooze(id, snoozeOption(change.snoozedUntil));
    if (change.snoozedUntil === null) await inbox.moveToNew(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_state") return;
    throw error;
  }
};
