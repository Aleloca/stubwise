import { z } from "zod";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const envSchema = z.object({
  DATABASE_URL: z.url({
    error: (issue) =>
      issue.input === undefined
        ? "variabile mancante: URL di connessione Postgres (es. postgres://user:pass@host:5432/stubwise)"
        : "deve essere un URL di connessione valido (es. postgres://user:pass@host:5432/stubwise)",
  }),
  SESSION_SECRET: z
    .string({
      error: () => "variabile mancante: segreto per le sessioni (genera con: openssl rand -hex 32)",
    })
    .min(32, "deve essere lunga almeno 32 caratteri (genera con: openssl rand -hex 32)"),
  ENCRYPTION_KEY: z
    .string({
      error: () =>
        "variabile mancante: chiave di cifratura (genera con: openssl rand -base64 32)",
    })
    .refine((value) => BASE64_RE.test(value) && Buffer.from(value, "base64").length === 32, {
      error: "deve essere 32 byte codificati in base64 (genera con: openssl rand -base64 32)",
    }),
  // Una stringa vuota (es. `PORT=` copiata da .env.example) usa il default.
  PORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number({ error: "deve essere un numero di porta valido (es. 3000)" })
      .int("deve essere un numero di porta valido (es. 3000)")
      .min(1, "deve essere un numero di porta valido tra 1 e 65535 (es. 3000)")
      .max(65535, "deve essere un numero di porta valido tra 1 e 65535 (es. 3000)")
      .default(3000),
  ),
  PUBLIC_URL: z.url({
    error: (issue) =>
      issue.input === undefined
        ? "variabile mancante: URL pubblico dell'istanza (es. https://stubwise.example.com)"
        : "deve essere un URL valido (es. https://stubwise.example.com)",
  }),
  // Dietro un reverse proxy (Caddy nel deploy Docker) Fastify deve fidarsi di
  // X-Forwarded-Proto/For, altrimenti `secure: "auto"` sul cookie di sessione
  // non vede l'HTTPS terminato dal proxy e non imposta il flag Secure.
  // Default false (sviluppo diretto, niente proxy davanti); il compose lo
  // imposta a true. Accetta booleani e le stringhe true/false/1/0 da .env.
  TRUST_PROXY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .transform((value) => value === true || value === "true" || value === "1")
      .default(false),
  ),
  // Endpoint OpenAI-compatibile per gli embedding della ricerca semantica e
  // della chat RAG sui Docs (/v1/embeddings). Di default Ollama in-rete
  // (servizio "ollama" del compose); puntabile a un provider esterno cambiando
  // la sola variabile. Stessa famiglia di variabili del worker.
  EMBEDDING_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string({ error: "deve essere l'URL base di un endpoint /v1 OpenAI-compatibile" })
      .min(1)
      .default("http://ollama:11434/v1"),
  ),
  // Modello di embedding richiesto all'endpoint sopra. Default bge-m3
  // (multilingue, 1024 dim — vedi la colonna vector dello schema).
  EMBEDDING_MODEL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string({ error: "deve essere il nome di un modello di embedding (es. bge-m3)" })
      .min(1)
      .default("bge-m3"),
  ),
  // Chiave API per l'endpoint di embedding. Opzionale: Ollama in-rete non la
  // richiede (vuoto/non impostata); un provider esterno sì.
  EMBEDDING_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  // Tetto giornaliero per progetto dei messaggi di chat del widget customer
  // service (anti-abuso/costo). Tunabile solo al deploy. Default 200.
  WIDGET_DAILY_MESSAGE_CAP: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number({ error: "deve essere un numero intero positivo (es. 200)" })
      .int("deve essere un numero intero positivo (es. 200)")
      .min(1, "deve essere un numero intero positivo (es. 200)")
      .default(200),
  ),
  // Tetto giornaliero per progetto delle segnalazioni (ticket) create dal
  // widget customer service. Tunabile solo al deploy. Default 50.
  WIDGET_DAILY_TICKET_CAP: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number({ error: "deve essere un numero intero positivo (es. 50)" })
      .int("deve essere un numero intero positivo (es. 50)")
      .min(1, "deve essere un numero intero positivo (es. 50)")
      .default(50),
  ),
  // Radice del VOLUME condiviso dei grafi (graphify). Il worker ci SCRIVE
  // `<GRAPHS_DIR>/<repositoryId>/graphify-out/`, il server lo monta READ-ONLY e
  // ne serve report/html/json alla SPA. Stesso default del worker (/graphs):
  // devono puntare allo stesso volume.
  GRAPHS_DIR: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string({ error: "deve essere il path della directory dei grafi" })
      .min(1)
      .default("/graphs"),
  ),
  // URL del server MCP graphify (container `graphify`, solo rete interna) da cui
  // le chat interne recuperano il sottografo del codice. ATTENZIONE: qui la
  // stringa VUOTA non significa "usa il default" come nelle altre variabili, ma
  // "feature spenta" → è il ROLLBACK SWITCH del retrieval dal grafo: basta
  // `GRAPHIFY_MCP_URL=` nel .env e le chat tornano al solo retrieval pgvector,
  // senza ridistribuire nulla.
  GRAPHIFY_MCP_URL: z
    .string({ error: "deve essere l'URL del server MCP graphify (vuota per disattivare)" })
    .default("http://graphify:8080/mcp")
    .transform((value) => (value.trim() === "" ? undefined : value.trim())),
  // Budget di token chiesto a `query_graph` per il sottografo di UNA domanda.
  // Nelle chat di progetto viene diviso per il numero di repo interrogati.
  GRAPH_CHAT_TOKEN_BUDGET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number({ error: "deve essere un numero intero positivo (es. 1200)" })
      .int("deve essere un numero intero positivo (es. 1200)")
      .min(1, "deve essere un numero intero positivo (es. 1200)")
      .default(1200),
  ),
  // Tetto complessivo dei caratteri di codice allegati a una risposta: oltre,
  // si smette di aggiungere snippet (il sottografo resta comunque intero).
  GRAPH_CHAT_SNIPPET_MAX_CHARS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number({ error: "deve essere un numero intero positivo (es. 6000)" })
      .int("deve essere un numero intero positivo (es. 6000)")
      .min(1, "deve essere un numero intero positivo (es. 6000)")
      .default(6000),
  ),
  // Quanti nodi del sottografo, al massimo, diventano uno snippet di codice.
  GRAPH_CHAT_SNIPPET_NODES: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number({ error: "deve essere un numero intero positivo (es. 6)" })
      .int("deve essere un numero intero positivo (es. 6)")
      .min(1, "deve essere un numero intero positivo (es. 6)")
      .default(6),
  ),
  // Radice del volume dei mirror git bare. Li CLONA il worker; il server lo
  // monta READ-ONLY per leggere i blob citati negli snippet
  // (`git --git-dir=<MIRRORS_DIR>/<mirrorSlug> show <sha>:<path>`). Stesso
  // default del worker (/var/stubwise/mirrors): devono puntare allo stesso
  // volume, altrimenti gli snippet spariscono silenziosamente.
  MIRRORS_DIR: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string({ error: "deve essere il path della directory dei mirror git" })
      .min(1)
      .default("/var/stubwise/mirrors"),
  ),
});

export interface Config {
  databaseUrl: string;
  sessionSecret: string;
  encryptionKey: string;
  port: number;
  publicUrl: string;
  /** Fidarsi degli header X-Forwarded-* (dietro reverse proxy). */
  trustProxy: boolean;
  /** Base URL OpenAI-compatibile per gli embedding (ricerca/chat Docs). */
  embeddingBaseUrl: string;
  /** Modello di embedding (es. bge-m3, 1024 dim). */
  embeddingModel: string;
  /** API key opzionale per l'endpoint di embedding. */
  embeddingApiKey?: string;
  /** Tetto giornaliero per progetto dei messaggi di chat del widget (default 200). */
  widgetDailyMessageCap: number;
  /** Tetto giornaliero per progetto delle segnalazioni dal widget (default 50). */
  widgetDailyTicketCap: number;
  /** Radice del volume dei grafi graphify, montato read-only (default /graphs). */
  graphsDir: string;
  /**
   * URL del server MCP graphify per il retrieval dal grafo nelle chat.
   * `undefined` = feature spenta (variabile impostata a stringa vuota).
   */
  graphifyMcpUrl?: string;
  /** Budget di token del sottografo chiesto a `query_graph` (default 1200). */
  graphChatTokenBudget: number;
  /** Tetto dei caratteri di codice allegati a una risposta (default 6000). */
  graphChatSnippetMaxChars: number;
  /** Massimo numero di nodi del sottografo da cui estrarre snippet (default 6). */
  graphChatSnippetNodes: number;
  /** Radice del volume dei mirror git bare, montato read-only (default /var/stubwise/mirrors). */
  mirrorsDir: string;
}

/**
 * Valida le variabili d'ambiente e restituisce la configurazione.
 * Lancia un errore con un messaggio leggibile che elenca ogni variabile
 * mancante o non valida (esperienza self-hosting).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(
      [
        "Configurazione non valida. Correggi queste variabili d'ambiente:",
        ...lines,
        "Vedi .env.example per la descrizione di ogni variabile.",
      ].join("\n"),
    );
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    sessionSecret: parsed.SESSION_SECRET,
    encryptionKey: parsed.ENCRYPTION_KEY,
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL,
    trustProxy: parsed.TRUST_PROXY,
    embeddingBaseUrl: parsed.EMBEDDING_BASE_URL,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingApiKey: parsed.EMBEDDING_API_KEY,
    widgetDailyMessageCap: parsed.WIDGET_DAILY_MESSAGE_CAP,
    widgetDailyTicketCap: parsed.WIDGET_DAILY_TICKET_CAP,
    graphsDir: parsed.GRAPHS_DIR,
    graphifyMcpUrl: parsed.GRAPHIFY_MCP_URL,
    graphChatTokenBudget: parsed.GRAPH_CHAT_TOKEN_BUDGET,
    graphChatSnippetMaxChars: parsed.GRAPH_CHAT_SNIPPET_MAX_CHARS,
    graphChatSnippetNodes: parsed.GRAPH_CHAT_SNIPPET_NODES,
    mirrorsDir: parsed.MIRRORS_DIR,
  };
}
