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
// o «Elimina» (la bozza torna). Gli errori dell'invio arrivano dopo, sul suo
// stato (`error`): il server accoda senza controllare destinatari e limiti.

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
function sendError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return new Error("not_found");
  if (error.code === "too_late" || error.code === "draft_slot_taken" || error.code === "not_failed") {
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

/** Una bozza tornata: gli allegati che non stanno più nei limiti, detti per nome. */
async function restoreOf(r: { draft: ServerDraft | null; droppedAttachments: readonly string[] }): Promise<MailDraftRestore> {
  if (!r.draft) throw new Error("not_found");
  const { mine } = await myMailboxes();
  const dropped = r.droppedAttachments.map<MailDraftAttachment>((name, i) => ({
    id: `dropped-${i}`,
    name,
    sizeBytes: 0,
    driveFileId: null,
    as: "copy",
  }));
  return { draft: draftOf(r.draft, mine), droppedAttachments: dropped };
}

/** «Annulla» entro i 10 s: la bozza torna. Dopo `too_late`; con un'altra bozza nella conversazione `draft_slot_taken`. */
const undoSend: Mail["undoSend"] = async (messageId) => {
  try {
    return await restoreOf((await appClient().mail.undoSend(messageId)) as never);
  } catch (error) {
    throw sendError(error);
  }
};

/** «Riprova» un invio fallito: un invio nuovo, coi suoi 10 s. */
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
