import { extractRawBody, type GmailMessage } from "@stubwise/google";

/**
 * L'EMAIL DEGLI APPUNTI DI GEMINI (area 6, F5a, C1 del piano).
 *
 * `From: gemini-notes@google.com` si scrive da chiunque: la si riconosce
 * SOLO se (a) il mittente è quello, (b) la PRIMA intestazione
 * `Authentication-Results` — quella che Gmail mette in cima ricevendo,
 * `mx.google.com` — dice DMARC passato per `google.com` o DKIM passato con
 * `google.com` (un mittente falso può aggiungere la sua intestazione, ma
 * sotto quella di Gmail), (c) il corpo ha un link a un Google Doc. In
 * dubbio è un'email normale: si perde una riunione registrata, mai si
 * scambia un'email qualunque per gli appunti di una riunione.
 */

export const GEMINI_SENDER = "gemini-notes@google.com";

const DOC_LINK = /https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/;

function senderOf(message: GmailMessage): string {
  const from = message.headers.from ?? "";
  const angle = /<([^>]+)>/.exec(from);
  return (angle ? angle[1]! : from).trim().toLowerCase();
}

function gmailVerdictPasses(message: GmailMessage): boolean {
  const first = (message.payload?.headers ?? []).find((h) => h.name.toLowerCase() === "authentication-results");
  if (!first) return false;
  const value = first.value;
  if (!/^\s*mx\.google\.com\s*;/i.test(value)) return false;
  const dmarc = /\bdmarc=pass\b[^;]*\bheader\.from=google\.com\b/i.test(value);
  const dkim = /\bdkim=pass\b[^;]*\bheader\.(?:d=google\.com|i=@google\.com)\b/i.test(value);
  return dmarc || dkim;
}

/** Il titolo della riunione dall'oggetto («Notes: “Titolo”»), per l'aggancio di ripiego all'evento. */
function meetingTitleOf(subject: string | undefined): string | null {
  if (!subject) return null;
  const quoted = /[“"']([^”"']+)[”"']/.exec(subject);
  const title = (quoted ? quoted[1]! : subject.replace(/^[^:]*:\s*/, "")).trim();
  return title === "" ? null : title;
}

export function recognizeGeminiNotes(message: GmailMessage): { docFileId: string; meetingTitle: string | null } | null {
  if (senderOf(message) !== GEMINI_SENDER) return null;
  if (!gmailVerdictPasses(message)) return null;
  const body = message.payload ? extractRawBody(message.payload) : { text: null, html: null };
  const match = DOC_LINK.exec(`${body.html ?? ""}\n${body.text ?? ""}`);
  if (!match) return null;
  return { docFileId: match[1]!, meetingTitle: meetingTitleOf(message.headers.subject) };
}
