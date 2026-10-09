/**
 * Helper dei test per gli stream SSE: una `Response` il cui body emette i frame
 * dati in chunk distinti, così chi legge deve davvero accumularli attraverso
 * più `read()`.
 */

/** Costruisce una `Response` streaming da frame SSE già formattati (`data: {json}\n\n`). */
export function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Formatta un evento come frame SSE. */
export function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Uno stream SSE pilotato dal test: `push` manda un messaggio come frame
 * `data:`, `close` chiude il corpo (per il client è una caduta di rete).
 */
export function controlledSse(): {
  response: Response;
  push(message: unknown): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push(message) {
      controller.enqueue(encoder.encode(sse(message)));
    },
    close() {
      controller.close();
    },
  };
}
