import { ApiError } from "./api";

/**
 * Handler degli eventi dello stream di chat di raffinamento del backlog. Il
 * chiamante accumula i `delta` e reagisce a `done`/`error`.
 */
export interface BacklogChatHandlers {
  /** Delta di testo dell'assistant (da accumulare lato chiamante). */
  onDelta: (text: string) => void;
  /** Fine dello stream: eventuali citazioni RAG finali (jsonb opaco). */
  onDone: (payload: { citations?: unknown }) => void;
  /** Errore mid-stream segnalato dal server (evento SSE `error`). */
  onError: () => void;
}

/**
 * Invia un messaggio alla chat di raffinamento di una voce del backlog e
 * consuma lo stream SSE, invocando gli handler per ogni evento (`delta`,
 * `done`, `error`). Segue il pattern fetch-stream di {@link file://./docs-api.ts}
 * (postDocChatStream): NON passa dal wrapper JSON `api`, mappa gli errori di
 * rete e di stato in {@link ApiError} PRIMA di aprire lo stream — incluso il 503
 * `chat_unavailable` del pre-flight del server (nessun provider api_key), che il
 * chiamante riconosce dal `code` per un messaggio dedicato. Il parsing SSE
 * (`data: {json}` separati da `\n\n`) è identico a quello della chat Docs.
 *
 * Contratto di chiusura: lo stream PUÒ chiudersi senza un `done` esplicito (es.
 * risposta troncata dal server) — in quel caso la promise si risolve comunque,
 * SENZA invocare `onDone` né `onError`. È il chiamante a chiudere lo stato di
 * "streaming in corso" alla risoluzione della promise (non dentro `onDone`),
 * così l'indicatore sparisce in ogni caso. Un eventuale buffer residuo senza il
 * separatore finale `\n\n` viene scartato intenzionalmente: un evento SSE
 * incompleto non è parsabile in modo affidabile e i delta già consegnati
 * restano validi.
 */
export async function postBacklogChatStream(
  itemId: string,
  message: string,
  handlers: BacklogChatHandlers,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/backlog/${encodeURIComponent(itemId)}/chat`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ApiError(0, "Unable to reach the server", "network_error", { cause: error });
    }
    throw error;
  }

  if (!response.ok) {
    // Errore PRIMA dello stream (404/503/auth): risposta JSON `{ code, message }`.
    const fallback = `Error ${response.status}`;
    const { message: msg, code } = await response
      .json()
      .then((data: unknown) => {
        const obj =
          typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
        return {
          message: "message" in obj ? String(obj.message) : fallback,
          code: typeof obj.code === "string" ? obj.code : undefined,
        };
      })
      .catch(() => ({ message: fallback, code: undefined }));
    throw new ApiError(response.status, msg, code);
  }

  const body = response.body;
  if (!body) throw new ApiError(0, "Missing response body", "network_error");

  // Lettura incrementale: decodifico i chunk, bufferizzo e taglio sui separatori
  // SSE `\n\n`. Ogni evento completo è una riga `data: {json}`.
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    // Processa tutti gli eventi completi presenti nel buffer.
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const json = line.slice("data:".length).trim();
      if (!json) continue;

      let event: { type?: string; text?: string; citations?: unknown };
      try {
        event = JSON.parse(json) as typeof event;
      } catch {
        // Frammento non parsabile: lo ignoro invece di rompere lo stream.
        continue;
      }

      if (event.type === "delta" && typeof event.text === "string") {
        handlers.onDelta(event.text);
      } else if (event.type === "done") {
        handlers.onDone({ citations: event.citations });
      } else if (event.type === "error") {
        handlers.onError();
      }
    }
  }
}
