import { ApiError } from "@stubwise/api-client";
import type { MailDraft as ServerDraft, MailOutgoing } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { MailDraftAttachment, MailDraftRestore, MailSendResult } from "../../types";
import { appClient } from "./client";
import { draftOf, myMailboxes } from "./mailDrafts";
import { threadKey } from "./mailKeys";

// L'invio della Posta nella build app (area 6, fetta 3): il SERVER trattiene
// l'invio per 10 secondi (D6 del maintainer), così «Annulla» funziona anche
// se l'app si chiude. Un invio fallito non si ritenta mai da solo: «Riprova»
// o «Elimina» (la bozza torna). Destinatari, limiti, allegati e casella li
// controlla il server prima di accodare; ciò che fallisce dopo (Gmail) lo
// dice lo stato dell'invio (`error`).

type Mail = typeof Fake.mail;

/** «Annulla» per 10 secondi (D6). */
export const MAIL_UNDO_MS = 10_000;
/** I limiti di Gmail per un messaggio: 10 allegati, 25 MB. */
export const MAIL_MAX_ATTACHMENTS = 10;
export const MAIL_MAX_BYTES = 25 * 1024 * 1024;

/** Ogni quanto si rilegge un invio nei suoi 10 s, e fin quando lo si aspetta al più. */
const SETTLE_POLL_MS = 1_000;
const SETTLE_WAIT_MS = 2 * 60_000;

/** Gli errori del server su un invio, nelle parole del prototipo. */
/** I controlli del server prima di accodare (la bozza resta lì), nelle parole del prototipo. */
const BEFORE_SEND: Readonly<Record<string, string>> = {
  invalid_recipients: "invalid: recipients",
  invalid_address: "invalid: address",
  too_many_attachments: "invalid: attachments",
  too_large: "invalid: too_large",
  attachment_unavailable: "attachment_unavailable",
  account_disabled: "google_not_connected",
  // Le credenziali della casella non si usano più: si ricollega.
  account_unavailable: "google_not_connected",
  google_scope_missing: "google_scope_missing",
};

function sendError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return new Error("not_found");
  if (error.code && BEFORE_SEND[error.code]) return new Error(BEFORE_SEND[error.code]);
  if (error.code === "too_late" || error.code === "not_failed") {
    return new Error(error.code);
  }
  return error;
}

/** L'esito di un invio: la conversazione nella casella della bozza ("" finché un'email nuova non è partita). */
function resultOf(o: MailOutgoing, accountId: string | null): MailSendResult {
  return {
    messageId: o.messageId,
    threadId: o.threadId !== null && accountId ? threadKey(accountId, o.threadId) : "",
    undoUntil: o.undoUntil,
    undoWindowMs: Math.max(0, Date.parse(o.undoUntil) - Date.now()),
  };
}

/** La casella di una bozza (l'invio non la dice). */
async function accountOfDraft(id: string): Promise<string | null> {
  const { items } = await appClient().mail.drafts();
  return (items.find((d) => d.id === id) as ServerDraft | undefined)?.accountId ?? null;
}

/** Le caselle degli invii partiti da qui: «Riprova» non ha la bozza. */
const accountOfSend = new WeakMap<object, Map<string, string>>();
function sendAccounts(): Map<string, string> {
  const client = appClient();
  let map = accountOfSend.get(client);
  if (!map) {
    map = new Map();
    accountOfSend.set(client, map);
  }
  return map;
}

const sendDraft: Mail["sendDraft"] = async (id) => {
  const accountId = await accountOfDraft(id);
  try {
    const o = (await appClient().mail.sendDraft(id)) as MailOutgoing;
    if (accountId) sendAccounts().set(o.messageId, accountId);
    // Il suo ultimo invio era fallito: il server ridà quello, senza un secondo
    // invio. Non è riuscito, e non deve sembrarlo (`already_failed`, col messaggio).
    if (o.state === "failed") throw Object.assign(new Error("already_failed"), { messageId: o.messageId });
    return resultOf(o, accountId);
  } catch (error) {
    throw sendError(error);
  }
};

/** Si risolve quando l'invio esce dai suoi 10 s: partito, fallito o annullato (o si smette di aspettare). */
const whenSendSettled: Mail["whenSendSettled"] = async (messageId) => {
  const deadline = Date.now() + SETTLE_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    const o = await appClient()
      .mail.outgoing(messageId)
      .catch(() => null);
    if (!o || (o.state !== "queued" && o.state !== "sending")) return;
  }
};

/**
 * Una bozza tornata: gli allegati che non stanno più nei limiti, detti per
 * nome. Con un'altra bozza nella conversazione torna NON salvata
 * (`unsaved`): l'invio è fermo, e i suoi allegati restano nella bozza su
 * Gmail (non sono «fuori dai limiti»).
 */
async function restoreOf(r: {
  draft: ServerDraft | null;
  droppedAttachments: readonly string[];
  unsaved?: boolean;
}): Promise<MailDraftRestore> {
  if (!r.draft) throw new Error("not_found");
  const { mine } = await myMailboxes();
  if (r.unsaved === true) {
    return { draft: draftOf(r.draft, mine), droppedAttachments: [], unsaved: true, leftInGmail: [...r.droppedAttachments] };
  }
  const dropped = r.droppedAttachments.map<MailDraftAttachment>((name, i) => ({
    id: `dropped-${i}`,
    name,
    sizeBytes: 0,
    driveFileId: null,
    as: "copy",
  }));
  return { draft: draftOf(r.draft, mine), droppedAttachments: dropped, unsaved: false };
}

/** «Annulla» entro i 10 s: l'invio si ferma SEMPRE e la bozza torna (non salvata se lo slot è occupato). Dopo, `too_late`. */
const undoSend: Mail["undoSend"] = async (messageId) => {
  try {
    return await restoreOf((await appClient().mail.undoSend(messageId)) as never);
  } catch (error) {
    throw sendError(error);
  }
};

/**
 * «Riprova» un invio fallito: un invio nuovo. Oggi il server lo manda
 * subito (`undoUntil` già passato, quindi nessun «Annulla»); se lo
 * trattiene, la finestra è la sua.
 */
const retrySend: Mail["retrySend"] = async (messageId) => {
  try {
    const o = (await appClient().mail.retrySend(messageId)) as MailOutgoing;
    return resultOf(o, sendAccounts().get(messageId) ?? null);
  } catch (error) {
    throw sendError(error);
  }
};

/** «Elimina» un invio fallito: la bozza torna, da correggere. Uno che non è fallito: `not_failed`. */
const deleteFailedSend: Mail["deleteFailedSend"] = async (messageId) => {
  try {
    return await restoreOf((await appClient().mail.deleteFailedSend(messageId)) as never);
  } catch (error) {
    throw sendError(error);
  }
};

export const mailSendFunctions: Partial<Mail> = {
  MAIL_UNDO_MS,
  MAIL_MAX_ATTACHMENTS,
  MAIL_MAX_BYTES,
  sendDraft,
  whenSendSettled,
  undoSend,
  retrySend,
  deleteFailedSend,
};
