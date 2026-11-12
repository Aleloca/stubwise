import { randomBytes } from "node:crypto";
import { GMAIL_API_BASE, htmlToText } from "./gmail.js";
import { buildUrl, parseGoogleJson, requestGoogle, type GoogleClientOptions } from "./fetch.js";
import { z } from "zod";

/**
 * SCRIVERE SU GMAIL (area 6, fetta 3): il messaggio MIME e le bozze di Gmail
 * (D7 = b). Testo semplice (`text/plain`, UTF-8) *(O)*, allegati in
 * `multipart/mixed`, la risposta nel thread con `In-Reply-To`/`References`.
 *
 * Ogni chiamata qui è una SCRITTURA verso Google (tranne `getDraft`): la fa
 * solo una rotta chiamata da un gesto della persona, o il worker allo scadere
 * di un invio che una persona ha chiesto. Vogliono `gmail.modify`.
 */

export interface MailAddressInput {
  email: string;
  name?: string | null;
}

export interface MimeAttachment {
  name: string;
  mimeType: string;
  content: Buffer;
}

export interface MimeInput {
  from: MailAddressInput;
  to: readonly MailAddressInput[];
  cc: readonly MailAddressInput[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  /** La catena del thread, dal più vecchio (review F3, punto 7). */
  references?: readonly string[];
  /** Un Message-ID nostro (review F3, punto 6): il poller riconosce così l'email mandata da Stubwise. */
  messageId?: string | null;
  attachments?: readonly MimeAttachment[];
}

/** Toglie CR e LF: un'intestazione non può aprirne un'altra (nessuna iniezione). */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Byte UTF-8 per encoded word: 45 → 60 caratteri di base64, la parola resta ≤ 75 (RFC 2047). */
const WORD_BYTES = 45;
/** Lunghezza a cui si ripiega un'intestazione ASCII lunga (il tetto è 998, RFC 5322). */
const FOLD_AT = 76;

/** Ripiega un valore ASCII sugli spazi: nessuna riga oltre il tetto. */
function foldAscii(value: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > FOLD_AT) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  // Una «parola» più lunga del tetto (senza spazi) si spezza comunque sotto i 998.
  return lines.flatMap((l) => l.match(/.{1,900}/g) ?? [""]).join("\r\n ");
}

/**
 * RFC 2047 per i valori non ASCII, a parole di al più 75 caratteri ripiegate
 * (review F3, punto 7: senza spezzare un carattere fra due parole); ASCII
 * resta com'è, ripiegato se lungo.
 */
function encodeWord(value: string): string {
  const clean = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return foldAscii(clean);
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, "utf8") > WORD_BYTES) {
      words.push(chunk);
      chunk = ch;
    } else {
      chunk += ch;
    }
  }
  if (chunk !== "") words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** Il `name` di `Content-Type`: ASCII con l'escape, altrimenti UNA encoded word (dentro le virgolette non si ripiega). */
function contentTypeName(name: string): string {
  const clean = oneLine(name);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean.replace(/(["\\])/g, "\\$1");
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** Il nome di un file per `Content-Disposition`: il ripiego ASCII quotato con l'escape, e `filename*` (RFC 2231). */
function filenameParams(name: string): string {
  const clean = oneLine(name);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/(["\\])/g, "\\$1");
  const extended = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${ascii}"; filename*=UTF-8''${extended}`;
}

function formatAddress(address: MailAddressInput): string {
  const email = oneLine(address.email);
  if (!address.name?.trim()) return email;
  const name = oneLine(address.name);
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeWord(name);
  return `${display} <${email}>`;
}

/** Base64 a righe di 76 caratteri (RFC 2045). */
function base64Lines(content: Buffer): string {
  return (content.toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/** Il messaggio RFC 5322 completo, con le righe terminate da CRLF. */
export function buildMimeMessage(input: MimeInput): string {
  const headers = [
    "MIME-Version: 1.0",
    `From: ${formatAddress(input.from)}`,
    `To: ${input.to.map(formatAddress).join(", ")}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.map(formatAddress).join(", ")}`] : []),
    `Subject: ${encodeWord(input.subject)}`,
    ...(input.messageId ? [`Message-ID: ${oneLine(input.messageId)}`] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${oneLine(input.inReplyTo)}`] : []),
    ...(input.references && input.references.length > 0 ? [`References: ${input.references.map(oneLine).join(" ")}`] : []),
  ];
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(input.body, "utf8")),
  ].join("\r\n");
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return [...headers, textPart].join("\r\n");

  const boundary = `stubwise-${randomBytes(12).toString("hex")}`;
  const parts = [
    textPart,
    ...attachments.map((a) =>
      [
        `Content-Type: ${oneLine(a.mimeType)}; name="${contentTypeName(a.name)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; ${filenameParams(a.name)}`,
        "",
        base64Lines(a.content),
      ].join("\r\n"),
    ),
  ];
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts.map((part) => `--${boundary}\r\n${part}`),
    `--${boundary}--`,
  ].join("\r\n");
}

/** Il `raw` che Gmail vuole: base64url senza padding. */
export function encodeRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

const draftSchema = z.object({
  id: z.string(),
  message: z.object({ id: z.string(), threadId: z.string().optional() }).optional(),
});

/** Una bozza come la conserva Stubwise: l'id e la versione (l'id del suo messaggio). */
export interface GmailDraftRef {
  id: string;
  messageId: string | null;
  threadId: string | null;
}

function toRef(api: string, payload: unknown): GmailDraftRef {
  const raw = parseGoogleJson(api, draftSchema, payload);
  return { id: raw.id, messageId: raw.message?.id ?? null, threadId: raw.message?.threadId ?? null };
}

export async function createDraft(
  input: { accessToken: string; raw: string; threadId?: string | null },
  options: GoogleClientOptions = {},
): Promise<GmailDraftRef> {
  const api = "gmail.drafts.create";
  const payload = await requestGoogle(
    { api, url: `${GMAIL_API_BASE}/drafts`, method: "POST", accessToken: input.accessToken, json: { message: { raw: input.raw, ...(input.threadId ? { threadId: input.threadId } : {}) } } },
    options,
  );
  return toRef(api, payload);
}

export async function updateDraft(
  input: { accessToken: string; id: string; raw: string; threadId?: string | null },
  options: GoogleClientOptions = {},
): Promise<GmailDraftRef> {
  const api = "gmail.drafts.update";
  const payload = await requestGoogle(
    {
      api,
      url: `${GMAIL_API_BASE}/drafts/${encodeURIComponent(input.id)}`,
      method: "PUT",
      accessToken: input.accessToken,
      json: { message: { raw: input.raw, ...(input.threadId ? { threadId: input.threadId } : {}) } },
    },
    options,
  );
  return toRef(api, payload);
}

/** Legge solo l'identità della bozza (la versione per il conflitto). */
export async function getDraft(input: { accessToken: string; id: string }, options: GoogleClientOptions = {}): Promise<GmailDraftRef> {
  const api = "gmail.drafts.get";
  const payload = await requestGoogle(
    { api, url: buildUrl(`${GMAIL_API_BASE}/drafts/${encodeURIComponent(input.id)}`, { format: "minimal" }), accessToken: input.accessToken },
    options,
  );
  return toRef(api, payload);
}

export async function deleteDraft(input: { accessToken: string; id: string }, options: GoogleClientOptions = {}): Promise<void> {
  await requestGoogle(
    { api: "gmail.drafts.delete", url: `${GMAIL_API_BASE}/drafts/${encodeURIComponent(input.id)}`, method: "DELETE", accessToken: input.accessToken, expectEmpty: true },
    options,
  );
}

const sentSchema = z.object({ id: z.string(), threadId: z.string() });

/** Manda la bozza: la bozza sparisce da Gmail e nasce il messaggio mandato. */
export async function sendDraft(
  input: { accessToken: string; id: string },
  options: GoogleClientOptions = {},
): Promise<{ messageId: string; threadId: string }> {
  const api = "gmail.drafts.send";
  const payload = await requestGoogle(
    { api, url: `${GMAIL_API_BASE}/drafts/send`, method: "POST", accessToken: input.accessToken, json: { id: input.id } },
    options,
  );
  const raw = parseGoogleJson(api, sentSchema, payload);
  return { messageId: raw.id, threadId: raw.threadId };
}

const sendAsSchema = z.object({ sendAsEmail: z.string().optional(), signature: z.string().optional().nullable() });

/**
 * La firma di Gmail di un indirizzo mittente (`users.settings.sendAs.get`),
 * in testo: mandiamo text/plain. `null` se l'indirizzo non ha firma. Basta
 * `gmail.modify` (la lettura accetta anche `gmail.readonly`;
 * `gmail.settings.basic` serve solo a CAMBIARE le impostazioni).
 */
export async function getSendAsSignature(
  input: { accessToken: string; sendAsEmail: string },
  options: GoogleClientOptions = {},
): Promise<string | null> {
  const api = "gmail.settings.sendAs.get";
  const payload = await requestGoogle(
    { api, url: `${GMAIL_API_BASE}/settings/sendAs/${encodeURIComponent(input.sendAsEmail)}`, accessToken: input.accessToken },
    options,
  );
  const parsed = sendAsSchema.safeParse(payload);
  const html = parsed.success ? (parsed.data.signature ?? "") : "";
  const text = htmlToText(html).trim();
  return text === "" ? null : text;
}
