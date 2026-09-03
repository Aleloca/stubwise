/**
 * Cuore di trasporto condiviso della chat RAG sui Docs, in DUE modalità:
 *  - "sse" (default, storica): il loop SSE su `reply.raw` dopo `reply.hijack()`;
 *  - "json" (fase 4, mobile): accumula la risposta intera e la manda con
 *    `reply.send()` — NESSUN hijack, dentro il ciclo normale di Fastify (schema
 *    di risposta validato).
 *
 * In comune alle due modalità: l'AbortSignal sulla disconnessione del client, il
 * caricamento dello storico, e — sul percorso di successo — la persistenza del
 * messaggio assistant. **Divergono deliberatamente sul troncamento** (vedi la
 * nota su {@link StreamChatResponseArgs.mode} qui sotto): è l'unico punto in cui
 * le due modalità non condividono comportamento, non solo trasporto.
 *
 * Lo usano tre route: la chat per-repository ({@link ./docs-chat.ts}), quella di
 * progetto ({@link ./project-docs.ts}) e quella di raffinamento del backlog
 * ({@link ./backlog.ts}): tutte risolvono PRIMA la sessione e il retrieval (scope
 * diverso), poi delegano qui l'identico streaming/persistenza.
 *
 * NOTA SSE: in modalità "sse" la chat bypassa lo schema di risposta Zod — scrive
 * uno stream grezzo su `reply.raw` dopo `reply.hijack()` (Fastify non
 * serializza/chiude la risposta). Il protocollo (header + framing
 * `data: {json}\n\n`) vive qui, una sola volta. In modalità "json" NON c'è
 * hijack: la risposta passa dal normale `reply.send()`, validata dallo schema di
 * risposta della route (200: `docsChatAnswerSchema`, 502: `errorSchema`).
 */

import { asc, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { docChatMessages } from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { apiError } from "../errors.js";
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
  /** Sessione (repo-level, project-level, o l'id della voce per il backlog) già risolta/creata e ownership-verificata. */
  sessionId: string;
  /** System prompt costruito dal contesto recuperato (scope già applicato). */
  system: string;
  /** Storico per l'LLM (include la domanda corrente in coda). */
  history: { role: "user" | "assistant"; content: string }[];
  /** Citazioni delle fonti recuperate, allegate al `done`/`sources` e al messaggio assistant. */
  citations: Citation[];
  /** Contesto per il log degli errori LLM (repositoryId, projectId o backlogItemId). */
  logContext: Record<string, string>;
  /**
   * Persistenza pluggabile del messaggio assistant: se presente sostituisce
   * l'insert di default su `docChatMessages` (che resta il comportamento per le
   * chat Docs). `truncated` distingue la risposta completa da quella interrotta
   * a metà: nel default la parziale viene salvata con TRUNCATION_MARKER e senza
   * citazioni — un chiamante custom decide da sé cosa farne. Con risposta
   * interrotta e NESSUN testo accumulato non viene chiamato (come il default,
   * che in quel caso non persiste nulla). In modalità "json" questo callback è
   * invocato SOLO sul percorso di successo (mai con `truncated: true`, vedi sotto).
   */
  persistAssistantMessage?: (args: {
    content: string;
    citations: Citation[];
    truncated: boolean;
  }) => Promise<void>;
  /**
   * Modalità di consegna della risposta. Default `"sse"` (comportamento
   * storico, invariato): un evento `delta` per frammento su `reply.raw`, poi un
   * evento `done` con citazioni e sessionId.
   *
   * `"json"` è per i client che non leggono SSE (l'app mobile, `?stream=false`):
   * NESSUN hijack, i delta sono accumulati e la risposta è un unico body
   * `{ answer, sources, sessionId }` via `reply.send()` — dentro il ciclo
   * normale di Fastify, quindi validata dallo schema di risposta della route.
   *
   * ⚠️ **DIFFERENZA VOLUTA sul troncamento** (verificata con un test dedicato,
   * non solo descritta): in "sse" un errore/disconnessione a metà stream CON
   * testo già accumulato salva il PARZIALE (`TRUNCATION_MARKER`, niente
   * citazioni) — la UI web l'ha già ricevuto frammento per frammento, quindi ha
   * senso tenerlo nello storico. In "json" lo stesso errore risponde **502,
   * SENZA persistere nulla**: un client non-streaming non ha MAI visto un solo
   * byte di quella risposta (non c'è stato alcun evento `delta` da mostrare),
   * quindi non esiste un "già visto" da preservare — e persistere un messaggio
   * che il client non ha mai ricevuto romperebbe la lettura dello storico al
   * turno successivo (un assistant "fantasma" in mezzo alla conversazione).
   * Stessa ragione per cui, se la persistenza del COMPLETO fallisce in modalità
   * "json", si risponde 502 invece di 200: senza garanzia di persistenza non si
   * può promettere al client che quella risposta sopravviverà a un refresh.
   */
  mode?: "sse" | "json";
}

/**
 * Consuma lo stream dell'LLM accumulando il testo completo. Condiviso dalle due
 * modalità: qui vive SOLO la generazione (chiamata all'LLM, AbortSignal,
 * accumulo), non la persistenza — quella resta nel chiamante perché è l'UNICO
 * punto in cui sse e json divergono davvero (vedi la nota sul troncamento sopra
 * {@link StreamChatResponseArgs.mode}). `onDelta` lascia alla modalità la scelta
 * di cosa fare di ogni frammento (SSE lo inoltra subito, json lo accumula e
 * basta); `onError` lascia alla modalità la scelta di come reagire a un errore
 * a metà (SSE scrive un evento `error` se il client c'è ancora, json non scrive
 * nulla qui — risponderà 502 dopo, nel chiamante).
 */
async function consumeLlmStream(args: {
  chatLlm: ChatLlm;
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  isClientGone: () => boolean;
  onDelta: (delta: string) => void;
  onError: (error: unknown) => void;
}): Promise<{ full: string; completed: boolean }> {
  const { chatLlm, system, history, signal, isClientGone, onDelta, onError } = args;
  let full = "";
  let completed = false;
  try {
    for await (const delta of chatLlm.stream({ system, messages: history, signal })) {
      if (isClientGone()) break;
      full += delta;
      onDelta(delta);
    }
    completed = !isClientGone();
  } catch (error) {
    onError(error);
  }
  return { full, completed };
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
 */
async function respondSse(args: StreamChatResponseArgs): Promise<void> {
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

  // La persistenza è fallita: il `done` va soppresso (vedi sotto).
  let persistFailed = false;
  let full = "";
  let completed = false;
  try {
    ({ full, completed } = await consumeLlmStream({
      chatLlm,
      system,
      history,
      signal: controller.signal,
      isClientGone: () => clientGone,
      onDelta: (delta) => writeSseEvent(reply, { type: "delta", text: delta }),
      onError: (error) => {
        // Errore dell'LLM a metà stream: lo segnaliamo al client con un evento
        // `error` e abortiamo la generazione sottostante (no token sprecati).
        // Logghiamo per intero lato server (mai nel body).
        controller.abort();
        request.log.error({ err: error, ...logContext, sessionId }, "chat LLM error");
        if (!clientGone) {
          writeSseEvent(reply, { type: "error", message: "Chat generation failed" });
        }
      },
    }));

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

/**
 * Esegue la chat in un'UNICA risposta JSON, senza streaming: accumula i delta
 * dell'LLM e risponde `{ answer, sources, sessionId }` (200) a generazione
 * completa, o 502 su errore/persistenza fallita — SENZA mai persistere un
 * parziale (vedi la nota su {@link StreamChatResponseArgs.mode}).
 *
 * NIENTE hijack: la risposta passa dal normale `reply.send()`/`apiError`, quindi
 * resta dentro la validazione dello schema di risposta della route.
 */
async function respondJson(args: StreamChatResponseArgs): Promise<void> {
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

  // Stessa ragione della modalità sse: fermare il consumo di token se il client
  // se ne va prima che la generazione finisca.
  const controller = new AbortController();
  let clientGone = false;
  request.raw.on("close", () => {
    clientGone = true;
    controller.abort();
  });

  const { full, completed } = await consumeLlmStream({
    chatLlm,
    system,
    history,
    signal: controller.signal,
    isClientGone: () => clientGone,
    // Nessun inoltro frammento-per-frammento: il body è un pezzo unico a fine
    // consumo, quindi l'accumulo (già fatto da consumeLlmStream) basta.
    onDelta: () => {},
    onError: (error) => {
      controller.abort();
      request.log.error({ err: error, ...logContext, sessionId }, "chat LLM error");
    },
  });

  // Client sparito: nessuno a cui rispondere. Niente persistenza (stesso motivo
  // del ramo di errore sotto: il client non ha MAI visto questa risposta) e
  // niente reply.send (il socket è già chiuso).
  if (clientGone) return;

  if (!completed) {
    // Errore LLM a metà: 502, NESSUNA persistenza — a differenza dell'sse, che
    // salva il parziale con TRUNCATION_MARKER. Qui il client non ha ricevuto
    // NESSUN byte della risposta (nessun evento `delta`, questa è una risposta
    // unica), quindi non c'è un "già visto" da preservare nello storico: un
    // messaggio assistant persistito ma mai arrivato al client sarebbe un
    // fantasma nella conversazione, letto al turno successivo come se il client
    // lo avesse visto.
    apiError(reply, 502, "chat_generation_failed", "Chat generation failed");
    return;
  }

  try {
    if (persistAssistantMessage) {
      await persistAssistantMessage({ content: full, citations, truncated: false });
    } else {
      await db.insert(docChatMessages).values({
        sessionId,
        role: "assistant",
        content: full,
        citations,
      });
    }
  } catch (error) {
    request.log.error({ err: error, ...logContext, sessionId }, "chat persist error");
    // Stessa logica del `done` soppresso in sse: senza garanzia che la
    // persistenza sia andata a buon fine, non si promette al client una
    // risposta che potrebbe sparire dallo storico al refresh successivo.
    apiError(reply, 502, "chat_persist_failed", "Chat response could not be saved");
    return;
  }

  reply.send({ answer: full, sources: citations, sessionId });
}

/**
 * Punto d'ingresso condiviso: dispatcha su {@link respondSse} (default,
 * `mode: "sse"` o omesso) o {@link respondJson} (`mode: "json"`) in base a
 * `args.mode`. Il chiamante ha già: hijack/send NON ancora fatti, sessione
 * risolta, messaggio utente persistito, system/history/citations pronti. Da qui
 * la risposta è gestita a mano.
 */
export async function streamChatResponse(args: StreamChatResponseArgs): Promise<void> {
  if (args.mode === "json") {
    return respondJson(args);
  }
  return respondSse(args);
}
