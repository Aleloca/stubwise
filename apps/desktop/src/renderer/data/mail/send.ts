import { placeDraft } from "../../domain/claude/intents/mailDraft";
import { canSeeDriveFile } from "../drive/visibility";
import { BOUNCE_DOMAIN } from "../seed/mail";
import { PEOPLE } from "../seed/people";
import { chatNow, copy, gate, newId, now, onStoreReset, state, storeGeneration } from "../store";
import type {
  MailDraft,
  MailDraftAttachment,
  MailDraftRestore,
  MailMessage,
  MailSendResult,
} from "../types";
import {
  draftFrom,
  draftIn,
  EMAIL,
  lower,
  MAIL_MAX_ATTACHMENTS,
  MAIL_MAX_BYTES,
  MAIL_UNDO_MS,
  type MailDraftInput,
  mailboxOf,
  myDraft,
  putDraft,
  resolve,
  teamAddresses,
  threadMessages,
} from "./compose";
import { canSeeMessage } from "./visibility";

// L'invio dalla Posta (area 6): «Invia» con «Annulla» per 5 s, l'invio
// fallito, «Riprova» ed «Elimina». Le bozze stanno in `compose.ts`.
//
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
// - Una bozza che torna («Annulla», «Elimina» un fallito) non sovrascrive MAI
//   una bozza più recente della stessa conversazione: ci si unisce
//   (`restoreDraft`).

const notFound = () => new Error("not_found");
const invalid = (what: string) => new Error(`invalid: ${what}`);

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
  return { messageId: message.id, threadId: message.threadId, undoUntil: undoUntil() };
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

const bytesOf = (list: MailDraftAttachment[]) =>
  list.reduce((sum, a) => sum + (a.as === "link" ? 0 : a.sizeBytes), 0);

/**
 * Ciò che si controlla prima di spedire (anche a «Riprova»): account
 * collegato, destinatari, indirizzi, limiti; ogni allegato del Drive si
 * rilegge — un file che nel frattempo non vedo più (o non è più
 * disponibile) ferma l'invio: `attachment_unavailable`.
 */
function checkSendable(me: string, draft: MailDraft): void {
  mailboxOf(me);
  if (state.googleAccounts.find((a) => a.personId === me)?.status !== "connected")
    throw new Error("google_not_connected");
  const recipients = [...draft.to, ...draft.cc];
  if (recipients.length === 0) throw invalid("recipients");
  if (recipients.some((a) => !EMAIL.test(a.email.trim()))) throw invalid("address");
  if (draft.attachments.length > MAIL_MAX_ATTACHMENTS) throw invalid("attachments");
  if (bytesOf(draft.attachments) > MAIL_MAX_BYTES) throw invalid("too_large");
  for (const a of draft.attachments) {
    if (a.driveFileId === null) continue;
    const file = state.driveFiles.find((f) => f.id === a.driveFileId);
    if (!file || !canSeeDriveFile(me, file) || file.unavailable)
      throw new Error("attachment_unavailable");
  }
}

/** Il mio invio, visibile a me: altrimenti come se non esistesse. */
function myAttempt(me: string, messageId: string): MailMessage {
  const m = state.mailMessages.find((x) => x.id === messageId);
  if (!m || !canSeeMessage(me, m) || m.delivery?.sentById !== me) throw notFound();
  return m;
}

/**
 * Rimette una bozza al suo posto. Se nella conversazione c'è già una bozza
 * (si decide da questo, non dalle date: l'orologio è fisso), NON la
 * sovrascrive: ci si unisce — il testo tornato sotto il suo (`placeDraft`
 * «below»), i suoi destinatari e oggetto restano, gli allegati tornati si
 * aggiungono finché stanno nei limiti; quelli in più si lasciano e si dicono
 * (`droppedAttachments`).
 */
function restoreDraft(
  draft: MailDraft,
  alreadyDropped: MailDraftAttachment[] = [],
): MailDraftRestore {
  // Un file del Drive che nel frattempo non vedo più (o non è più
  // disponibile) resta fuori e si dice: la bozza torna lo stesso.
  const [usable, gone] = splitUsable(draft.personId, draft.attachments);
  draft = { ...draft, attachments: usable };
  const existing = draftIn(draft.personId, draft.threadId);
  if (!existing) {
    const restored = { ...copy(draft), updatedAt: now() };
    putDraft(restored);
    return { draft: copy(restored), droppedAttachments: [...alreadyDropped, ...gone] };
  }
  const merged = existing.attachments.map(copy);
  const dropped: MailDraftAttachment[] = [...alreadyDropped, ...gone];
  let bytes = bytesOf(merged);
  for (const a of draft.attachments) {
    if (merged.some((x) => x.id === a.id)) continue;
    const size = a.as === "link" ? 0 : a.sizeBytes;
    if (merged.length >= MAIL_MAX_ATTACHMENTS || bytes + size > MAIL_MAX_BYTES) {
      dropped.push(copy(a));
      continue;
    }
    merged.push(copy(a));
    bytes += size;
  }
  existing.body = placeDraft(existing.body, draft.body, "below");
  existing.attachments = merged;
  existing.updatedAt = now();
  return { draft: copy(existing), droppedAttachments: dropped };
}

/**
 * Il testo citato del messaggio inviato (shape [A 4]): Inoltra cita sempre
 * l'originale, Rispondi salvo che chi scrive l'abbia tolto (`quote: false`).
 */
function quotedOf(draft: MailDraft, original: MailMessage | undefined): string | null {
  if (!original || draft.mode === "new") return null;
  if (draft.mode !== "forward" && draft.quote === false) return null;
  const who = original.from.name
    ? `${original.from.name} <${original.from.email}>`
    : original.from.email;
  return `${who}:\n${original.text}`;
}

/**
 * L'«Undo» di «Discard»: la bozza eliminata torna, con le stesse regole di
 * «Annulla» un invio — se nella conversazione ce n'è già un'altra (decide
 * l'esistenza della bozza, non il suo contenuto) ci si unisce sotto, e gli
 * allegati che non stanno più nei limiti si dicono (R-I9).
 */
export async function restoreDiscardedDraft(snapshot: MailDraftInput): Promise<MailDraftRestore> {
  const me = await gate("mail.restoreDiscardedDraft");
  // Prima di rileggerli dal Drive: un file che non c'è più non fa fallire il ripristino.
  const [usable, gone] = splitUsable(me, snapshot.attachments);
  return restoreDraft(draftFrom(me, { ...snapshot, attachments: usable }), gone);
}

/** Gli allegati che si possono ancora tenere e quelli del Drive che non si vedono più (o non ci sono più). */
function splitUsable(
  me: string,
  list: readonly MailDraftAttachment[],
): [MailDraftAttachment[], MailDraftAttachment[]] {
  const usable: MailDraftAttachment[] = [];
  const gone: MailDraftAttachment[] = [];
  for (const a of list) {
    if (a.driveFileId === null) {
      usable.push(a);
      continue;
    }
    const file = state.driveFiles.find((f) => f.id === a.driveFileId);
    if (file && canSeeDriveFile(me, file) && !file.unavailable) usable.push(a);
    else gone.push(copy(a));
  }
  return [usable, gone];
}

/**
 * «Invia»: il messaggio entra in fondo alla conversazione come `sending`
 * (solo per me) e la bozza esce; dopo `MAIL_UNDO_MS` parte. Un tentativo
 * fallito precedente resta dov'è, col suo testo: lo toglie solo «Elimina».
 */
export async function sendDraft(id: string): Promise<MailSendResult> {
  const me = await gate("mail.sendDraft");
  const draft = myDraft(me, id);
  checkSendable(me, draft);
  const original =
    draft.threadId !== null
      ? threadMessages(me, draft.threadId).find((m) => m.id === draft.replyToMessageId)
      : undefined;
  const box = mailboxOf(me);
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
    quoted: quotedOf(draft, original),
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
 * torna com'era (unita a un'altra eventualmente scritta nel frattempo nella
 * stessa conversazione, `restoreDraft`). Dopo → `too_late`.
 */
export async function undoSend(messageId: string): Promise<MailDraftRestore> {
  const me = await gate("mail.undoSend");
  const m = myAttempt(me, messageId);
  const attempt = attempts.get(messageId);
  if (m.delivery!.state !== "sending" || !attempt || attempt.timer === null)
    throw new Error("too_late");
  clearTimeout(attempt.timer);
  attempts.delete(messageId);
  state.mailMessages = state.mailMessages.filter((x) => x !== m);
  attempt.settle();
  return restoreDraft(attempt.draft);
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
 * Toglie un invio fallito dalla conversazione e rimette la bozza (unita a
 * una più recente, se c'è): è «Elimina» (la bozza resta) e il primo passo
 * di «Modifica» (la casella si riapre con quella bozza).
 */
export async function deleteFailedSend(messageId: string): Promise<MailDraftRestore> {
  const me = await gate("mail.deleteFailedSend");
  const m = myAttempt(me, messageId);
  const attempt = attempts.get(messageId);
  if (m.delivery!.state !== "failed" || !attempt) throw invalid("not failed");
  attempts.delete(messageId);
  state.mailMessages = state.mailMessages.filter((x) => x !== m);
  return restoreDraft(attempt.draft);
}
