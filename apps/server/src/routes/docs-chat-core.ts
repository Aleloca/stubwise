/**
 * Cuore di trasporto condiviso della chat RAG sui Docs (streaming SSE).
 *
 * Isola le parti del flusso chat che NON dipendono dallo scope (repo-level o
 * project-level): il loop SSE su `reply.raw`, l'AbortSignal sulla disconnessione
 * del client, la persistenza del messaggio assistant (completo con citazioni vs
 * parziale con marcatore di troncamento), e il caricamento dello storico.
 *
 * Lo usano sia la chat per-repository ({@link ./docs-chat.ts}) sia quella di
 * progetto ({@link ./project-docs.ts}): entrambe risolvono PRIMA la sessione e il
 * retrieval (scope diverso), poi delegano qui l'identico streaming/persistenza.
 *
 * NOTA SSE: la chat è l'UNICA superficie che bypassa lo schema di risposta Zod —
 * scrive uno stream grezzo su `reply.raw` dopo `reply.hijack()` (Fastify non
 * serializza/chiude la risposta). Il protocollo (header + framing
 * `data: {json}\n\n`) vive qui, una sola volta.
 */

import { asc, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { docChatMessages } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import type { ChatLlm } from "./chat-llm.js";
import type { Citation } from "./docs-rag.js";

/** Scrive un evento SSE (`data: {json}\n\n`) sullo stream grezzo. */
export function writeSseEvent(reply: FastifyReply, event: unknown): void {
  // Niente gestione di backpressure (drain) qui: gli eventi della chat sono
  // limitati in dimensione (un delta per frammento, risposta complessiva tetto
  // CHAT_MAX_TOKENS), quindi il buffer di scrittura non cresce illimitatamente.
  // Se in futuro le risposte diventassero molto grandi, andrebbe onorato il
  // valore di ritorno di write() (await dell'evento 'drain' su false).
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Marcatore appeso a una risposta troncata (errore/disconnessione a metà stream). */
export const TRUNCATION_MARKER = "\n\n_[risposta interrotta]_";

/**
 * Carica lo storico della sessione (cronologico) come messaggi per l'LLM.
 * Va chiamata DOPO l'insert del messaggio utente, così lo storico include già la
 * domanda corrente in coda.
 */
export async function loadHistory(
  db: Db,
  sessionId: string,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db
    .select({ role: docChatMessages.role, content: docChatMessages.content })
    .from(docChatMessages)
    .where(eq(docChatMessages.sessionId, sessionId))
    .orderBy(asc(docChatMessages.createdAt));
  // `role` è text libero a schema: normalizziamo ai due valori attesi dall'LLM.
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

interface StreamChatResponseArgs {
  db: Db;
  chatLlm: ChatLlm;
  request: FastifyRequest;
  reply: FastifyReply;
  /** Sessione (repo-level o project-level) già risolta/creata e ownership-verificata. */
  sessionId: string;
  /** System prompt costruito dal contesto recuperato (scope già applicato). */
  system: string;
  /** Storico per l'LLM (include la domanda corrente in coda). */
  history: { role: "user" | "assistant"; content: string }[];
  /** Citazioni delle fonti recuperate, allegate al `done` e al messaggio assistant. */
  citations: Citation[];
  /** Contesto per il log degli errori LLM (repositoryId o projectId). */
  logContext: Record<string, string>;
  /**
   * Persistenza pluggabile del messaggio assistant: se presente sostituisce
   * l'insert di default su `docChatMessages` (che resta il comportamento per le
   * chat Docs). `truncated` distingue la risposta completa da quella interrotta
   * a metà: nel default la parziale viene salvata con TRUNCATION_MARKER e senza
   * citazioni — un chiamante custom decide da sé cosa farne. Con risposta
   * interrotta e NESSUN testo accumulato non viene chiamato (come il default,
   * che in quel caso non persiste nulla).
   */
  persistAssistantMessage?: (args: {
    content: string;
    citations: Citation[];
    truncated: boolean;
  }) => Promise<void>;
}

/**
 * Esegue lo streaming SSE della risposta LLM e ne persiste il messaggio assistant.
 *
 * Flusso (identico per repo-level e project-level):
 *  1. `reply.hijack()` + header SSE su `reply.raw`;
 *  2. AbortController sulla disconnessione del client (stop al consumo di token);
 *  3. inoltro di ogni delta come evento `delta`;
 *  4. a stream completo: evento `done` con sessionId + citazioni, poi persistenza
 *     del messaggio assistant completo (testo + citazioni);
 *  5. su errore/disconnessione a metà con testo accumulato: evento `error` (se il
 *     client è ancora connesso) e persistenza del PARZIALE con marcatore di
 *     troncamento e SENZA citazioni (storico/UI distinguono dal completo).
 *
 * Il chiamante ha già: hijack NON ancora fatto, sessione risolta, messaggio utente
 * persistito, system/history/citations pronti. Da qui la risposta è gestita a mano.
 */
export async function streamChatResponse(args: StreamChatResponseArgs): Promise<void> {
  const {
    db,
    chatLlm,
    request,
    reply,
    sessionId,
    system,
    history,
    citations,
    logContext,
    persistAssistantMessage,
  } = args;

  // --- Streaming SSE --------------------------------------------------------
  // Da qui in poi gestiamo la risposta a mano: header SSE + scrittura grezza su
  // reply.raw. reply.hijack() impedisce a Fastify di serializzare/chiudere la
  // risposta al posto nostro.
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Disconnessione del client: oltre a smettere di scrivere/consumare lo stream,
  // ABORTIAMO la generazione LLM sottostante per fermare il consumo di token
  // (altrimenti l'SDK continuerebbe a generare fino a max_tokens).
  const controller = new AbortController();
  let clientGone = false;
  request.raw.on("close", () => {
    clientGone = true;
    controller.abort();
  });

  let full = "";
  // `completed` = lo stream è terminato normalmente (nessun errore, nessuna
  // disconnessione a metà). Solo in quel caso la risposta è "completa" e tiene
  // le citazioni; altrimenti è parziale e va marcata come interrotta.
  let completed = false;
  // La persistenza è fallita: il `done` va soppresso (vedi sotto).
  let persistFailed = false;
  try {
    try {
      for await (const delta of chatLlm.stream({
        system,
        messages: history,
        signal: controller.signal,
      })) {
        if (clientGone) break;
        full += delta;
        writeSseEvent(reply, { type: "delta", text: delta });
      }
      completed = !clientGone;
    } catch (error) {
      // Errore dell'LLM a metà stream: lo segnaliamo al client con un evento
      // `error` e abortiamo la generazione sottostante (no token sprecati).
      // Logghiamo per intero lato server (mai nel body).
      controller.abort();
      request.log.error({ err: error, ...logContext, sessionId }, "chat LLM error");
      if (!clientGone) {
        writeSseEvent(reply, { type: "error", message: "Chat generation failed" });
      }
    }

    // Persistenza del messaggio assistant — PRIMA della chiusura della risposta.
    // Le UI fanno refetch dello storico appena ricevono `done` (o vedono lo
    // stream chiudersi): al momento della chiusura lo storico DEVE già essere
    // consistente, altrimenti il refetch può non vedere l'ultimo messaggio
    // (race osservata come flake in CI). Un errore di persistenza sopprime il
    // `done`: il client tratta la risposta come troncata (contratto già gestito).
    //  - Risposta COMPLETA: testo + citazioni (storico/UI la trattano come tale).
    //  - Risposta PARZIALE (errore o disconnessione a metà con testo accumulato):
    //    la salviamo SENZA citazioni e con un marcatore di troncamento, così
    //    history loader e UI distinguono una risposta interrotta da una completa.
    // Persistenza pluggabile: il chiamante riceve il testo grezzo e `truncated`,
    // e decide da sé marcatori/citazioni. Il default (chat Docs) resta identico.
    try {
      if (persistAssistantMessage) {
        if (completed || full.length > 0) {
          await persistAssistantMessage({ content: full, citations, truncated: !completed });
        }
      } else if (completed) {
        await db.insert(docChatMessages).values({
          sessionId,
          role: "assistant",
          content: full,
          citations,
        });
      } else if (full.length > 0) {
        await db.insert(docChatMessages).values({
          sessionId,
          role: "assistant",
          content: full + TRUNCATION_MARKER,
          // Niente citazioni su risposta interrotta: non sono "giustificate" da
          // un ragionamento completato.
          citations: null,
        });
      }
    } catch (error) {
      persistFailed = true;
      request.log.error({ err: error, ...logContext, sessionId }, "chat persist error");
    }
  } finally {
    // Lo stream HTTP grezzo va SEMPRE chiuso, anche su throw inatteso dopo
    // hijack(): senza questo il socket resterebbe appeso. Su disconnessione del
    // client la connessione è già chiusa, quindi non scriviamo/chiudiamo.
    if (!clientGone) {
      if (completed && !persistFailed) {
        // Risposta completa e persistita: evento finale con le citazioni e il
        // sessionId, così il client può persistere la sessione (nuova al primo
        // turno) e riusarla nei turni successivi (multi-turn).
        writeSseEvent(reply, { type: "done", sessionId, citations });
      }
      reply.raw.end();
    }
  }
}
