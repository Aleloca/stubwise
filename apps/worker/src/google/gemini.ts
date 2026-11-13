import { extractRawBody, type GmailMessage } from "@stubwise/google";

/**
 * L'EMAIL DEGLI APPUNTI DI GEMINI (area 6, F5a, C1 del piano).
 *
 * `From: gemini-notes@google.com` si scrive da chiunque: la si riconosce
 * SOLO se (a) il mittente è quello, (b) la PRIMA intestazione
 * `Authentication-Results` — quella che Gmail mette in cima ricevendo,
 * `mx.google.com` — dice DMARC passato per `google.com` esattamente (un mittente falso può aggiungere la sua intestazione, ma
 * sotto quella di Gmail), (c) il corpo ha un link a un Google Doc. In
 * dubbio è un'email normale: si perde una riunione registrata, mai si
 * scambia un'email qualunque per gli appunti di una riunione.
 */

export const GEMINI_SENDER = "gemini-notes@google.com";

const DOC_LINK = /https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/g;
/** Quanti link a un Doc si tengono come candidati. */
export const GEMINI_MAX_DOC_CANDIDATES = 5;

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
  // Review F5a, punto 7: DMARC passato per google.com, ESATTAMENTE (non
  // `google.com.evil.tld`): un DKIM da solo non lega la firma al mittente.
  return /\bdmarc=pass\b[^;]*\bheader\.from=google\.com(?![\w.-])/i.test(value);
}

/** Il titolo della riunione dall'oggetto («Notes: “Titolo”»), per l'aggancio di ripiego all'evento. */
export function meetingTitleOf(subject: string | undefined): string | null {
  if (!subject) return null;
  const quoted = /[“"']([^”"']+)[”"']/.exec(subject);
  const title = (quoted ? quoted[1]! : subject.replace(/^[^:]*:\s*/, "")).trim();
  return title === "" ? null : title;
}

/**
 * ⚠️ Review F5a, punto 2: i link ai Doc sono CANDIDATI. Il titolo della
 * riunione (che sceglie l'organizzatore) è ripetuto nel corpo, e può
 * contenere il link a un ALTRO Doc che chi riceve può leggere: il worker
 * legge solo un candidato che verifica su Drive (`meetings.ts`), mai il primo
 * per fiducia.
 */
export function recognizeGeminiNotes(message: GmailMessage): { docCandidates: string[]; meetingTitle: string | null } | null {
  if (senderOf(message) !== GEMINI_SENDER) return null;
  if (!gmailVerdictPasses(message)) return null;
  const body = message.payload ? extractRawBody(message.payload) : { text: null, html: null };
  const ids = [...new Set([...`${body.html ?? ""}\n${body.text ?? ""}`.matchAll(DOC_LINK)].map((m) => m[1]!))].slice(0, GEMINI_MAX_DOC_CANDIDATES);
  if (ids.length === 0) return null;
  return { docCandidates: ids, meetingTitle: meetingTitleOf(message.headers.subject) };
}
