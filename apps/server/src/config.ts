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
  };
}
