import { ApiError } from "@stubwise/api-client";
import { meetingOfMessage } from "./meetings";
import type { MailThreadQuery } from "@stubwise/api-client";
import type { MailThreadDetail as ServerThread, MailThreadItem, MailThreadMessage } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { MailAddress, MailboxView, MailMessageView, MailSearchHit, MailThreadFilters, MailThreadRow } from "../../types";
import { appClient, session } from "./client";
import { myAccounts, requestSync, syncStateOf, whenSynced } from "./google";
import { splitThreadKey, threadKey } from "./mailKeys";
import { mailClaudeDraftFunctions } from "./mailClaudeDraft";
import { mailDraftFunctions } from "./mailDrafts";
import { mailSendFunctions } from "./mailSend";
import { mailProposalFunctions } from "./mailProposals";
import { partialNamespace } from "./notIntegrated";

// La Posta nella build app (area 6, fetta 1): la lettura che il server sa già
// fare (la posta TRATTATA, per conversazione), «Aggiorna ora», e poi le
// proposte per casella e letto/non letto sincronizzato con Gmail. Niente
// importanza né scadenza (F2), niente scrittura (F3).

type Mail = typeof Fake.mail;

/** Una casella non allineata da più di 5 minuti è «vecchia», come nel prototipo. */
const MAIL_STALE_MS = 5 * 60_000;

/** Tutte le mie caselle, una per Workspace (la Posta le mostra tutte, decisione B(a)). */
const listMailboxes: Mail["listMailboxes"] = async () => {
  const at = Date.now();
  return (await myAccounts()).map<MailboxView>((a) => {
    const syncedAt = a.lastSyncAt ?? a.connectedAt;
    return {
      personId: session.personId ?? "",
      email: a.email,
      proposalsEnabled: a.proposalsEnabled,
      syncedAt,
      sync: syncStateOf(a),
      stale: at - Date.parse(syncedAt) > MAIL_STALE_MS,
      // Scaduta è la casella disattivata (token revocato): una a cui mancano solo
      // gli scope nuovi legge ancora, e il cassetto chiede di ricollegarla.
      expired: a.disabledAt !== null,
    };
  });
};

/** «Proposte attive per questa casella»: la casella della sua email; una che non è mia è `not_found`. */
const setProposalsEnabled: Mail["setProposalsEnabled"] = async (email, on) => {
  const account = (await myAccounts()).find((a) => a.email === email);
  if (!account) throw new Error("not_found");
  await appClient().google.setProposals(account.id, on);
};

/** «Aggiorna ora» sulla casella di questa email (F1.2). */
const syncMailbox: Mail["syncMailbox"] = async (email) => {
  const account = (await myAccounts()).find((a) => a.email === email);
  if (!account) throw new Error("not_found");
  await requestSync(account);
};


// --- Le conversazioni -------------------------------------------------------------

/** «Bob Rossi <bob@x.test>» → nome e indirizzo; un indirizzo nudo è anche il nome. Io sono io sul mio indirizzo. */
function addressOf(raw: string, mine: ReadonlySet<string>): MailAddress {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  const email = (m ? m[2]! : raw).trim();
  const name = m && m[1]!.trim() ? m[1]!.trim() : email;
  return { name, email, personId: mine.has(email.toLowerCase()) ? (session.personId ?? null) : null };
}

/** Gli indirizzi delle mie caselle (per riconoscermi fra i destinatari). */
async function myAddresses(): Promise<{ byEmail: Map<string, string>; mine: Set<string> }> {
  const accounts = await myAccounts();
  return {
    byEmail: new Map(accounts.map((a) => [a.email, a.id])),
    mine: new Set(accounts.map((a) => a.email.toLowerCase())),
  };
}

/** I progetti che vedo, per nome: il server dice i nomi dei progetti di una conversazione. */
async function projectIdsByName(): Promise<Map<string, string>> {
  const rows = await appClient().projects.list();
  return new Map(rows.map((p) => [p.name, p.id]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string | undefined): id is string => id !== undefined && UUID.test(id);

/** Quante pagine dell'elenco leggere al più (la posta trattata è corta per costruzione). */
const MAX_THREAD_PAGES = 20;

async function threadItems(options: Omit<MailThreadQuery, "cursor">): Promise<MailThreadItem[]> {
  const items: MailThreadItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_THREAD_PAGES; i++) {
    const page = await appClient().mail.threads({ ...options, cursor });
    items.push(...(page.items as MailThreadItem[]));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

function rowOf(t: MailThreadItem, projects: Map<string, string>, mine: ReadonlySet<string>): MailThreadRow {
  return {
    threadId: threadKey(t.accountId, t.threadId),
    subject: t.subject ?? "",
    lastAt: t.lastReceivedAt,
    participants: [addressOf(t.lastFrom, mine)],
    // Gli id dal server (F2); un server di prima dà solo i nomi.
    projectIds:
      t.projectIds.length > 0 ? [...t.projectIds] : t.projectNames.flatMap((n) => (projects.has(n) ? [projects.get(n)!] : [])),
    // La classificazione nuova (F2): la più alta e la più vicina; null finché nessun messaggio è classificato.
    importance: t.importance,
    dueDate: t.dueDate,
    // Letto/non letto è quello di Gmail (F1.3): la riga dice solo se c'è un non letto.
    unread: t.unread ? 1 : 0,
    openProposals: t.openProposals,
    analysing: t.analysing,
    failed: t.failed,
    messages: t.messageCount,
    attachments: false,
    snippet: t.snippet,
  };
}

/**
 * L'elenco per conversazione, dalla più recente. Casella, ricerca (`q`:
 * oggetto, mittente, estratto), importanza e progetto li filtra il server;
 * importanza e progetto si riguardano qui, per un server di prima che non li
 * conosce (lì nessuna riga ha importanza).
 */
async function threadRows(filters: MailThreadFilters, extra: { important?: boolean } = {}): Promise<MailThreadRow[]> {
  const { byEmail, mine } = await myAddresses();
  let account: string | undefined;
  if (filters.mailbox !== undefined) {
    account = byEmail.get(filters.mailbox);
    if (!account) return [];
  }
  const q = filters.q?.trim() || undefined;
  // Un progetto che l'indirizzo non riconosce (`unknown:<codice>`) non va al server (vuole un uuid):
  // lo esclude il filtro qui sotto.
  const project = isUuid(filters.projectId) ? filters.projectId : undefined;
  const items = await threadItems({ account, q, importance: filters.importance, project, ...extra });
  // Per nome solo con un server di prima (le righe senza `projectIds`): i progetti si leggono allora.
  const byName = items.some((t) => t.projectIds.length === 0 && t.projectNames.length > 0);
  const projects = byName ? await projectIdsByName() : new Map<string, string>();
  return items
    .map((t) => rowOf(t, projects, mine))
    .filter(
      (r) =>
        (filters.projectId === undefined || r.projectIds.includes(filters.projectId)) &&
        (filters.importance === undefined || r.importance === filters.importance),
    )
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.threadId.localeCompare(b.threadId));
}

const listMailThreads: Mail["listMailThreads"] = (filters = {}) => threadRows(filters);

/** «Importanti» e il blocco Home: le conversazioni con un messaggio di importanza alta non letto (F2). */
const listImportantMail: Mail["listImportantMail"] = async () =>
  // Riguardato qui: un server di prima ignora `important` e manderebbe tutto.
  (await threadRows({}, { important: true })).filter((r) => r.importance === "high" && r.unread > 0);

/** La ricerca nella posta (⌘K): da 2 caratteri, una riga per conversazione trovata. */
const searchMail: Mail["searchMail"] = async (q) => {
  if (q.trim().length < 2) return [];
  const rows = await listMailThreads({ q });
  return rows.map<MailSearchHit>((r) => ({
    id: r.threadId,
    threadId: r.threadId,
    subject: r.subject,
    from: r.participants[0]!,
    at: r.lastAt,
    snippet: r.snippet,
  }));
};

/** Per client: le riproposizioni di ogni messaggio letto (`reproposeMessage` riparte da lì). */
const reproposalsSeen = new WeakMap<object, Map<string, MailThreadMessage["reproposals"]>>();
function reproposalsOf(): Map<string, MailThreadMessage["reproposals"]> {
  const client = appClient();
  let map = reproposalsSeen.get(client);
  if (!map) {
    map = new Map();
    reproposalsSeen.set(client, map);
  }
  return map;
}

/**
 * L'analisi «non riuscita» di un messaggio: si può riproporre e non è una
 * scelta di qualcuno — una proposta fallita, o lo smistamento (nessuna
 * proposta). Una proposta ignorata si ripropone dalla sua scheda.
 */
function failedAnalysis(m: MailThreadMessage): boolean {
  if (m.reproposals.length === 0) return false;
  return m.proposalOutcomes.some((o) => o.failed) || m.reproposals.some((r) => r.source === "email_triage");
}

type Original = Awaited<ReturnType<ReturnType<typeof appClient>["mail"]["original"]>>;

/** Quanti originali si chiedono insieme (ogni messaggio è una lettura, spesso da Gmail). */
const ORIGINAL_CONCURRENCY = 4;

/**
 * Per client: gli originali già letti (un messaggio Gmail non cambia dopo
 * l'invio, quindi una volta basta: rileggere la conversazione, anche dopo
 * «letta», non li richiede) e la coda che ne tiene al più 4 in volo. Uno
 * che non si è letto non resta in cache: si riprova alla lettura dopo.
 */
const originals = new WeakMap<object, { done: Map<string, Original>; active: number; queue: (() => void)[] }>();
function originalsOf() {
  const client = appClient();
  let entry = originals.get(client);
  if (!entry) {
    entry = { done: new Map(), active: 0, queue: [] };
    originals.set(client, entry);
  }
  return entry;
}

async function originalOf(id: string): Promise<Original | null> {
  const entry = originalsOf();
  const cached = entry.done.get(id);
  if (cached) return cached;
  if (entry.active >= ORIGINAL_CONCURRENCY) await new Promise<void>((resolve) => entry.queue.push(resolve));
  entry.active++;
  try {
    // `email_triage` è la source dello spazio di id dei MESSAGGI (`email_messages.id`,
    // con la proprietà della casella nella WHERE); `email` vorrebbe l'id di una proposta.
    const body = await appClient().mail.original("email_triage", id);
    entry.done.set(id, body);
    return body;
  } catch {
    return null;
  } finally {
    entry.active--;
    entry.queue.shift()?.();
  }
}

/**
 * La classificazione del messaggio (F2). Un server di prima non la manda
 * (`off`): resta la regola della F1, «fallita» se c'è da riproporre una
 * proposta fallita o uno smistamento.
 */
function classificationOf(m: MailThreadMessage): MailMessageView["classification"] {
  const c = m.classification;
  if (c.state === "done") {
    return {
      state: "done",
      projectIds: [...c.projectIds],
      importance: c.importance ?? "normal",
      dueDate: c.dueDate,
      uncertainProjectIds: [...c.uncertainProjectIds],
    };
  }
  if (c.state === "pending") return { state: "pending" };
  if (c.state === "failed" || failedAnalysis(m)) return { state: "failed" };
  return { state: "off" };
}

async function messageView(
  key: string,
  subject: string,
  gmailUrl: string,
  m: MailThreadMessage,
  mine: ReadonlySet<string>,
): Promise<MailMessageView> {
  // L'originale (riletto da Gmail o dalla cache del server, già sanificato):
  // l'HTML in un frame isolato, gli allegati, le copie. Se non si legge, resta l'estratto.
  const body = await originalOf(m.id);
  return {
    id: m.id,
    // Il Message-ID RFC il server non lo dà: la chiave delle proposte è la riga del messaggio.
    messageId: m.id,
    threadId: key,
    from: addressOf(m.from, mine),
    to: m.to.map((a) => addressOf(a, mine)),
    cc: body && body.cc.length > 0 ? body.cc.map((a) => addressOf(a, mine)) : null,
    subject,
    at: m.receivedAt,
    text: m.textExcerpt ?? body?.bodyText ?? "",
    quoted: null,
    html: body?.bodyHtml ?? null,
    // Il server non dice la dimensione né scarica l'allegato (che si apre su Gmail).
    attachments: (body?.attachments ?? []).map((a, i) => ({ id: `${m.id}:${i}`, name: a.filename, sizeBytes: 0 })),
    // L'email di Gemini (F5a): il server la deriva a lettura. Finché lo schema
    // del client non ha i campi nuovi li scarta, e il messaggio resta un'email.
    ...meetingOfMessage(m as Parameters<typeof meetingOfMessage>[0]),
    context: !m.admitted,
    read: !m.unread,
    // Un mio invio (F3): solo io lo vedo, finché il messaggio vero non arriva.
    ...(m.delivery
      ? {
          delivery: {
            state: m.delivery.state,
            sentById: session.personId ?? "",
            ...(m.delivery.error ? { error: m.delivery.error } : {}),
          },
        }
      : {}),
    proposalIds: m.proposalIds,
    gmailUrl,
    classification: classificationOf(m),
  };
}

/** Una conversazione: i messaggi dal più vecchio. Non mia, o un id senza casella: `not_found`. */
const getMailThread: Mail["getMailThread"] = async (key) => {
  const parts = splitThreadKey(key);
  if (!parts) throw new Error("not_found");
  let t: ServerThread;
  try {
    t = (await appClient().mail.thread(parts.threadId, parts.accountId)) as ServerThread;
  } catch (error) {
    // Un id malformato (400 di validazione) è una conversazione che non c'è.
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) throw new Error("not_found");
    throw error;
  }
  const { mine } = await myAddresses();
  const subject = t.subject ?? "";
  const seen = reproposalsOf();
  for (const m of t.messages) seen.set(m.id, m.reproposals);
  const messages = await Promise.all(t.messages.map((m) => messageView(key, subject, t.url, m, mine)));
  return { threadId: key, subject, gmailUrl: t.url, mailbox: t.accountEmail, messages };
};

/**
 * «Riproponi» un messaggio: riparte dalla sua proposta fallita, o dal suo
 * smistamento; il poller la riprende al prossimo giro.
 */
const reproposeMessage: Mail["reproposeMessage"] = async (id) => {
  // Lo smistamento si ripropone solo quando non ci sono proposte: le due cose non convivono.
  const pick = (reproposalsOf().get(id) ?? [])[0];
  if (!pick) throw new Error("not_found");
  await appClient().mail.repropose(pick.source, pick.id);
};

/**
 * «Segna come letta / non letta» sulla conversazione intera: scrive su
 * Gmail, e lo stato cambia solo dopo il sì di Google. Senza il permesso
 * nuovo (`gmail.modify`) è `google_scope_missing` (il cassetto: «Ricollega»).
 */
async function setRead(key: string, read: boolean): Promise<void> {
  const parts = splitThreadKey(key);
  if (!parts) throw new Error("not_found");
  try {
    await appClient().mail.setRead(parts.threadId, parts.accountId, read);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "google_scope_missing") throw new Error("google_scope_missing");
      if (error.code === "account_disabled" || error.code === "token_expired") throw new Error("google_not_connected");
      if (error.code === "google_rate_limited") throw new Error("google_rate_limited");
      if (error.status === 404) throw new Error("not_found");
    }
    throw error;
  }
}
const markRead: Mail["markRead"] = (key) => setRead(key, true);
const markUnread: Mail["markUnread"] = (key) => setRead(key, false);

export const mailFunctions: Partial<Mail> = {
  ...mailProposalFunctions,
  ...mailDraftFunctions,
  ...mailSendFunctions,
  ...mailClaudeDraftFunctions,
  listMailboxes,
  setProposalsEnabled,
  syncMailbox,
  listMailThreads,
  listImportantMail,
  getMailThread,
  searchMail,
  reproposeMessage,
  markRead,
  markUnread,
  // La fine del giro; la classificazione non si segue da qui (la Posta si rilegge da sé).
  whenMailSynced: whenSynced,
  whenMailIdle: whenSynced,
};

export const mail: Mail = partialNamespace<Mail>("mail", mailFunctions);
