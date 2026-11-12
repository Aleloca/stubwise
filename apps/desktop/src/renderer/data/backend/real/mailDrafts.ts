import { ApiError } from "@stubwise/api-client";
import type { MailDraft as ServerDraft } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { MailAddress, MailDraft } from "../../types";
import { appClient, session } from "./client";
import { myAccounts } from "./google";
import { splitThreadKey, threadKey } from "./mailKeys";

// Le bozze della Posta nella build app (area 6, fetta 3): bozze di GMAIL
// (D7 = b del maintainer), una per persona, conversazione e modalità.
// L'indirizzamento di Rispondi, Rispondi a tutti e Inoltra lo calcola il
// server (`draft()`), che non salva né chiama Google finché non si salva.
// Gli allegati hanno le loro rotte (dopo); lo slot «Scrivigli anche per
// email» di Support (area 8) non c'è.

type Mail = typeof Fake.mail;

/** Una bozza mai salvata: il server la dà con `id: null`; qui ha l'id del suo posto. */
const UNSAVED = "unsaved_";
const placeId = (accountId: string, threadId: string | null, mode: string) =>
  `${UNSAVED}${accountId}_${threadId ?? "new"}_${mode}`;

function addressesOf(list: ServerDraft["to"], mine: ReadonlySet<string>): MailAddress[] {
  return list.map((a) => ({
    name: a.name ?? a.email,
    email: a.email,
    personId: mine.has(a.email.toLowerCase()) ? (session.personId ?? null) : null,
  }));
}

export function draftOf(d: ServerDraft, mine: ReadonlySet<string>): MailDraft {
  return {
    id: d.id ?? placeId(d.accountId, d.threadId, d.mode),
    personId: session.personId ?? "",
    threadId: d.threadId === null ? null : threadKey(d.accountId, d.threadId),
    mode: d.mode,
    replyToMessageId: d.replyToMessageId,
    to: addressesOf(d.to, mine),
    cc: addressesOf(d.cc, mine),
    subject: d.subject,
    body: d.body,
    attachments: d.attachments.map((a) => ({ ...a })),
    // Rispondi cita il messaggio sotto salvo che chi scrive l'abbia tolto; Inoltra sempre.
    ...(d.quote ? {} : { quote: false }),
    updatedAt: d.updatedAt ?? new Date().toISOString(),
  };
}

/** Le mie caselle: gli indirizzi (per riconoscermi) e quella dell'email nuova (la prima collegata). */
export async function myMailboxes(): Promise<{ mine: Set<string>; firstConnected: string | null }> {
  const accounts = await myAccounts();
  return {
    mine: new Set(accounts.map((a) => a.email.toLowerCase())),
    firstConnected: accounts.find((a) => a.disabledAt === null)?.id ?? null,
  };
}

/** La casella e il thread Gmail di una conversazione, o della nuova email. */
function placeOf(threadId: string | null, firstConnected: string | null): { accountId: string; thread: string | null } {
  if (threadId === null) {
    if (!firstConnected) throw new Error("google_not_connected");
    return { accountId: firstConnected, thread: null };
  }
  const parts = splitThreadKey(threadId);
  if (!parts) throw new Error("not_found");
  return { accountId: parts.accountId, thread: parts.threadId };
}

/** Gli errori del server su una bozza, nelle parole del prototipo. */
function draftError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code === "draft_changed") return new Error("draft_changed");
  if (error.code === "google_scope_missing") return new Error("google_scope_missing");
  if (error.code === "account_disabled" || error.code === "token_expired") return new Error("google_not_connected");
  if (error.code === "google_unavailable" || error.status === 502) return new Error("google_unavailable");
  if (error.status === 404) return new Error("not_found");
  return error;
}

const listDrafts: Mail["listDrafts"] = async () => {
  const [{ items }, { mine }] = await Promise.all([appClient().mail.drafts(), myMailboxes()]);
  return items
    .map((d) => draftOf(d as ServerDraft, mine))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
};

const getDraft: Mail["getDraft"] = async (threadId, mode, slot) => {
  if (slot) throw new Error("invalid: slot");
  const { mine, firstConnected } = await myMailboxes();
  const { accountId, thread } = placeOf(threadId, firstConnected);
  try {
    return draftOf((await appClient().mail.draft({ account: accountId, thread, mode })) as ServerDraft, mine);
  } catch (error) {
    throw draftError(error);
  }
};

/**
 * Salva la bozza su Gmail (crea o sostituisce quella del suo posto). Una
 * bozza modificata da Gmail nel frattempo è `draft_changed`: non vince
 * l'ultimo, si ricarica.
 */
const saveDraft: Mail["saveDraft"] = async (input) => {
  if (input.slot) throw new Error("invalid: slot");
  const { mine, firstConnected } = await myMailboxes();
  const { accountId, thread } = placeOf(input.threadId, firstConnected);
  const address = (a: MailAddress) => ({ email: a.email, name: a.name && a.name !== a.email ? a.name : null });
  try {
    const saved = await appClient().mail.saveDraft({
      accountId,
      threadId: thread,
      mode: input.mode,
      replyToMessageId: input.replyToMessageId,
      to: input.to.map(address),
      cc: input.cc.map(address),
      subject: input.subject,
      body: input.body,
      quote: input.quote !== false,
    });
    return draftOf(saved as ServerDraft, mine);
  } catch (error) {
    throw draftError(error);
  }
};

/** Elimina la bozza, su Gmail e in Stubwise; una mai salvata non c'è da eliminare. */
const discardDraft: Mail["discardDraft"] = async (id) => {
  if (id.startsWith(UNSAVED)) return;
  try {
    await appClient().mail.discardDraft(id);
  } catch (error) {
    throw draftError(error);
  }
};

/** «Annulla» di «Elimina»: la bozza eliminata si salva di nuovo, com'era. */
const restoreDiscardedDraft: Mail["restoreDiscardedDraft"] = async (snapshot) => ({
  draft: await saveDraft(snapshot),
  droppedAttachments: [],
});

export const mailDraftFunctions: Partial<Mail> = {
  listDrafts,
  getDraft,
  saveDraft,
  discardDraft,
  restoreDiscardedDraft,
};
