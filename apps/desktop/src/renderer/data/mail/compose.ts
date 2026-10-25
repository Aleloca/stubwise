import i18n from "../../i18n";
import {
  draftReply,
  type MailDraftContext,
  type MailDraftRequest,
  type MailDraftResult,
} from "../../domain/claude/intents/mailDraft";
import { fold, searchWords } from "../../pages/chat/search";
import { canSeeDriveFile } from "../drive/visibility";
import { BOUNCE_DOMAIN } from "../seed/mail";
import { PEOPLE } from "../seed/people";
import { getSessionPersonId } from "../session";
import {
  chatNow,
  copy,
  familyOf,
  gate,
  newId,
  now,
  onStoreReset,
  state,
  storeGeneration,
  visibleProjectIds,
  visibleTasks,
} from "../store";
import { streamText } from "../stream";
import type {
  MailAddress,
  Mailbox,
  MailDraft,
  MailDraftAttachment,
  MailMessage,
  MailRecipientSuggestion,
  MailSendResult,
} from "../types";
import { threadFor } from "./reads";
import { canSeeMessage, visibleMessages } from "./visibility";

// Scrivere dalla Posta (area 6): bozze, invio con «Annulla», invio fallito,
// destinatari suggeriti, allegati dal Drive e la bozza di Claude.
//
// - Una bozza per persona e conversazione (`threadId: null` = l'email nuova,
//   una per persona), con id fisso per quella coppia. Passare fra Rispondi,
//   Rispondi a tutti e Inoltra tiene corpo e allegati e rifà destinatari e
//   oggetto (shape mail-compose [A 1]).
// - Nulla parte senza `sendDraft`. Il messaggio entra SUBITO nella
//   conversazione come `sending`, ma lo vede solo chi l'ha scritto
//   (`canSeeMessage`); allo scadere dei 5 s — un timer del prototipo, che i
//   test portano avanti con i timer finti, mai l'orologio vero — parte: `sent`
//   e visibile a ogni destinatario in Stubwise, o `failed` (un indirizzo
//   `@bounce.example`), di nuovo solo per chi l'ha scritto e mai ritentato da
//   solo. Il mittente è fissato all'invio (`gate` legge la persona prima
//   dell'attesa): un cambio di persona nei 5 s non spedisce a nome dell'altra.
// - La posta in uscita NON va al modello: un messaggio scritto da me non
//   produce proposte, quindi resta `classification: { state: "off" }`
//   (ruling R-I8). Le proposte nascono solo dalla posta che arriva.
// - Chi scrive deve avere una casella; per spedire, l'account Google
//   collegato e non scaduto (`google_not_connected`). Una conversazione o un
//   file del Drive che non vede è `not_found` (R-G5).

/** La finestra dell'«Annulla» dopo «Invia». */
export const MAIL_UNDO_MS = 5000;
/** Il limite di Gmail: 10 allegati, 25 MB in tutto (i link Google non pesano). */
export const MAIL_MAX_ATTACHMENTS = 10;
export const MAIL_MAX_BYTES = 25 * 1024 * 1024;
/** I suggerimenti al massimo, team prima. */
const MAX_SUGGESTIONS = 8;

const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);
const notConnected = () => new Error("google_not_connected");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lower = (email: string) => email.trim().toLowerCase();

// --- chi scrive e a chi ------------------------------------------------------

/** L'indirizzo di una persona del team: quello del suo account Google, o `nome.cognome@example.com`. */
function teamAddresses(): MailAddress[] {
  return PEOPLE.filter((p) => !p.isClaude).map((p) => ({
    name: p.name,
    email:
      state.googleAccounts.find((a) => a.personId === p.id)?.email ??
      `${p.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
    personId: p.id,
  }));
}

/**
 * Un indirizzo come lo salva Stubwise: la persona del team si riconosce
 * dall'indirizzo, MAI dal `personId` che arriva da chi scrive (che
 * altrimenti potrebbe far «ricevere» un messaggio a chiunque).
 */
function resolve(a: MailAddress, team: MailAddress[]): MailAddress {
  const email = a.email.trim();
  const member = team.find((x) => lower(x.email) === lower(email));
  return member ? { ...member } : { name: a.name.trim(), email, personId: null };
}

/** Senza doppioni (per indirizzo) e senza chi scrive. */
function others(list: MailAddress[], me: string, box: Mailbox): MailAddress[] {
  const seen = new Set<string>([lower(box.email)]);
  const out: MailAddress[] = [];
  for (const a of list) {
    if (a.personId === me || seen.has(lower(a.email))) continue;
    seen.add(lower(a.email));
    out.push({ ...a });
  }
  return out;
}

function mailboxOf(me: string): Mailbox {
  const box = state.mailboxes.find((b) => b.personId === me);
  if (!box) throw notConnected();
  return box;
}

// --- bozze ---------------------------------------------------------------------

const slotId = (me: string, threadId: string | null) => `md-${me}-${threadId ?? "new"}`;

const draftIn = (me: string, threadId: string | null) =>
  state.mailDrafts.find((d) => d.personId === me && d.threadId === threadId);

function myDraft(me: string, id: string): MailDraft {
  const draft = state.mailDrafts.find((d) => d.id === id && d.personId === me);
  if (!draft) throw notFound();
  return draft;
}

/** I messaggi della conversazione che chi scrive vede, dal più vecchio. */
function threadMessages(me: string, threadId: string): MailMessage[] {
  const messages = visibleMessages(me)
    .filter((m) => m.threadId === threadId)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (messages.length === 0) throw notFound();
  return messages;
}

/** L'ultimo messaggio arrivato davvero (non un mio invio in corso o fallito). */
const lastArrived = (messages: MailMessage[]) =>
  [...messages].reverse().find((m) => !m.delivery || m.delivery.state === "sent") ??
  messages[messages.length - 1]!;

/** Gli allegati originali che Inoltra porta con sé (riconoscibili dall'id). */
const FORWARDED = "fwd-";

type Header = Pick<MailDraft, "to" | "cc" | "subject" | "replyToMessageId">;

/** Destinatari e oggetto di una modalità, dall'ultimo messaggio della conversazione. */
function headerFor(
  me: string,
  box: Mailbox,
  last: MailMessage,
  mode: Exclude<MailDraft["mode"], "new">,
): Header {
  const mine = last.from.personId === me || lower(last.from.email) === lower(box.email);
  const subject = last.subject;
  if (mode === "forward") {
    return {
      to: [],
      cc: [],
      subject: /^fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`,
      replyToMessageId: last.id,
    };
  }
  const re = /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
  if (mode === "reply") {
    return {
      to: others(mine ? last.to : [last.from], me, box),
      cc: [],
      subject: re,
      replyToMessageId: last.id,
    };
  }
  const to = others(mine ? last.to : [last.from, ...last.to], me, box);
  const inTo = new Set(to.map((a) => lower(a.email)));
  return {
    to,
    cc: others(last.cc ?? [], me, box).filter((a) => !inTo.has(lower(a.email))),
    subject: re,
    replyToMessageId: last.id,
  };
}

function forwardedOf(last: MailMessage): MailDraftAttachment[] {
  return last.attachments.map((a) => ({
    id: `${FORWARDED}${a.id}`,
    name: a.name,
    sizeBytes: a.sizeBytes,
    driveFileId: null,
    as: a.as ?? "copy",
  }));
}

function checkMode(threadId: string | null, mode: MailDraft["mode"]): void {
  const modes: MailDraft["mode"][] = ["new", "reply", "replyAll", "forward"];
  if (!modes.includes(mode) || (threadId === null) !== (mode === "new")) throw invalid("mode");
}

/**
 * La bozza di una conversazione (o dell'email nuova) in una modalità: quella
 * salvata, se c'è — in un'altra modalità tiene corpo e allegati, con
 * destinatari e oggetto rifatti — altrimenti una nuova, già indirizzata.
 * Non salva nulla: lo fa `saveDraft`.
 */
export async function getDraft(
  threadId: string | null,
  mode: MailDraft["mode"],
): Promise<MailDraft> {
  const me = await gate("mail.getDraft");
  const box = mailboxOf(me);
  checkMode(threadId, mode);
  const saved = draftIn(me, threadId);
  if (threadId === null || mode === "new") {
    return saved
      ? copy(saved)
      : {
          id: slotId(me, null),
          personId: me,
          threadId: null,
          mode: "new",
          replyToMessageId: null,
          to: [],
          cc: [],
          subject: "",
          body: "",
          attachments: [],
          updatedAt: now(),
        };
  }
  const last = lastArrived(threadMessages(me, threadId));
  if (saved && saved.mode === mode) return copy(saved);
  const own = (saved?.attachments ?? []).filter((a) => !a.id.startsWith(FORWARDED)).map(copy);
  return {
    id: slotId(me, threadId),
    personId: me,
    threadId,
    mode,
    ...headerFor(me, box, last, mode),
    body: saved?.body ?? "",
    attachments: mode === "forward" ? [...forwardedOf(last), ...own] : own,
    updatedAt: saved?.updatedAt ?? now(),
  };
}

/** Le mie bozze, dalla più recente (la riga «Bozza» dell'elenco). */
export async function listDrafts(): Promise<MailDraft[]> {
  const me = await gate("mail.listDrafts");
  return state.mailDrafts
    .filter((d) => d.personId === me)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map(copy);
}

export type MailDraftInput = Pick<
  MailDraft,
  "threadId" | "mode" | "replyToMessageId" | "to" | "cc" | "subject" | "body" | "attachments"
>;

/** Un allegato del Drive com'è nel Drive (nome, peso, copia o link), se chi scrive vede il file. */
function driveAttachment(me: string, driveFileId: string): MailDraftAttachment {
  const file = state.driveFiles.find((f) => f.id === driveFileId);
  if (!file || !canSeeDriveFile(me, file)) throw notFound();
  if (file.unavailable) throw invalid("unavailable");
  const link = file.source === "google";
  return {
    id: `att-${file.id}`,
    name: file.name,
    sizeBytes: link ? 0 : (file.sizeBytes ?? 0),
    driveFileId: file.id,
    as: link ? "link" : "copy",
  };
}

/**
 * Salva la bozza della conversazione (una per persona e conversazione: una
 * seconda la sostituisce, con lo stesso id). Destinatari riconosciuti
 * dall'indirizzo; allegati del Drive riletti dal Drive (solo file che vedo);
 * al massimo 10 allegati. Un indirizzo non valido o oltre 25 MB si salva:
 * è `sendDraft` a fermarli.
 */
export async function saveDraft(input: MailDraftInput): Promise<MailDraft> {
  const me = await gate("mail.saveDraft");
  mailboxOf(me);
  checkMode(input.threadId, input.mode);
  if (input.threadId !== null) {
    const messages = threadMessages(me, input.threadId);
    if (input.replyToMessageId !== null && !messages.some((m) => m.id === input.replyToMessageId))
      throw notFound();
  } else if (input.replyToMessageId !== null) throw invalid("replyToMessageId");
  if (!Array.isArray(input.attachments) || input.attachments.length > MAIL_MAX_ATTACHMENTS)
    throw invalid("attachments");
  const attachments = input.attachments.map((a) =>
    a.driveFileId !== null
      ? driveAttachment(me, a.driveFileId)
      : {
          id: a.id,
          name: a.name,
          sizeBytes: Math.max(0, a.sizeBytes),
          driveFileId: null,
          as: "copy" as const,
        },
  );
  const team = teamAddresses();
  const draft: MailDraft = {
    id: slotId(me, input.threadId),
    personId: me,
    threadId: input.threadId,
    mode: input.mode,
    replyToMessageId: input.replyToMessageId,
    to: input.to.map((a) => resolve(a, team)),
    cc: input.cc.map((a) => resolve(a, team)),
    subject: input.subject,
    body: input.body,
    attachments,
    updatedAt: now(),
  };
  putDraft(draft);
  return copy(draft);
}

/** La bozza al suo posto (persona e conversazione), al posto di quella che c'era. */
function putDraft(draft: MailDraft): void {
  state.mailDrafts = [
    ...state.mailDrafts.filter(
      (d) => !(d.personId === draft.personId && d.threadId === draft.threadId),
    ),
    draft,
  ];
}

/** «Elimina» la bozza. */
export async function discardDraft(id: string): Promise<void> {
  const me = await gate("mail.discardDraft");
  const draft = myDraft(me, id);
  state.mailDrafts = state.mailDrafts.filter((d) => d !== draft);
}

/**
 * Allega un file del Drive a una bozza salvata: un file di Stubwise come
 * copia, un file Google come link (shape [A 8]). Solo file che vedo; lo
 * stesso file una volta sola; al massimo 10 allegati.
 */
export async function attachDriveFile(draftId: string, driveFileId: string): Promise<MailDraft> {
  const me = await gate("mail.attachDriveFile");
  const draft = myDraft(me, draftId);
  const attachment = driveAttachment(me, driveFileId);
  if (!draft.attachments.some((a) => a.driveFileId === driveFileId)) {
    if (draft.attachments.length >= MAIL_MAX_ATTACHMENTS) throw invalid("attachments");
    draft.attachments.push(attachment);
    draft.updatedAt = now();
  }
  return copy(draft);
}

// --- invio -------------------------------------------------------------------

/** Un invio di cui si ricorda la bozza: nei 5 s (col timer) o fallito. */
interface Attempt {
  draft: MailDraft;
  timer: ReturnType<typeof setTimeout> | null;
  settled: Promise<void>;
  settle: () => void;
}

const attempts = new Map<string, Attempt>();

// Un ripristino dello stato ferma i timer: nessun invio parte nello stato nuovo.
onStoreReset(() => {
  for (const a of attempts.values()) {
    if (a.timer !== null) clearTimeout(a.timer);
    a.settle();
  }
  attempts.clear();
});

/**
 * Si risolve quando l'invio esce dai suoi 5 s: partito, fallito o annullato.
 * La Posta si rilegge allora (il messaggio passa da «Invio…» a inviato).
 */
export function whenSendSettled(messageId: string): Promise<void> {
  return attempts.get(messageId)?.settled ?? Promise.resolve();
}

const undoUntil = () => new Date(Date.parse(now()) + MAIL_UNDO_MS).toISOString();

/** Fa partire la finestra dei 5 s: allo scadere, `deliver`. */
function startWindow(message: MailMessage, draft: MailDraft): MailSendResult {
  const generation = storeGeneration();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const timer = setTimeout(() => {
    if (storeGeneration() === generation) deliver(message.id);
  }, MAIL_UNDO_MS);
  attempts.get(message.id)?.settle();
  attempts.set(message.id, { draft, timer, settled, settle });
  return { messageId: message.id, undoUntil: undoUntil() };
}

const domainOf = (email: string) => lower(email).slice(lower(email).lastIndexOf("@") + 1);

/** Lo scadere dei 5 s: l'email parte (o fallisce). Non legge la sessione: è di chi l'ha scritta. */
function deliver(id: string): void {
  const attempt = attempts.get(id);
  const m = state.mailMessages.find((x) => x.id === id);
  if (!attempt || !m || m.delivery?.state !== "sending") return;
  attempt.timer = null;
  const sentById = m.delivery.sentById;
  const recipients = [...m.to, ...(m.cc ?? [])];
  const bounced = recipients.find((a) => domainOf(a.email) === BOUNCE_DOMAIN);
  if (bounced) {
    m.delivery = { state: "failed", sentById, error: `address_not_found: ${bounced.email}` };
  } else {
    m.delivery = { state: "sent", sentById };
    // Entra nelle caselle dei destinatari del team che ne hanno una.
    const boxes = new Set([sentById]);
    for (const a of recipients) {
      if (a.personId && state.mailboxes.some((b) => b.personId === a.personId))
        boxes.add(a.personId);
    }
    m.mailboxPersonIds = [...boxes];
    attempts.delete(id);
  }
  attempt.settle();
}

function checkSendable(me: string, draft: MailDraft): void {
  mailboxOf(me);
  if (state.googleAccounts.find((a) => a.personId === me)?.status !== "connected")
    throw notConnected();
  const recipients = [...draft.to, ...draft.cc];
  if (recipients.length === 0) throw invalid("recipients");
  if (recipients.some((a) => !EMAIL.test(a.email.trim()))) throw invalid("address");
  if (draft.attachments.length > MAIL_MAX_ATTACHMENTS) throw invalid("attachments");
  const bytes = draft.attachments.reduce((sum, a) => sum + (a.as === "link" ? 0 : a.sizeBytes), 0);
  if (bytes > MAIL_MAX_BYTES) throw invalid("too_large");
}

/** Il mio invio, visibile a me: altrimenti come se non esistesse. */
function myAttempt(me: string, messageId: string): MailMessage {
  const m = state.mailMessages.find((x) => x.id === messageId);
  if (!m || !canSeeMessage(me, m) || m.delivery?.sentById !== me) throw notFound();
  return m;
}

/**
 * «Invia»: il messaggio entra in fondo alla conversazione come `sending`
 * (solo per me) e la bozza esce; dopo `MAIL_UNDO_MS` parte. Un tentativo
 * fallito della stessa bozza (riaperta con «Modifica») è sostituito da questo.
 */
export async function sendDraft(id: string): Promise<MailSendResult> {
  const me = await gate("mail.sendDraft");
  const draft = myDraft(me, id);
  checkSendable(me, draft);
  if (draft.threadId !== null) threadMessages(me, draft.threadId);
  const box = mailboxOf(me);
  for (const [messageId, a] of [...attempts]) {
    if (a.draft.id === draft.id && a.timer === null) {
      attempts.delete(messageId);
      state.mailMessages = state.mailMessages.filter((m) => m.id !== messageId);
    }
  }
  const team = teamAddresses();
  const rowId = newId("mm");
  const message: MailMessage = {
    id: rowId,
    messageId: `<${rowId}@stubwise.example>`,
    threadId: draft.threadId ?? `th-${rowId}`,
    from: {
      name: PEOPLE.find((p) => p.id === me)?.name ?? box.email,
      email: box.email,
      personId: me,
    },
    to: draft.to.map((a) => resolve(a, team)),
    cc: draft.cc.length > 0 ? draft.cc.map((a) => resolve(a, team)) : null,
    subject: draft.subject,
    // Lo stesso orologio fisso dei messaggi della Chat, un secondo dopo l'altro.
    at: chatNow(),
    text: draft.body,
    quoted: null,
    html: null,
    attachments: draft.attachments.map((a) =>
      a.as === "link"
        ? { id: a.id, name: a.name, sizeBytes: 0, as: "link" as const }
        : { id: a.id, name: a.name, sizeBytes: a.sizeBytes },
    ),
    mailboxPersonIds: [me],
    readByPersonIds: [me],
    kind: "email",
    context: false,
    classification: { state: "off" },
    delivery: { state: "sending", sentById: me },
  };
  state.mailMessages.push(message);
  state.mailDrafts = state.mailDrafts.filter((d) => d !== draft);
  return startWindow(message, copy(draft));
}

/**
 * «Annulla» entro i 5 s: il messaggio sparisce senza traccia e la bozza
 * torna com'era (al posto di un'altra eventualmente scritta nel frattempo
 * nella stessa conversazione). Dopo → `too_late`.
 */
export async function undoSend(messageId: string): Promise<MailDraft> {
  const me = await gate("mail.undoSend");
  const m = myAttempt(me, messageId);
  const attempt = attempts.get(messageId);
  if (m.delivery!.state !== "sending" || !attempt || attempt.timer === null)
    throw new Error("too_late");
  clearTimeout(attempt.timer);
  attempts.delete(messageId);
  state.mailMessages = state.mailMessages.filter((x) => x !== m);
  const draft = { ...copy(attempt.draft), updatedAt: now() };
  putDraft(draft);
  attempt.settle();
  return copy(draft);
}

/** «Riprova» un invio fallito: torna `sending`, in fondo, con altri 5 s per annullarlo. */
export async function retrySend(messageId: string): Promise<MailSendResult> {
  const me = await gate("mail.retrySend");
  const m = myAttempt(me, messageId);
  const attempt = attempts.get(messageId);
  if (m.delivery!.state !== "failed" || !attempt) throw invalid("not failed");
  checkSendable(me, attempt.draft);
  m.delivery = { state: "sending", sentById: me };
  m.at = chatNow();
  return startWindow(m, attempt.draft);
}

/**
 * Toglie un invio fallito dalla conversazione e rimette la bozza, intatta:
 * è «Elimina» (la bozza resta) e il primo passo di «Modifica» (la casella
 * si riapre con quella bozza).
 */
export async function deleteFailedSend(messageId: string): Promise<MailDraft> {
  const me = await gate("mail.deleteFailedSend");
  const m = myAttempt(me, messageId);
  const attempt = attempts.get(messageId);
  if (m.delivery!.state !== "failed" || !attempt) throw invalid("not failed");
  attempts.delete(messageId);
  state.mailMessages = state.mailMessages.filter((x) => x !== m);
  const draft = { ...copy(attempt.draft), updatedAt: now() };
  putDraft(draft);
  return copy(draft);
}

// --- destinatari ---------------------------------------------------------------

/**
 * I destinatari suggeriti per `q` (tutte le parole, senza accenti, su nome e
 * indirizzo): prima le persone del team, poi gli indirizzi visti nei
 * messaggi che vedo, dal più recente. Mai un indirizzo visto solo in posta
 * che non vedo (anche un invio altrui ancora nei 5 s o fallito: non lo vedo).
 */
export async function suggestRecipients(q: string): Promise<MailRecipientSuggestion[]> {
  const me = await gate("mail.suggestRecipients");
  const words = searchWords(q);
  if (words.length === 0) return [];
  const matches = (a: MailAddress) => words.every((w) => fold(`${a.name} ${a.email}`).includes(w));
  const team = teamAddresses();
  const teamEmails = new Set(team.map((a) => lower(a.email)));
  const out: MailRecipientSuggestion[] = team
    .filter((a) => a.personId !== me && matches(a))
    .map((a) => ({ group: "team", ...a }));
  const seen = new Set<string>();
  const recent = [...visibleMessages(me)].sort((a, b) => b.at.localeCompare(a.at));
  for (const m of recent) {
    for (const a of [m.from, ...m.to, ...(m.cc ?? [])]) {
      const email = lower(a.email);
      if (a.personId !== null || teamEmails.has(email) || seen.has(email)) continue;
      seen.add(email);
      if (state.mailboxes.some((b) => b.personId === me && lower(b.email) === email)) continue;
      if (matches(a)) out.push({ group: "mail", name: a.name, email: a.email, personId: null });
    }
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

// --- la bozza di Claude ----------------------------------------------------------

/** Le letture della bozza di Claude per `me`: solo conversazione, progetti e task che vede. */
function draftContext(me: string): MailDraftContext {
  return {
    personId: me,
    personName: PEOPLE.find((p) => p.id === me)?.name ?? "",
    t: (key, options) => i18n.t(key, options),
    read: {
      thread: async (threadId) => threadFor(me, threadId),
      projects: async () => {
        const visible = visibleProjectIds(me);
        return state.projects.filter((p) => visible.has(p.id)).map(copy);
      },
      openTasks: async (projectId) =>
        visibleTasks(me)
          .filter((task) => task.projectId === projectId && familyOf(task) !== "closed")
          .map(copy),
    },
  };
}

/** Com'è finita: `complete` falso se fermata («Ferma», cambio di persona). */
export interface ClaudeDraftOutcome extends MailDraftResult {
  complete: boolean;
}

export interface ClaudeDraftStream {
  /** Il testo scritto (intero o fin dove si è fermata) e le task che cita. */
  result: Promise<ClaudeDraftOutcome>;
  /** «Ferma»: il testo resta fin lì. */
  stop(): void;
}

/**
 * «Chiedi a Claude»: la bozza (`draftReply`) arriva a pezzi in `onText`, col
 * testo fin lì, con lo stesso ritmo delle risposte di Claude (`streamText`
 * di `stream.ts`: i suoi pezzi sono eventi di un flusso, qui servono a un
 * campo, quindi solo il testo). È di chi l'ha chiesta: se la persona
 * cambia, si ferma. Non tocca bozze né invii — non spedisce MAI; chi scrive
 * mette il testo nel campo (`placeDraft`) e lo modifica prima di «Invia».
 */
export function streamClaudeDraft(
  request: MailDraftRequest,
  onText: (soFar: string) => void,
): ClaudeDraftStream {
  let stopped = false;
  const result = (async (): Promise<ClaudeDraftOutcome> => {
    const me = await gate("mail.draftReply");
    const draft = await draftReply(request, draftContext(me));
    let written = "";
    const complete = await streamText(
      draft.text,
      `${me}:${request.threadId ?? "new"}`,
      (soFar) => {
        written = soFar;
        onText(soFar);
      },
      () => !stopped && getSessionPersonId() === me,
    );
    if (complete) return { ...draft, complete };
    // Fermata a metà: cita solo le task già scritte.
    return {
      ...draft,
      text: written,
      used: draft.used.filter((u) => written.includes(u.title)),
      complete,
    };
  })();
  return {
    result,
    stop: () => {
      stopped = true;
    },
  };
}
