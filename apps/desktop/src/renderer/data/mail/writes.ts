import { gate, now, state, storeGeneration } from "../store";
import type { Mailbox, MailClassification, MailMessage } from "../types";
import { classifyMessage } from "./classify";
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

/** Un passo della classificazione: `pending` → `done` (o `failed`). */
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
    for (const m of analysing()) setClassification(m, classifyMessage(m, members));
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
