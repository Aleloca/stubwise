/**
 * Prompt builder della fase di raffinamento del backlog di discovery.
 *
 * Isola la costruzione dei prompt (system) usati dalla chat RAG di una voce e
 * dalle chiamate one-shot "aggiorna documento" e "fondi documenti", così le
 * route ({@link ./backlog.ts}) restano concentrate su trasporto/persistenza.
 * Il retrieval (scope/ranking) resta condiviso in {@link ./docs-retrieval.ts} e
 * le citazioni sono derivate da {@link ./docs-rag.ts} (UNICA definizione): qui
 * si compone soltanto il testo del prompt.
 */

import { CHAT_RETRIEVAL_K } from "./docs-rag.js";
import type { RetrievedChunk } from "./docs-retrieval.js";

/**
 * Numero di pagine di documentazione recuperate per la chat del backlog. Riusa
 * la costante della chat Docs ({@link CHAT_RETRIEVAL_K}): stesso ordine di
 * grandezza di contesto, un solo punto di verità.
 */
export const BACKLOG_RETRIEVAL_K = CHAT_RETRIEVAL_K;

/** Sottoinsieme dei campi della voce necessari a comporre i prompt. */
export interface BacklogItemContext {
  title: string;
  document: string;
  effort: number | null;
  risk: string | null;
  riskNote: string | null;
  urgency: string | null;
}

/** Ticket d'origine (role=origin) di una voce: titolo + corpo per il contesto. */
export interface OriginTicketContext {
  number: number;
  title: string;
  body: string;
}

/** Un messaggio della conversazione, già normalizzato ai due ruoli dell'LLM. */
export interface PromptMessage {
  role: "user" | "assistant";
  content: string;
}

/** Riga leggibile con i metadati confermati della voce (o "non stimato"). */
function metadataLines(item: BacklogItemContext): string {
  const risk = item.risk
    ? `${item.risk}${item.riskNote ? ` (${item.riskNote})` : ""}`
    : "non stimato";
  return [
    `- Sforzo (1–5): ${item.effort ?? "non stimato"}`,
    `- Rischio: ${risk}`,
    `- Urgenza: ${item.urgency ?? "non stimata"}`,
  ].join("\n");
}

/** Blocco con i ticket d'origine (titolo + corpo), o un placeholder se assenti. */
function originTicketsBlock(originTickets: OriginTicketContext[]): string {
  if (originTickets.length === 0) {
    return "(nessun ticket d'origine: voce creata manualmente)";
  }
  return originTickets
    .map((t) => `[#${t.number}] ${t.title}\n${t.body || "(nessun corpo)"}`)
    .join("\n\n");
}

/** Blocco delle pagine di documentazione recuperate (con slug/titolo per citarle). */
function docsContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "(nessuna pagina di documentazione rilevante è stata trovata)";
  }
  return chunks
    .map((c, i) =>
      [
        `[${i + 1}] Repository "${c.repositoryName}" — Pagina "${c.title}" (slug: ${c.slug})`,
        c.snippet,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * System prompt della chat RAG di raffinamento di una voce del backlog.
 *
 * Codifica il ruolo (co-progettista di prodotto), il documento corrente, i
 * metadati confermati, i ticket d'origine e il contesto recuperato dalla
 * documentazione del progetto (con slug/titolo per le citazioni). Come la chat
 * Docs: anti-allucinazione (rispondere ancorati al contesto, dire quando non
 * basta) e obbligo di citare le pagine usate. Lo storico della conversazione è
 * passato a parte come `messages` (non incluso qui).
 */
export function buildBacklogSystemPrompt(
  item: BacklogItemContext,
  originTickets: OriginTicketContext[],
  chunks: RetrievedChunk[],
): string {
  return [
    "Sei un co-progettista di prodotto che aiuta a raffinare un'idea del backlog di discovery fino a un documento pronto per lo sviluppo. Rispondi nella lingua dell'utente.",
    "",
    "Il tuo compito: aiutare a chiarire obiettivi, ambito, vincoli, punti aperti e fattibilità dell'idea, discutendo con l'utente. NON riscrivi il documento in questa chat (esiste un comando dedicato \"Aggiorna documento\"): qui si ragiona e si raffina.",
    "",
    "ANCORATI AL CONTESTO: quando parli di come funziona il prodotto/codice, appòggiati alla documentazione recuperata qui sotto e CITA le pagine usate (titolo + repository). Se la documentazione non copre un punto, dillo esplicitamente invece di inventare.",
    "",
    `--- TITOLO DELLA VOCE ---\n${item.title}`,
    "",
    `--- DOCUMENTO CORRENTE ---\n${item.document || "(vuoto)"}`,
    "",
    `--- METADATI ---\n${metadataLines(item)}`,
    "",
    `--- TICKET D'ORIGINE ---\n${originTicketsBlock(originTickets)}`,
    "",
    `--- DOCUMENTAZIONE RECUPERATA ---\n${docsContextBlock(chunks)}`,
  ].join("\n");
}

/**
 * System prompt della chiamata one-shot "Aggiorna documento".
 *
 * Istruisce l'LLM a riscrivere il documento integrando ciò che è emerso nella
 * conversazione dall'ultimo aggiornamento, e a proporre eventuali metadati
 * rivisti. L'OUTPUT DEVE ESSERE JSON `{ "document": string, "suggested"?: {...} }`:
 * la route lo parsa difensivamente e, se il parse fallisce, NON salva nulla.
 * La conversazione delta è inclusa nel prompt come testo (i messaggi non sono
 * passati come `messages`: è una sintesi one-shot, non un turno di chat).
 */
export function buildRefreshDocumentPrompt(
  item: BacklogItemContext,
  deltaMessages: PromptMessage[],
): string {
  const conversation =
    deltaMessages.length === 0
      ? "(nessun messaggio)"
      : deltaMessages
          .map((m) => `${m.role === "user" ? "UTENTE" : "ASSISTENTE"}: ${m.content}`)
          .join("\n\n");

  return [
    "Sei un co-progettista di prodotto. Riscrivi il documento di design di una voce del backlog integrando ciò che è emerso nella conversazione qui sotto.",
    "",
    "REGOLE:",
    "- Mantieni ciò che è ancora valido del documento corrente; integra/correggi in base alla conversazione.",
    "- Il documento è in Markdown: contesto, cosa fare, punti aperti.",
    "- Proponi metadati SOLO se la conversazione dà elementi per rivederli (sforzo 1–5, rischio low|medium|high con nota, urgenza low|medium|high|urgent). Il campo `reason` motiva i suggerimenti.",
    "",
    "FORMATO DI OUTPUT (OBBLIGATORIO): un unico oggetto JSON valido, senza testo attorno, della forma:",
    '{ "document": "<markdown completo del documento aggiornato>", "suggested": { "effort"?: number, "risk"?: "low"|"medium"|"high", "riskNote"?: string, "urgency"?: "low"|"medium"|"high"|"urgent", "reason"?: string } }',
    'Ometti del tutto la chiave "suggested" se non proponi metadati.',
    "",
    `--- TITOLO ---\n${item.title}`,
    "",
    `--- DOCUMENTO CORRENTE ---\n${item.document || "(vuoto)"}`,
    "",
    `--- METADATI CORRENTI ---\n${metadataLines(item)}`,
    "",
    `--- CONVERSAZIONE DALL'ULTIMO AGGIORNAMENTO ---\n${conversation}`,
  ].join("\n");
}

/**
 * System prompt della chiamata one-shot di fusione ("Fondi con…").
 *
 * Integra il documento della voce ASSORBITA in quella di destinazione,
 * restituendo il documento fuso come MARKDOWN PURO (non JSON): la route lo salva
 * direttamente come nuovo documento del target.
 */
export function buildMergeDocumentPrompt(
  target: BacklogItemContext,
  absorbed: BacklogItemContext,
): string {
  return [
    "Sei un co-progettista di prodotto. Devi FONDERE due voci del backlog che descrivono la stessa idea (o idee molto vicine) in un unico documento di design.",
    "",
    "REGOLE:",
    "- Produci il documento della voce DI DESTINAZIONE, arricchito con ciò che la voce ASSORBITA aggiunge (requisiti, casi, vincoli, punti aperti).",
    "- Niente duplicati: unisci i punti equivalenti. Mantieni la struttura Markdown.",
    "- Restituisci SOLO il Markdown del documento fuso, senza commenti né testo attorno, senza racchiuderlo in un blocco di codice.",
    "",
    `--- VOCE DI DESTINAZIONE: "${target.title}" ---\n${target.document || "(vuoto)"}`,
    "",
    `--- VOCE ASSORBITA: "${absorbed.title}" ---\n${absorbed.document || "(vuoto)"}`,
  ].join("\n");
}
