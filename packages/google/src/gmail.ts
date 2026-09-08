/**
 * Gmail API in sola lettura, più la parte che non è rete: **da MIME a testo**.
 *
 * L'estrazione del testo (`extractText`) è qui e non nel worker perché è la
 * cosa più facile da sbagliare di tutta la fase 6 e l'unica che si può testare
 * senza un Postgres: un'email vera è un albero MIME con due versioni dello
 * stesso corpo, la firma di chi scrive, e la citazione dell'intero thread
 * precedente. Passare quella roba al modello significa classificare dieci volte
 * la stessa conversazione e pagarla ogni volta.
 */
import { z } from "zod";
import { buildUrl, parseGoogleJson, requestGoogle, type GoogleClientOptions } from "./fetch.js";

/** Base delle API Gmail sulla casella del token (`me`). */
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Cap del testo estratto: lo stesso limite che il design dà a
 * `email_messages.text_excerpt` (§4). Il testo tagliato lo DICHIARA con
 * {@link TEXT_TRUNCATION_MARKER}, così né un umano né il modello lo leggono
 * come un'email finita.
 */
export const MAX_TEXT_LENGTH = 20_000;

/** Marcatore in coda al testo troncato. */
export const TEXT_TRUNCATION_MARKER = "… [troncato]";

/**
 * Header che servono al routing e alla scheda del messaggio, più — dalla
 * fase 6c — quelli che {@link looksAutomated}/`admit` in
 * `@stubwise/notifications` usano per riconoscere la posta automatica
 * (`List-Unsubscribe`, `List-Id`, `Precedence`, `Auto-Submitted`). Non è una
 * chiamata in più: `getMessageMetadata` chiede questi header nella STESSA
 * risposta `format=metadata`.
 */
export const DEFAULT_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "Message-Id",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
] as const;

/** Nodo dell'albero MIME come lo restituisce Gmail. */
export interface GmailPayload {
  mimeType?: string;
  /** Non vuoto = allegato: il suo testo non è il corpo dell'email. */
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayload[];
}

/** Un messaggio Gmail normalizzato (metadata o full). */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string | null;
  /** `internalDate` di Gmail (ms epoch) come Date: è il `received_at` della riga. */
  internalDate: Date | null;
  /** Header con la chiave in MINUSCOLO: `from`, `to`, `cc`, `subject`, … */
  headers: Record<string, string>;
  /** Presente solo con `format=full`. */
  payload?: GmailPayload;
}

const payloadSchema: z.ZodType<GmailPayload> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z.object({ size: z.number().optional(), data: z.string().optional(), attachmentId: z.string().optional() }).optional(),
    parts: z.array(payloadSchema).optional(),
  }),
);

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  payload: payloadSchema.optional(),
});

const historySchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string().optional(),
        messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
      }),
    )
    .optional(),
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
});

const messagesListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});

/** Normalizza un messaggio: header in minuscolo, `internalDate` come Date. */
function toMessage(api: string, payload: unknown): GmailMessage {
  const raw = parseGoogleJson(api, messageSchema, payload);
  const headers: Record<string, string> = {};
  for (const header of raw.payload?.headers ?? []) headers[header.name.toLowerCase()] = header.value;
  const internalMs = raw.internalDate ? Number(raw.internalDate) : Number.NaN;
  const message: GmailMessage = {
    id: raw.id,
    threadId: raw.threadId ?? raw.id,
    labelIds: raw.labelIds ?? [],
    snippet: raw.snippet ?? "",
    historyId: raw.historyId ?? null,
    internalDate: Number.isFinite(internalMs) ? new Date(internalMs) : null,
    headers,
  };
  if (raw.payload) message.payload = raw.payload;
  return message;
}

/** Argomenti di `history.list`. */
export interface ListHistoryInput {
  accessToken: string;
  /** Punto di ripartenza: `google_accounts.gmail_history_id`. */
  startHistoryId: string;
  pageToken?: string | null;
  maxResults?: number;
  historyTypes?: string[];
  labelId?: string | null;
}

/** Una pagina di `history.list`, ridotta a ciò che il poller usa. */
export interface GmailHistoryPage {
  /** Id dei messaggi comparsi, nell'ordine di arrivo e senza duplicati. */
  addedMessageIds: string[];
  /** Nuovo punto di ripartenza da salvare a fine ciclo. */
  historyId: string | null;
  nextPageToken: string | null;
}

/**
 * Incrementale: cosa è successo nella casella dopo `startHistoryId`.
 *
 * ⚠️ Un **404** qui NON è "non trovato": è la history che Gmail non conserva più
 * (tipicamente oltre una settimana di silenzio). Diventa `history_expired`, che
 * NON è fatale — il poller ricade su `messages.list` per un resync (design §4).
 */
export async function listHistory(
  input: ListHistoryInput,
  options: GoogleClientOptions = {},
): Promise<GmailHistoryPage> {
  const api = "gmail.history.list";
  const payload = await requestGoogle(
    {
      api,
      url: buildUrl(`${GMAIL_API_BASE}/history`, {
        startHistoryId: input.startHistoryId,
        historyTypes: input.historyTypes ?? ["messageAdded"],
        pageToken: input.pageToken ?? undefined,
        maxResults: input.maxResults,
        labelId: input.labelId ?? undefined,
      }),
      accessToken: input.accessToken,
      statusCodes: { 404: "history_expired" },
    },
    options,
  );
  const raw = parseGoogleJson(api, historySchema, payload);
  const seen = new Set<string>();
  const addedMessageIds: string[] = [];
  for (const entry of raw.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      const id = added.message.id;
      if (seen.has(id)) continue;
      seen.add(id);
      addedMessageIds.push(id);
    }
  }
  return {
    addedMessageIds,
    historyId: raw.historyId ?? null,
    nextPageToken: raw.nextPageToken ?? null,
  };
}

/** Argomenti di `messages.list`. */
export interface ListMessagesInput {
  accessToken: string;
  /** Query Gmail, es. `newer_than:7d -from:me`. */
  q?: string;
  pageToken?: string | null;
  maxResults?: number;
  labelIds?: string[];
}

/** Una pagina di `messages.list`. */
export interface GmailMessagesPage {
  messageIds: string[];
  nextPageToken: string | null;
}

/** Elenco dei messaggi che soddisfano la query: è il resync quando la history è scaduta. */
export async function listMessages(
  input: ListMessagesInput,
  options: GoogleClientOptions = {},
): Promise<GmailMessagesPage> {
  const api = "gmail.messages.list";
  const payload = await requestGoogle(
    {
      api,
      url: buildUrl(`${GMAIL_API_BASE}/messages`, {
        q: input.q,
        pageToken: input.pageToken ?? undefined,
        maxResults: input.maxResults,
        labelIds: input.labelIds,
      }),
      accessToken: input.accessToken,
    },
    options,
  );
  const raw = parseGoogleJson(api, messagesListSchema, payload);
  return {
    messageIds: (raw.messages ?? []).map((message) => message.id),
    nextPageToken: raw.nextPageToken ?? null,
  };
}

/**
 * Solo header ed etichette (`format=metadata`). È il PRE-FILTRO del poller: il
 * corpo si scarica solo per i messaggi che il routing tiene, così una casella
 * rumorosa non costa una `messages.get full` per ogni newsletter.
 */
export async function getMessageMetadata(
  input: { accessToken: string; id: string; headers?: readonly string[] },
  options: GoogleClientOptions = {},
): Promise<GmailMessage> {
  const api = "gmail.messages.get.metadata";
  const payload = await requestGoogle(
    {
      api,
      url: buildUrl(`${GMAIL_API_BASE}/messages/${encodeURIComponent(input.id)}`, {
        format: "metadata",
        metadataHeaders: [...(input.headers ?? DEFAULT_METADATA_HEADERS)],
      }),
      accessToken: input.accessToken,
    },
    options,
  );
  return toMessage(api, payload);
}

/** Messaggio completo (`format=full`): header + albero MIME da dare a {@link extractText}. */
export async function getMessageFull(
  input: { accessToken: string; id: string },
  options: GoogleClientOptions = {},
): Promise<GmailMessage> {
  const api = "gmail.messages.get.full";
  const payload = await requestGoogle(
    {
      api,
      url: buildUrl(`${GMAIL_API_BASE}/messages/${encodeURIComponent(input.id)}`, { format: "full" }),
      accessToken: input.accessToken,
    },
    options,
  );
  return toMessage(api, payload);
}

/** Decodifica il base64url di Gmail (`-`/`_` al posto di `+`/`/`, padding assente). */
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Raccoglie ricorsivamente le parti testuali NON allegate, per mime type. */
function collectTextParts(node: GmailPayload, plain: string[], html: string[]): void {
  for (const part of node.parts ?? []) collectTextParts(part, plain, html);
  // `filename` non vuoto = allegato: un .txt allegato non è il corpo dell'email.
  if (node.filename) return;
  const data = node.body?.data;
  if (!data) return;
  const mime = (node.mimeType ?? "").toLowerCase();
  if (mime.startsWith("text/plain")) plain.push(decodeBase64Url(data));
  else if (mime.startsWith("text/html")) html.push(decodeBase64Url(data));
}

/** Tabella delle entità nominate che compaiono davvero nelle email. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  agrave: "à",
  egrave: "è",
  eacute: "é",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
};

/**
 * Decodifica le entità in UN SOLO passaggio: `&amp;lt;` deve restare `&lt;`,
 * non diventare `<`. Due `replace` in sequenza farebbero l'errore opposto.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * HTML → testo. Non è un renderer: butta via ciò che non è prosa (`<style>`,
 * `<script>`, `<head>`, i `<blockquote>` che sono la citazione del thread),
 * trasforma in a-capo i tag di blocco, toglie i tag rimasti e SOLO ALLA FINE
 * decodifica le entità — in quest'ordine, perché un `&lt;CET&gt;` decodificato
 * prima verrebbe poi tolto come se fosse un tag.
 */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // I blockquote annidati si tolgono dal più interno, ripetendo finché ce ne sono.
  for (let i = 0; i < 10; i += 1) {
    const next = text.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi, "");
    if (next === text) break;
    text = next;
  }
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote|section|article)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n");
  return text;
}

/** Riga che apre la citazione del messaggio precedente, in inglese e in italiano. */
const QUOTE_HEADERS = [/^\s*On\b[\s\S]{0,300}\bwrote:\s*$/i, /^\s*Il\b[\s\S]{0,300}\bha scritto:\s*$/i];

/** Separatore di firma dello standard (`-- ` su riga propria). */
const SIGNATURE_SEPARATOR = /^--\s?$/;

/**
 * Toglie ciò che non è il messaggio di QUESTA email: la citazione del thread
 * precedente e la firma.
 *
 * La citazione si riconosce dalla riga d'apertura, che i client spezzano
 * volentieri su due righe ("… Bob <bob@…> ha" / "scritto:"): per questo il
 * confronto si fa anche sulla coppia di righe unita, non solo sulla singola.
 */
export function stripQuotedAndSignature(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (SIGNATURE_SEPARATOR.test(line)) {
      cut = i;
      break;
    }
    const joined = `${line} ${lines[i + 1] ?? ""}`.trim();
    if (QUOTE_HEADERS.some((re) => re.test(line) || re.test(joined))) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut).filter((line) => !/^\s*>/.test(line));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Tronca al cap dichiarando il taglio. */
export function capText(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
  if (text.length <= maxLength) return text;
  const room = Math.max(0, maxLength - TEXT_TRUNCATION_MARKER.length);
  return `${text.slice(0, room).trimEnd()}${TEXT_TRUNCATION_MARKER}`;
}

/** Opzioni di {@link extractText}. */
export interface ExtractTextOptions {
  maxLength?: number;
}

/**
 * Da albero MIME a testo pulito e capped.
 *
 * Preferenza `text/plain` su `text/html`: quando ci sono entrambi sono la
 * stessa cosa detta due volte, e il plain è già testo — convertire l'HTML
 * significa solo aggiungere occasioni di sbagliare.
 */
export function extractText(payload: GmailPayload, options: ExtractTextOptions = {}): string {
  const plain: string[] = [];
  const html: string[] = [];
  collectTextParts(payload, plain, html);
  const raw = plain.length > 0 ? plain.join("\n") : html.length > 0 ? htmlToText(html.join("\n")) : "";
  if (!raw.trim()) return "";
  return capText(stripQuotedAndSignature(raw), options.maxLength ?? MAX_TEXT_LENGTH);
}
