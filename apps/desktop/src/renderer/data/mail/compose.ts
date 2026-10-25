import i18n from "../../i18n";
import {
  draftReply,
  type MailDraftContext,
  type MailDraftRequest,
  type MailDraftResult,
} from "../../domain/claude/intents/mailDraft";
import { fold, searchWords } from "../../pages/chat/search";
import { canSeeDriveFile } from "../drive/visibility";
import { PEOPLE } from "../seed/people";
import { getSessionPersonId } from "../session";
import { copy, familyOf, gate, now, state, visibleProjectIds, visibleTasks } from "../store";
import { streamText } from "../stream";
import type {
  MailAddress,
  Mailbox,
  MailDraft,
  MailDraftAttachment,
  MailMessage,
  MailRecipientSuggestion,
} from "../types";
import { threadFor } from "./reads";
import { visibleMessages } from "./visibility";

// Scrivere dalla Posta (area 6): bozze, destinatari suggeriti, allegati dal
// Drive e la bozza di Claude. L'invio (con «Annulla», fallito, «Riprova»)
// sta in `send.ts`, che usa gli aiuti esportati qui.
//
// - Una bozza per persona e conversazione (`threadId: null` = l'email nuova,
//   una per persona), con id fisso per quella coppia. Passare fra Rispondi,
//   Rispondi a tutti e Inoltra tiene corpo e allegati e rifà destinatari e
//   oggetto (shape mail-compose [A 1]).
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

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const lower = (email: string) => email.trim().toLowerCase();

// --- chi scrive e a chi ------------------------------------------------------

/** L'indirizzo di una persona del team: quello del suo account Google, o `nome.cognome@example.com`. */
export function teamAddresses(): MailAddress[] {
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
export function resolve(a: MailAddress, team: MailAddress[]): MailAddress {
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

export function mailboxOf(me: string): Mailbox {
  const box = state.mailboxes.find((b) => b.personId === me);
  if (!box) throw notConnected();
  return box;
}

// --- bozze ---------------------------------------------------------------------

const slotId = (me: string, threadId: string | null) => `md-${me}-${threadId ?? "new"}`;

export const draftIn = (me: string, threadId: string | null) =>
  state.mailDrafts.find((d) => d.personId === me && d.threadId === threadId);

export function myDraft(me: string, id: string): MailDraft {
  const draft = state.mailDrafts.find((d) => d.id === id && d.personId === me);
  if (!draft) throw notFound();
  return draft;
}

/** I messaggi della conversazione che chi scrive vede, dal più vecchio. */
export function threadMessages(me: string, threadId: string): MailMessage[] {
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
export function putDraft(draft: MailDraft): void {
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
