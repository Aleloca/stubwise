import { chatNow, gate, newId, now, signalAutomations, state, storeGeneration } from "../store";
import type { Mailbox, MailClassification, MailMessage } from "../types";
import { classifyMessage, proposalsFromClassification } from "./classify";
import { canSeeMessage, myMailbox, visibleMessages } from "./visibility";

// Le scritture della Posta (area 6). Come le altre: `gate()` prima di tutto,
// ogni controllo prima di ogni scrittura (dopo un rifiuto lo stato è
// intatto). Un messaggio, un thread o una casella che chi agisce non vede è
// `not_found` (R-G5).
//
// Il lavoro simulato — l'arrivo della posta all'allineamento e la
// classificazione — passa da `gate()` (`mail.advanceSync`,
// `mail.advanceClassification`): segue `setLatency`, e `failNext` lo fa
// fallire. Nessun timer sull'orologio; `whenMailIdle` aspetta che finisca.

const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

const pending = new Set<Promise<void>>();

function track(work: Promise<void>): void {
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** I soli allineamenti in corso (l'arrivo, non la classificazione che segue). */
const syncs = new Set<Promise<void>>();

/** Si risolve quando nessun allineamento o classificazione simulata è più in corso. */
export async function whenMailIdle(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Si risolve quando nessun allineamento è più in corso: la posta nuova è
 * arrivata (magari ancora «in analisi»). Lo aspetta «Aggiorna ora» prima di
 * far rileggere l'elenco.
 */
export async function whenMailSynced(): Promise<void> {
  while (syncs.size > 0) await Promise.all([...syncs]);
}

/** Gli stati di classificazione attraversati da un messaggio dopo il seme. */
export function mailClassificationHistory(id: string): MailClassification["state"][] {
  return [...(state.mailClassificationLog.get(id) ?? [])];
}

function setClassification(m: MailMessage, c: MailClassification): void {
  m.classification = c;
  const log = state.mailClassificationLog.get(m.id) ?? [];
  log.push(c.state);
  state.mailClassificationLog.set(m.id, log);
}

function mailboxFor(me: string, email: string): Mailbox {
  const box = myMailbox(me, email);
  if (!box) throw notFound();
  return box;
}

/**
 * Va al modello se almeno UNA casella che lo contiene ha le proposte
 * attive; resta `off` solo se sono spente in tutte. La stessa email è anche
 * posta di un collega: chi spegne le proposte ferma la PROPRIA casella, non
 * quella degli altri (ruling del controller, fix round 1 del Task 2).
 */
const goesToModel = (m: MailMessage): boolean =>
  state.mailboxes.some((b) => m.mailboxPersonIds.includes(b.personId) && b.proposalsEnabled);

/**
 * Scrive le proposte di una classificazione: una per email (Message-ID) e
 * progetto — un'email riproposta, o arrivata in un'altra casella, non ne
 * raddoppia nessuna. Una «scegli il progetto» non nasce se uno dei suoi
 * candidati ha già la sua proposta.
 */
function propose(m: MailMessage): void {
  for (const p of proposalsFromClassification(m, m.classification, now())) {
    const projects = new Set(
      p.actions[0]?.fn === "chooseProject"
        ? ((p.actions[0].args.projectIds as string[] | undefined) ?? [])
        : [p.projectId],
    );
    const taken = state.mailProposals.some(
      (x) => x.id === p.id || (x.sourceId === p.sourceId && projects.has(x.projectId)),
    );
    if (!taken) state.mailProposals.push(p);
  }
}

/** Un passo della classificazione: `pending` → `done` (e le proposte), o `failed`. */
async function advanceClassification(ids: readonly string[]): Promise<void> {
  const generation = storeGeneration();
  // Lo stato è stato ripristinato nel frattempo: questo lavoro non è più suo.
  const alive = () => storeGeneration() === generation;
  const analysing = () =>
    state.mailMessages.filter((m) => ids.includes(m.id) && m.classification.state === "pending");
  try {
    await gate("mail.advanceClassification");
    if (!alive()) return;
    const members = (projectId: string) => state.projectsById.get(projectId)?.memberIds ?? [];
    for (const m of analysing()) {
      setClassification(m, classifyMessage(m, members));
      propose(m);
    }
  } catch {
    if (!alive()) return;
    for (const m of analysing()) setClassification(m, { state: "failed" });
  }
}

/** Manda al modello (o lascia `off`) i messaggi appena arrivati o riproposti. */
function classify(messages: MailMessage[]): void {
  const queued: string[] = [];
  for (const m of messages) {
    if (goesToModel(m)) {
      setClassification(m, { state: "pending" });
      queued.push(m.id);
    } else setClassification(m, { state: "off" });
  }
  if (queued.length > 0) track(advanceClassification(queued));
}

/** Un passo dell'allineamento: arriva la posta in coda per la casella, poi `ok`. */
async function advanceSync(personId: string): Promise<void> {
  const generation = storeGeneration();
  const alive = () => storeGeneration() === generation;
  const box = () => state.mailboxes.find((b) => b.personId === personId)!;
  try {
    await gate("mail.advanceSync");
    if (!alive()) return;
    const arrived = state.mailIncoming.filter((m) => m.mailboxPersonIds.includes(personId));
    state.mailIncoming = state.mailIncoming.filter((m) => !arrived.includes(m));
    state.mailMessages = [...state.mailMessages, ...arrived].sort((a, b) =>
      a.at.localeCompare(b.at),
    );
    Object.assign(box(), { sync: "ok", syncedAt: now() });
    classify(arrived);
    if (arrived.length > 0)
      signalAutomations({ kind: "mail_received", messageIds: arrived.map((m) => m.id) });
  } catch {
    if (!alive()) return;
    box().sync = "failed";
  }
}

/**
 * «Aggiorna ora» su una mia casella: passa a `syncing` e, col ritardo
 * simulato, porta dentro la posta in coda, torna `ok` con `syncedAt` =
 * adesso. Con l'account Google scaduto non si allinea («Ricollega»).
 */
export async function syncMailbox(email: string): Promise<void> {
  const me = await gate("mail.syncMailbox");
  const box = mailboxFor(me, email);
  if (state.googleAccounts.find((a) => a.personId === me)?.status !== "connected")
    throw new Error("google_not_connected");
  if (box.sync === "syncing") return;
  box.sync = "syncing";
  const work = advanceSync(me);
  syncs.add(work);
  void work.finally(() => syncs.delete(work));
  track(work);
}

/**
 * «Proposte attive per questa casella»: spento, la posta che arriva da qui
 * non va al modello. Vale per gli arrivi da adesso in poi.
 */
export async function setProposalsEnabled(email: string, on: boolean): Promise<void> {
  const me = await gate("mail.setProposalsEnabled");
  mailboxFor(me, email).proposalsEnabled = on;
}

/** Segna letti, per chi guarda, i messaggi del thread che vede. */
export async function markRead(threadId: string): Promise<void> {
  const me = await gate("mail.markRead");
  const messages = visibleMessages(me).filter((m) => m.threadId === threadId);
  if (messages.length === 0) throw notFound();
  for (const m of messages) if (!m.readByPersonIds.includes(me)) m.readByPersonIds.push(me);
}

/**
 * «Segna come non letta»: l'ultimo messaggio del thread che vedo torna da
 * leggere, solo per me (gli altri messaggi restano letti).
 */
export async function markUnread(threadId: string): Promise<void> {
  const me = await gate("mail.markUnread");
  const messages = visibleMessages(me).filter((m) => m.threadId === threadId);
  const last = [...messages].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (!last) throw notFound();
  last.readByPersonIds = last.readByPersonIds.filter((id) => id !== me);
}

/** «Riproponi» un'email la cui analisi è fallita: torna `pending`, poi l'esito. */
export async function reproposeMessage(id: string): Promise<void> {
  const me = await gate("mail.reproposeMessage");
  const m = state.mailMessages.find((x) => x.id === id);
  if (!m || !canSeeMessage(me, m)) throw notFound();
  if (m.classification.state !== "failed") throw invalid("not failed");
  classify([m]);
}

/**
 * La risposta del cliente, simulata (solo prototipo, area 7): nella mia
 * conversazione arriva un messaggio dal primo destinatario fuori dal team
 * del mio ultimo invio partito, col testo dato. Entra nella mia casella come
 * la posta che arriva (classificazione compresa) e lo sanno le automazioni:
 * un'attesa della risposta a quell'email si sblocca. Una conversazione che
 * non vedo è `not_found`; senza un mio invio a qualcuno fuori dal team,
 * `invalid: recipient`.
 */
export async function simulateReply(threadId: string, text: string): Promise<string> {
  const me = await gate("mail.simulateReply");
  if (!text.trim()) throw invalid("text");
  const messages = visibleMessages(me)
    .filter((m) => m.threadId === threadId)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (messages.length === 0) throw notFound();
  const sent = [...messages]
    .reverse()
    .find((m) => m.from.personId === me && (!m.delivery || m.delivery.state === "sent"));
  const client = sent?.to.find((a) => a.personId === null);
  if (!sent || !client) throw invalid("recipient");
  if (!state.mailboxes.some((b) => b.personId === me)) throw notFound();
  const id = newId("mm");
  const reply: MailMessage = {
    id,
    messageId: `<${id}@reply.example>`,
    threadId,
    from: { ...client },
    to: [{ ...sent.from }],
    cc: null,
    subject: /^re\s*:/i.test(sent.subject) ? sent.subject : `Re: ${sent.subject}`,
    at: chatNow(),
    text: text.trim(),
    quoted: null,
    html: null,
    attachments: [],
    mailboxPersonIds: [me],
    readByPersonIds: [],
    kind: "email",
    context: false,
    classification: { state: "off" },
  };
  state.mailMessages.push(reply);
  classify([reply]);
  signalAutomations({ kind: "mail_received", messageIds: [id] });
  return id;
}
