import { emailMessages, googleAccounts, mailDraftAttachments, mailDrafts, type Db } from "@stubwise/db";
import {
  buildMimeMessage,
  createDraft,
  deleteDraft,
  encodeRaw,
  getDraft,
  GMAIL_MODIFY_SCOPE,
  GoogleApiError,
  missingGoogleScopes,
  refreshAccessToken,
  updateDraft,
} from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import { normalizeAddress } from "@stubwise/notifications";
import type { MailComposeAddress, MailComposeMode, MailDraft } from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * LE BOZZE DELLA POSTA (area 6, fetta 3, D7 = b): bozze di GMAIL. Stubwise
 * tiene accanto all'id della bozza ciò che Gmail non sa (modalità, citazione,
 * il messaggio a cui si risponde) e la copia dell'ultimo salvataggio, per
 * leggere l'elenco senza una chiamata per bozza *(O)*.
 *
 * Ogni scrittura verso Gmail parte da un gesto (Salva, Elimina): queste
 * funzioni le chiama solo una rotta. La bozza è di chi scrive: l'id di chi
 * guarda nella WHERE, una bozza altrui è `not_found`. Si scrive solo dalle
 * PROPRIE caselle, vive e con `gmail.modify`.
 *
 * Il conflitto: al salvataggio si legge la versione della bozza su Gmail (l'id
 * del suo messaggio); se è diversa da quella vista l'ultima volta, qualcuno
 * l'ha cambiata da Gmail, e si risponde `draft_changed` invece di
 * sovrascriverla in silenzio. Una bozza sparita da Gmail (inviata o eliminata
 * da lì) si ricrea.
 */

export interface MailComposeClient {
  refreshAccessToken: typeof refreshAccessToken;
  createDraft: typeof createDraft;
  updateDraft: typeof updateDraft;
  getDraft: typeof getDraft;
  deleteDraft: typeof deleteDraft;
}

export const realMailComposeClient: MailComposeClient = { refreshAccessToken, createDraft, updateDraft, getDraft, deleteDraft };

export type DraftError =
  | { error: "not_found" }
  | { error: "account_disabled" }
  | { error: "google_scope_missing"; missing: string[] }
  | { error: "account_unavailable" }
  | { error: "token_expired" }
  | { error: "draft_changed" }
  | { error: "google_unavailable" };

type DraftRow = typeof mailDrafts.$inferSelect;

/** La casella di chi scrive, pronta per scrivere su Gmail. */
async function writableAccount(db: Db, userId: string, accountId: string) {
  const [account] = await db
    .select({ id: googleAccounts.id, email: googleAccounts.email, scopes: googleAccounts.scopes, disabledAt: googleAccounts.disabledAt })
    .from(googleAccounts)
    .where(and(eq(googleAccounts.id, accountId), eq(googleAccounts.userId, userId)));
  if (!account) return { error: "not_found" as const };
  if (account.disabledAt) return { error: "account_disabled" as const };
  if (!account.scopes.includes(GMAIL_MODIFY_SCOPE)) return { error: "google_scope_missing" as const, missing: missingGoogleScopes(account.scopes) };
  return { account };
}

async function accessTokenFor(db: Db, encryptionKey: Buffer, client: MailComposeClient, accountId: string) {
  const credentials = await loadGoogleAccountCredentials(db, encryptionKey, accountId);
  if (!credentials) return null;
  const tokens = await client.refreshAccessToken({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
  });
  return tokens.accessToken;
}

function googleError(err: unknown): DraftError {
  if (err instanceof GoogleApiError) {
    if (err.code === "invalid_grant" || err.status === 401) return { error: "token_expired" };
    if (err.code === "insufficient_scope") return { error: "google_scope_missing", missing: [GMAIL_MODIFY_SCOPE] };
  }
  return { error: "google_unavailable" };
}

async function toView(db: Db, row: DraftRow): Promise<MailDraft> {
  const attachments = await db.select().from(mailDraftAttachments).where(eq(mailDraftAttachments.draftId, row.id));
  return {
    id: row.id,
    accountId: row.accountId,
    threadId: row.threadId,
    mode: row.mode,
    replyToMessageId: row.replyToMessageId,
    to: row.toAddresses,
    cc: row.ccAddresses,
    subject: row.subject,
    body: row.body,
    attachments: attachments.map((a) => ({ id: a.id, name: a.name, sizeBytes: a.sizeBytes, driveFileId: a.driveFileId, as: a.as })),
    quote: row.quote,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Le MIE bozze attive. */
export async function listDrafts(db: Db, userId: string): Promise<MailDraft[]> {
  const rows = await db
    .select()
    .from(mailDrafts)
    .where(and(eq(mailDrafts.userId, userId), eq(mailDrafts.state, "active")))
    .orderBy(desc(mailDrafts.updatedAt));
  return Promise.all(rows.map((row) => toView(db, row)));
}

/** Il messaggio di riferimento di una risposta, nella casella di chi scrive. */
async function referenceMessage(db: Db, userId: string, accountId: string, threadId: string, replyTo: string | null) {
  const base = and(eq(emailMessages.accountId, accountId), eq(emailMessages.threadId, threadId), eq(googleAccounts.userId, userId));
  const [row] = await db
    .select({ message: emailMessages })
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(replyTo ? and(base, eq(emailMessages.id, replyTo)) : base)
    .orderBy(desc(emailMessages.receivedAt))
    .limit(1);
  return row?.message ?? null;
}

function withPrefix(prefix: "Re:" | "Fwd:", subject: string | null): string {
  const clean = (subject ?? "").trim();
  return new RegExp(`^${prefix.replace(":", "")}:`, "i").test(clean) ? clean : `${prefix} ${clean}`.trim();
}

/**
 * «La bozza di» una conversazione: quella salvata se c'è, altrimenti una nuova
 * GIÀ INDIRIZZATA dal server (non salvata). Rispondi = il mittente; Rispondi a
 * tutti = in più `to` e `cc`, meno le mie caselle; Inoltra = nessuno, «Fwd:».
 */
export async function draftFor(
  db: Db,
  userId: string,
  input: { accountId: string; threadId: string | null; mode: MailComposeMode; replyToMessageId: string | null },
): Promise<MailDraft | { error: "not_found" }> {
  const [account] = await db.select({ id: googleAccounts.id }).from(googleAccounts).where(and(eq(googleAccounts.id, input.accountId), eq(googleAccounts.userId, userId)));
  if (!account) return { error: "not_found" };
  const [saved] = await db
    .select()
    .from(mailDrafts)
    .where(
      and(
        eq(mailDrafts.userId, userId),
        eq(mailDrafts.accountId, input.accountId),
        eq(mailDrafts.mode, input.mode),
        eq(mailDrafts.state, "active"),
        sql`coalesce(${mailDrafts.threadId}, '') = ${input.threadId ?? ""}`,
      ),
    );
  if (saved) return toView(db, saved);

  const blank: MailDraft = {
    id: null,
    accountId: input.accountId,
    threadId: input.threadId,
    mode: input.mode,
    replyToMessageId: null,
    to: [],
    cc: [],
    subject: "",
    body: "",
    attachments: [],
    quote: input.mode !== "new",
    updatedAt: null,
  };
  if (input.mode === "new" || !input.threadId) return { ...blank, mode: input.threadId ? input.mode : "new" };
  const ref = await referenceMessage(db, userId, input.accountId, input.threadId, input.replyToMessageId);
  if (!ref) return { error: "not_found" };
  const mine = new Set(
    (await db.select({ email: googleAccounts.email }).from(googleAccounts).where(eq(googleAccounts.userId, userId))).map((a) => normalizeAddress(a.email)),
  );
  const sender: MailComposeAddress = { email: ref.fromAddress, name: ref.fromName };
  const dedupe = (list: MailComposeAddress[]) => {
    const seen = new Set<string>();
    return list.filter((a) => {
      const key = normalizeAddress(a.email);
      if (!key || mine.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  if (input.mode === "forward") {
    return { ...blank, replyToMessageId: ref.id, subject: withPrefix("Fwd:", ref.subject), quote: true };
  }
  const to = input.mode === "replyAll" ? dedupe([sender, ...ref.toAddresses.map((email) => ({ email, name: null }))]) : dedupe([sender]);
  const cc = input.mode === "replyAll" ? dedupe((ref.ccAddresses ?? []).map((email) => ({ email, name: null }))).filter((a) => !to.some((t) => t.email === a.email)) : [];
  return { ...blank, replyToMessageId: ref.id, to, cc, subject: withPrefix("Re:", ref.subject) };
}

/** Il testo che va su Gmail: il corpo, più la citazione se chiesta. */
async function composedBody(db: Db, body: string, quote: boolean, replyTo: string | null): Promise<{ text: string; inReplyTo: string | null }> {
  if (!replyTo) return { text: body, inReplyTo: null };
  const [ref] = await db.select().from(emailMessages).where(eq(emailMessages.id, replyTo));
  if (!ref) return { text: body, inReplyTo: null };
  const quoted = quote
    ? `\n\n${ref.receivedAt.toISOString().slice(0, 16).replace("T", " ")}, ${ref.fromName ? `${ref.fromName} <${ref.fromAddress}>` : ref.fromAddress}:\n${(ref.textExcerpt ?? "")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`
    : "";
  return { text: `${body}${quoted}`, inReplyTo: ref.rfcMessageId };
}

/**
 * Salva (crea o sostituisce) la bozza dello slot. È una scrittura verso Gmail:
 * la chiama solo la rotta di Salva.
 */
export async function saveDraft(
  db: Db,
  encryptionKey: Buffer,
  client: MailComposeClient,
  userId: string,
  input: {
    accountId: string;
    threadId: string | null;
    mode: MailComposeMode;
    replyToMessageId: string | null;
    to: MailComposeAddress[];
    cc: MailComposeAddress[];
    subject: string;
    body: string;
    quote: boolean;
  },
): Promise<MailDraft | DraftError> {
  const writable = await writableAccount(db, userId, input.accountId);
  if ("error" in writable) return writable as DraftError;
  // Il messaggio di riferimento deve essere nella casella di chi scrive.
  if (input.replyToMessageId) {
    const [ref] = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(eq(emailMessages.id, input.replyToMessageId), eq(emailMessages.accountId, input.accountId)));
    if (!ref) return { error: "not_found" };
  }
  const [existing] = await db
    .select()
    .from(mailDrafts)
    .where(
      and(
        eq(mailDrafts.userId, userId),
        eq(mailDrafts.accountId, input.accountId),
        eq(mailDrafts.mode, input.mode),
        eq(mailDrafts.state, "active"),
        sql`coalesce(${mailDrafts.threadId}, '') = ${input.threadId ?? ""}`,
      ),
    );

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFor(db, encryptionKey, client, input.accountId);
  } catch (err) {
    return googleError(err);
  }
  if (!accessToken) return { error: "account_unavailable" };

  const { text, inReplyTo } = await composedBody(db, input.body, input.quote, input.replyToMessageId);
  const raw = encodeRaw(
    buildMimeMessage({
      from: { email: writable.account.email },
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      body: text,
      inReplyTo,
      references: inReplyTo ? [inReplyTo] : [],
    }),
  );

  try {
    let ref;
    if (existing) {
      let current: Awaited<ReturnType<typeof getDraft>> | null = null;
      try {
        current = await client.getDraft({ accessToken, id: existing.gmailDraftId });
      } catch (err) {
        if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
      }
      if (current && existing.gmailMessageId && current.messageId !== existing.gmailMessageId) return { error: "draft_changed" };
      ref = current
        ? await client.updateDraft({ accessToken, id: existing.gmailDraftId, raw, threadId: input.threadId })
        : await client.createDraft({ accessToken, raw, threadId: input.threadId });
    } else {
      ref = await client.createDraft({ accessToken, raw, threadId: input.threadId });
    }
    const values = {
      gmailDraftId: ref.id,
      gmailMessageId: ref.messageId,
      replyToMessageId: input.replyToMessageId,
      toAddresses: input.to.map((a) => ({ email: a.email, name: a.name ?? null })),
      ccAddresses: input.cc.map((a) => ({ email: a.email, name: a.name ?? null })),
      subject: input.subject,
      body: input.body,
      quote: input.quote,
    };
    const [row] = existing
      ? await db.update(mailDrafts).set(values).where(eq(mailDrafts.id, existing.id)).returning()
      : await db
          .insert(mailDrafts)
          .values({ userId, accountId: input.accountId, threadId: input.threadId, mode: input.mode, ...values })
          .returning();
    return toView(db, row!);
  } catch (err) {
    return googleError(err);
  }
}

/** Elimina la bozza, su Gmail e qui. Una bozza già sparita da Gmail si toglie e basta. */
export async function discardDraft(db: Db, encryptionKey: Buffer, client: MailComposeClient, userId: string, id: string): Promise<{ ok: true } | DraftError> {
  const [row] = await db.select().from(mailDrafts).where(and(eq(mailDrafts.id, id), eq(mailDrafts.userId, userId), eq(mailDrafts.state, "active")));
  if (!row) return { error: "not_found" };
  try {
    const accessToken = await accessTokenFor(db, encryptionKey, client, row.accountId);
    if (!accessToken) return { error: "account_unavailable" };
    try {
      await client.deleteDraft({ accessToken, id: row.gmailDraftId });
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
    }
  } catch (err) {
    return googleError(err);
  }
  await db.delete(mailDrafts).where(eq(mailDrafts.id, row.id));
  return { ok: true };
}
