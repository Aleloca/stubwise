/**
 * Cuore della chat del widget di assistenza (Task 6).
 *
 * Distinto dalla chat RAG interna sui Docs ({@link ./docs-chat-core.ts}) perché:
 *  - REGISTRO customer service (non tecnico): niente dettagli implementativi
 *    interni (percorsi file, nomi tabelle), risponde SOLO dalla documentazione;
 *  - SENTINEL `ticket_proposal`: quando l'utente segnala un bug/feedback o chiede
 *    qualcosa che la documentazione non risolve, l'LLM chiude la risposta con un
 *    blocco marcato che qui parsiamo in una PROPOSTA di ticket (title/body/type),
 *    senza mai mostrare il marcatore all'utente;
 *  - PERSISTENZA su `widget_messages` (non `docChatMessages`): per questo il loop
 *    SSE è copiato (non riusato) da docs-chat-core, riusandone solo il protocollo
 *    di trasporto ({@link writeSseEvent}) e il marcatore di troncamento.
 *
 * Il parser della sentinel è streaming-safe: il marcatore può arrivare spezzato
 * su più delta, quindi non inoltriamo mai un frammento che POTREBBE essere l'inizio
 * di un marcatore (vedi {@link safeForwardLength}).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import {
  widgetTicketConfirmBodySchema,
  type WidgetLanguage,
} from "@stubwise/shared";
import { widgetConversations, widgetMessages } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { ChatLlm } from "./chat-llm.js";
import type { Citation } from "./docs-rag.js";
import type { RetrievedChunk } from "./docs-retrieval.js";
import { TRUNCATION_MARKER, writeSseEvent } from "./docs-chat-core.js";

/** Marcatore di apertura del blocco proposta ticket (in coda alla risposta LLM). */
const PROPOSAL_START = "<<<TICKET_PROPOSAL";
/** Marcatore di chiusura del blocco proposta ticket. */
const PROPOSAL_END = "TICKET_PROPOSAL>>>";

/** Proposta di ticket estratta dalla sentinel (già validata dallo schema). */
export interface TicketProposal {
  title: string;
  body: string;
  type: "bug" | "feedback" | "feature";
}

/**
 * Quanto di `full` (testo accumulato finora) può essere inoltrato al client
 * SENZA rischiare di emettere un pezzo del marcatore di apertura.
 *
 *  - Se il marcatore compare per intero: si inoltra solo ciò che lo precede
 *    (tutto il resto è la proposta, mai visibile all'utente).
 *  - Altrimenti, se la CODA di `full` coincide con un PREFISSO del marcatore
 *    (es. "<", "<<<TIC"): potrebbe completarsi in un marcatore nel delta
 *    successivo, quindi la si trattiene finché non si sa.
 *  - Se non c'è né marcatore né prefisso ambiguo in coda: si inoltra tutto.
 */
export function safeForwardLength(full: string): number {
  const idx = full.indexOf(PROPOSAL_START);
  if (idx !== -1) return idx; // tutto ciò che segue è proposta, non si inoltra
  for (let k = Math.min(PROPOSAL_START.length - 1, full.length); k > 0; k--) {
    if (full.endsWith(PROPOSAL_START.slice(0, k))) return full.length - k;
  }
  return full.length;
}

/**
 * Divide la risposta LLM completa in testo VISIBILE (senza il blocco sentinel) e
 * PROPOSTA di ticket (o null).
 *
 *  - Nessun marcatore di apertura → visible = tutto (trimmato), proposal null.
 *  - Marcatore di apertura senza chiusura (stream troncato) → visible = testo
 *    fino all'apertura, proposal null (il JSON è incompleto/inaffidabile).
 *  - Apertura + chiusura → JSON tra i due marcatori, `JSON.parse` +
 *    `widgetTicketConfirmBodySchema.safeParse`. Malformato o type/campi invalidi
 *    → proposal null; il visible è comunque il testo che precede l'apertura.
 *  - Il testo DOPO la chiusura è sempre scartato (non è né visibile né proposta).
 */
export function extractProposal(full: string): {
  visible: string;
  proposal: TicketProposal | null;
} {
  const startIdx = full.indexOf(PROPOSAL_START);
  if (startIdx === -1) {
    return { visible: full.trim(), proposal: null };
  }

  const visible = full.slice(0, startIdx).trim();
  const afterStart = full.slice(startIdx + PROPOSAL_START.length);
  const endIdx = afterStart.indexOf(PROPOSAL_END);
  // Apertura senza chiusura: la proposta è troncata, non ci si fida.
  if (endIdx === -1) {
    return { visible, proposal: null };
  }

  const rawJson = afterStart.slice(0, endIdx).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    // JSON malformato: nessuna proposta, ma la parte visibile resta valida.
    return { visible, proposal: null };
  }

  const result = widgetTicketConfirmBodySchema.safeParse(parsed);
  if (!result.success) {
    return { visible, proposal: null };
  }
  return { visible, proposal: result.data };
}

/**
 * System prompt della chat del widget: registro CUSTOMER SERVICE nella lingua
 * configurata, ancorato alla documentazione, con il formato ESATTO della sentinel
 * `ticket_proposal` documentato in coda. Modellato su
 * {@link ./docs-rag.ts#buildDocsSystemPrompt} ma con regole diverse (niente
 * dettagli interni, niente doppio registro tecnico).
 */
export function buildWidgetSystemPrompt(
  chunks: RetrievedChunk[],
  settings: { language: WidgetLanguage },
): string {
  const languageName = settings.language === "en" ? "English" : "Italian (italiano)";

  const header = [
    "You are a friendly customer-support assistant for a software product, embedded on the product's website.",
    `Always reply in ${languageName}, in a warm, plain, non-technical customer-service tone.`,
    "",
    "GROUND YOUR ANSWERS ONLY IN THE DOCUMENTATION CONTEXT PROVIDED BELOW. Do not invent features or behaviors. If the context does not answer the question, say so plainly instead of guessing.",
    "",
    "NEVER reveal internal implementation details: no file paths, no table/column names, no source-code identifiers, no internal architecture. Speak only about what the product does from the user's point of view.",
    "",
    "Do NOT promise timelines, delivery dates, or commitments on behalf of the team.",
    "",
    "TICKET PROPOSAL: if the user reports a BUG, gives FEEDBACK, or asks for something the documentation cannot resolve (e.g. a missing feature or an unresolved problem), first reply helpfully to the user, then APPEND — at the very END of your reply — a ticket proposal block in EXACTLY this format (and nothing after it):",
    "",
    PROPOSAL_START,
    '{"title": "...", "body": "...", "type": "bug|feedback|feature"}',
    PROPOSAL_END,
    "",
    `The "type" MUST be one of: bug, feedback, feature. Write "title" and "body" in ${languageName} (the user's language): a short title and a body that summarizes the user's report or request. Include the block ONLY when a ticket is warranted; for a normal answer fully covered by the documentation, do NOT include it.`,
    "",
    "--- DOCUMENTATION CONTEXT ---",
  ];

  if (chunks.length === 0) {
    header.push("(no relevant documentation page was found for this question)");
    return header.join("\n");
  }

  const context = chunks.map((c, i) => {
    return [`[${i + 1}] Page "${c.title}"`, c.snippet].join("\n");
  });

  return [...header, ...context].join("\n\n");
}

interface StreamWidgetChatResponseArgs {
  db: Db;
  chatLlm: ChatLlm;
  request: FastifyRequest;
  reply: FastifyReply;
  /** Conversazione già risolta/ownership-verificata: dove persistere l'assistant. */
  conversationId: string;
  /** System prompt del widget (contesto già applicato). */
  system: string;
  /** Storico per l'LLM (include il messaggio utente corrente in coda). */
  history: { role: "user" | "assistant"; content: string }[];
  /** Citazioni delle fonti recuperate, allegate al `done` e al messaggio assistant. */
  citations: Citation[];
  /** Contesto per il log degli errori LLM. */
  logContext: Record<string, string>;
}

/**
 * Streaming SSE della risposta del widget + persistenza dell'assistant.
 *
 * Meccanica di trasporto identica a {@link ./docs-chat-core.ts#streamChatResponse}
 * (hijack + header SSE + AbortController sulla disconnessione), ma:
 *  - i delta sono inoltrati SOLO fino a {@link safeForwardLength} del testo
 *    accumulato, così un pezzo del marcatore sentinel non finisce mai al client;
 *  - a fine stream {@link extractProposal} separa il VISIBLE dalla PROPOSTA: si
 *    emette l'eventuale coda visibile ancora trattenuta come `delta`, poi (se
 *    presente) un evento `ticket_proposal`, poi il `done` con conversationId +
 *    citazioni;
 *  - l'assistant persistito ha `content = visible` (senza il blocco sentinel);
 *  - su errore/disconnessione a metà: evento `error` e persistenza del parziale
 *    (testo accumulato + {@link TRUNCATION_MARKER}, senza citazioni).
 */
export async function streamWidgetChatResponse(
  args: StreamWidgetChatResponseArgs,
): Promise<void> {
  const { db, chatLlm, request, reply, conversationId, system, history, citations, logContext } =
    args;

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const controller = new AbortController();
  let clientGone = false;
  request.raw.on("close", () => {
    clientGone = true;
    controller.abort();
  });

  let full = "";
  // Quanto del `full` è GIÀ stato inoltrato al client come delta: il forwarding è
  // limitato a safeForwardLength, quindi resta sempre una coda trattenuta finché
  // non si sa se è testo o l'inizio del marcatore.
  let forwarded = 0;
  let completed = false;
  try {
    for await (const delta of chatLlm.stream({
      system,
      messages: history,
      signal: controller.signal,
    })) {
      if (clientGone) break;
      full += delta;
      const safe = safeForwardLength(full);
      if (safe > forwarded) {
        writeSseEvent(reply, { type: "delta", text: full.slice(forwarded, safe) });
        forwarded = safe;
      }
    }
    completed = !clientGone;
  } catch (error) {
    controller.abort();
    request.log.error({ err: error, ...logContext, conversationId }, "widget chat LLM error");
    if (!clientGone) {
      writeSseEvent(reply, { type: "error", message: "Chat generation failed" });
    }
  }

  // A stream completato: separa il visibile dalla proposta. La coda visibile
  // ancora trattenuta (testo che seguiva un falso-inizio di marcatore) va emessa
  // come ultimo delta prima del done.
  let visible = full;
  let proposal: TicketProposal | null = null;
  if (completed) {
    ({ visible, proposal } = extractProposal(full));
    if (!clientGone) {
      if (visible.length > forwarded) {
        writeSseEvent(reply, { type: "delta", text: visible.slice(forwarded) });
      }
      if (proposal) {
        writeSseEvent(reply, { type: "ticket_proposal", proposal });
      }
      writeSseEvent(reply, { type: "done", conversationId, citations });
    }
  }

  if (!clientGone) {
    reply.raw.end();
  }

  // Persistenza dell'assistant: completo (content = visible + citazioni) oppure
  // parziale (testo accumulato + marcatore, senza citazioni) su interruzione.
  if (completed) {
    await db.insert(widgetMessages).values({
      conversationId,
      role: "assistant",
      content: visible,
      citations,
    });
    await db
      .update(widgetConversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(widgetConversations.id, conversationId));
  } else if (full.length > 0) {
    await db.insert(widgetMessages).values({
      conversationId,
      role: "assistant",
      content: full + TRUNCATION_MARKER,
      citations: null,
    });
    await db
      .update(widgetConversations)
      .set({ lastMessageAt: new Date() })
      .where(eq(widgetConversations.id, conversationId));
  }
}
