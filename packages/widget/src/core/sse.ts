/**
 * Parser dello stream SSE della chat widget. Adatta il loop di lettura di
 * `apps/web/src/components/docs-chat.tsx` (reader + TextDecoder stream:true +
 * buffer tagliato sui separatori `\n\n`), ma tipizza gli eventi e li consegna a
 * un callback invece di mutare lo stato React.
 *
 * Protocollo di trasporto lato server: ogni evento è una riga `data: {json}\n\n`
 * (vedi `apps/server/src/routes/docs-chat-core.ts#writeSseEvent`).
 */

/** Proposta di ticket emessa dalla sentinel della chat (title/body/type). */
export interface WidgetTicketProposal {
  title: string;
  body: string;
  type: "bug" | "feedback" | "feature";
}

/**
 * Citazione di una fonte Docs allegata al `done`. Forma opaca lato widget
 * (la UI la usa per i link "Fonti"): non la validiamo campo per campo.
 */
export type WidgetCitation = Record<string, unknown>;

/** Eventi tipizzati che lo stream della chat widget può emettere. */
export type WidgetSseEvent =
  | { type: "delta"; text: string }
  | { type: "ticket_proposal"; proposal: WidgetTicketProposal }
  | { type: "done"; conversationId: string; citations: WidgetCitation[] }
  | { type: "error"; message?: string };

/**
 * Normalizza un oggetto JSON grezzo in un {@link WidgetSseEvent}, o `null` se il
 * `type` è sconosciuto o i campi attesi mancano/hanno tipo sbagliato. Un evento
 * malformato viene ignorato (mai un throw): lo stream non deve rompersi per un
 * frammento imprevisto del server.
 */
function toEvent(raw: unknown): WidgetSseEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  switch (obj["type"]) {
    case "delta":
      return typeof obj["text"] === "string" ? { type: "delta", text: obj["text"] } : null;
    case "ticket_proposal": {
      const p = obj["proposal"];
      if (typeof p !== "object" || p === null) return null;
      const proposal = p as Record<string, unknown>;
      if (
        typeof proposal["title"] !== "string" ||
        typeof proposal["body"] !== "string" ||
        (proposal["type"] !== "bug" &&
          proposal["type"] !== "feedback" &&
          proposal["type"] !== "feature")
      ) {
        return null;
      }
      return {
        type: "ticket_proposal",
        proposal: {
          title: proposal["title"],
          body: proposal["body"],
          type: proposal["type"],
        },
      };
    }
    case "done":
      return {
        type: "done",
        conversationId: typeof obj["conversationId"] === "string" ? obj["conversationId"] : "",
        citations: Array.isArray(obj["citations"]) ? (obj["citations"] as WidgetCitation[]) : [],
      };
    case "error":
      return {
        type: "error",
        ...(typeof obj["message"] === "string" ? { message: obj["message"] } : {}),
      };
    default:
      return null;
  }
}

/**
 * Legge lo stream SSE di `response` fino alla fine, invocando `onEvent` per ogni
 * evento riconosciuto. Si risolve alla chiusura dello stream (anche senza un
 * `done` esplicito, es. troncamento). Se `response.body` è assente si risolve
 * subito senza emettere nulla.
 *
 * Buffering: i chunk di rete possono spezzare un evento in un punto qualsiasi
 * (anche a metà di `data: ` o del JSON), quindi si accumula in un buffer e si
 * tagliano solo gli eventi COMPLETI (delimitati da `\n\n`); il resto resta in
 * buffer per il chunk successivo.
 */
export async function parseSseStream(
  response: Response,
  onEvent: (event: WidgetSseEvent) => void,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const json = line.slice("data:".length).trim();
      if (!json) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        // frammento non parsabile: ignorato, lo stream continua
        continue;
      }
      const event = toEvent(parsed);
      if (event) onEvent(event);
    }
  }
}
