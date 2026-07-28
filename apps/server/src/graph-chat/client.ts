import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Client MCP verso il container `graphify` (Streamable HTTP, `--stateless`),
 * usato dalle chat interne per recuperare il sottografo del codice.
 *
 * REGOLA D'ORO della fase 2b: **la chat non deve MAI peggiorare per colpa del
 * grafo**. Qui dentro nulla viene rilanciato al chiamante: ogni fallimento
 * (container giù, timeout, protocollo, risposta inattesa) diventa `null` e la
 * chat prosegue col solo retrieval pgvector.
 */

/** Logger minimale in stile pino, iniettabile per i test (vedi GraphLogger nel worker). */
export interface GraphMcpLogger {
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface GraphMcpClientOptions {
  /** URL del server MCP, es. `http://graphify:8080/mcp`. */
  url: string;
  logger: GraphMcpLogger;
  /** Orologio iniettabile per il circuit breaker (default `Date.now`). */
  now?: () => number;
}

export interface QueryGraphParams {
  /** `project_path` del grafo, cioè `<GRAPHS_DIR>/<repositoryId>`. */
  projectPath: string;
  /** Domanda dell'utente, passata verbatim a `query_graph`. */
  question: string;
  /** Budget di token del sottografo richiesto. */
  tokenBudget: number;
  /** Timeout della singola query (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

export interface GraphMcpClient {
  /** Sottografo serializzato, oppure `null` per QUALSIASI esito non utile. */
  queryGraph(params: QueryGraphParams): Promise<string | null>;
  /** Chiude la connessione cached (spegnimento del server). */
  close(): Promise<void>;
}

/**
 * Timeout di default di una query. Il grafo è un CONTORNO della risposta: se non
 * arriva in fretta si risponde senza, non si fa attendere l'utente.
 */
export const DEFAULT_TIMEOUT_MS = 2_000;

/** Errori consecutivi dopo i quali il circuito si apre. */
const FAILURE_THRESHOLD = 3;

/** Durata dell'apertura del circuito: per 5 minuti non si tenta nemmeno. */
const COOLDOWN_MS = 5 * 60_000;

/** Identità dichiarata nell'handshake MCP (compare nei log di graphify). */
const CLIENT_NAME = "stubwise-server";
const CLIENT_VERSION = "1.0.0";

/**
 * Estrae il testo del primo blocco di contenuto testuale del risultato. La
 * firma di `callTool` dell'SDK è un'unione permissiva (schema di risultato
 * standard o di compatibilità), quindi navighiamo la struttura difensivamente:
 * una risposta di forma inattesa vale `null`, non un errore.
 */
function firstTextContent(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if ((block as { type?: unknown }).type !== "text") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}

/**
 * Crea il client verso il server MCP graphify.
 *
 * Connessione **pigra e cached**: `Client` e transport nascono alla prima query
 * e vengono riusati (il serve è stateless, ma l'handshake costa comunque un
 * round trip). Su errore di trasporto la connessione cached viene chiusa e
 * azzerata, così il tentativo successivo si riconnette da zero.
 *
 * **Circuit breaker**: dopo {@link FAILURE_THRESHOLD} errori CONSECUTIVI il
 * circuito si apre per {@link COOLDOWN_MS} e `queryGraph` ritorna `null` senza
 * fare I/O (un solo `warn` all'apertura, non a ogni chiamata respinta). Il primo
 * tentativo dopo il cooldown fa da sonda: se fallisce il circuito si riapre
 * subito, se riesce il contatore si azzera.
 *
 * **Distinzione degli errori** — un risultato con `isError: true` (tool
 * eseguito ma fallito, tipicamente perché per quel `project_path` il grafo non
 * esiste) è un errore MORBIDO: ritorna `null` ma NON incrementa il breaker e non
 * chiude la connessione. Il grafo mancante di UN repository non deve spegnere il
 * retrieval per tutti gli altri.
 */
export function createGraphMcpClient(options: GraphMcpClientOptions): GraphMcpClient {
  const { url, logger } = options;
  const now = options.now ?? Date.now;

  /** Connessione cached come promessa: chiamate concorrenti ne condividono una sola. */
  let connection: Promise<Client> | null = null;
  let consecutiveFailures = 0;
  /** Istante (ms) fino al quale il circuito resta aperto; 0 = chiuso. */
  let openUntil = 0;

  async function openConnection(timeoutMs: number): Promise<Client> {
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err;
    }
    return client;
  }

  /**
   * Chiude una connessione e la dimentica se è ancora quella cached: una query
   * concorrente potrebbe averla già sostituita, e in quel caso azzerare
   * `connection` chiuderebbe una connessione sana. Riconnessione pigra al giro
   * dopo.
   */
  async function dropConnection(used: Promise<Client> | null): Promise<void> {
    if (!used) return;
    if (connection === used) connection = null;
    try {
      await (await used).close();
    } catch {
      // La connessione era già rotta: non c'è niente da salvare.
    }
  }

  function registerFailure(err: unknown): void {
    consecutiveFailures += 1;
    logger.debug({ err, url }, "[graph-chat] query al grafo fallita");
    if (consecutiveFailures < FAILURE_THRESHOLD) return;
    openUntil = now() + COOLDOWN_MS;
    logger.warn(
      { url, consecutiveFailures, cooldownMs: COOLDOWN_MS },
      "[graph-chat] server MCP graphify irraggiungibile: retrieval dal grafo sospeso",
    );
  }

  return {
    async queryGraph({ projectPath, question, tokenBudget, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (now() < openUntil) return null;
      const used = (connection ??= openConnection(timeoutMs));
      try {
        const client = await used;
        const result = await client.callTool(
          {
            name: "query_graph",
            arguments: { question, project_path: projectPath, token_budget: tokenBudget },
          },
          undefined,
          { timeout: timeoutMs },
        );
        if (result.isError === true) {
          // Errore morbido: il trasporto funziona, il breaker resta com'è.
          logger.debug(
            { projectPath, detail: firstTextContent(result) },
            "[graph-chat] query_graph ha risposto con un errore applicativo",
          );
          return null;
        }
        consecutiveFailures = 0;
        openUntil = 0;
        return firstTextContent(result);
      } catch (err) {
        await dropConnection(used);
        registerFailure(err);
        return null;
      }
    },

    close: () => dropConnection(connection),
  };
}
