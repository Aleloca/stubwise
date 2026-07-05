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
 * Citazione di una fonte Docs allegata al `done`. Forma OPACA lato widget:
 * il contratto del server la tipizza come `unknown`/jsonb (vedi
 * `buildCitations` → `{slug,title,kind,repositoryId,...}`), quindi la
 * modelliamo come record generico e leggiamo solo `title` alla renderizzazione.
 * UNICO tipo citazione del widget: `api.ts` lo riusa per lo storico messaggi.
 */
export type WidgetCitation = Record<string, unknown>;

/**
 * Cap difensivo sul buffer di parsing (1 MB): se un singolo evento non viene mai
 * chiuso da un `\n\n` (server malfunzionante o stream ostile), evita di crescere
 * senza limite in memoria. Superato il cap si abortisce il parse con un evento
 * `error` sintetico e si cancella il reader.
 */
const MAX_BUFFER_BYTES = 1_000_000;

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
 *
 * Robustezza: se `onEvent` LANCIA (bug del consumer) si cancella il reader nel
 * `finally` per non lasciare la connessione appesa, poi si ri-propaga. Un buffer
 * che supera {@link MAX_BUFFER_BYTES} senza mai chiudere un evento fa emettere un
 * `error` sintetico e interrompe il parse (guardia contro stream ostili).
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Guardia anti-crescita: un evento senza terminatore non deve gonfiare la
      // memoria all'infinito. Superato il cap, si segnala e si smette di leggere.
      if (buffer.length > MAX_BUFFER_BYTES) {
        onEvent({ type: "error", message: "stream buffer overflow" });
        break;
      }

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
  } finally {
    // Se usciamo per un throw di onEvent (o comunque a fine loop), assicuriamo il
    // rilascio del reader: senza `cancel()` la connessione resterebbe appesa.
    // `cancel()` su reader già chiuso è un no-op idempotente.
    await reader.cancel().catch(() => {
      // reader già rilasciato/chiuso: nulla da fare
    });
  }
}
