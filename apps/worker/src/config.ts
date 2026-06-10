import { z } from "zod";

/**
 * Configurazione del worker via variabili d'ambiente, validata con Zod come
 * quella del server (apps/server/src/config.ts): un solo errore leggibile
 * che elenca tutte le variabili mancanti o non valide (self-hosting).
 * ENCRYPTION_KEY deve essere la STESSA del server: è la chiave con cui il
 * server cifra projects.encrypted_credentials che il worker decifra.
 */

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Una stringa vuota (es. `VAR=` copiata da .env.example) usa il default. */
function emptyAsUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

const envSchema = z.object({
  DATABASE_URL: z.url({
    error: (issue) =>
      issue.input === undefined
        ? "variabile mancante: URL di connessione Postgres (es. postgres://user:pass@host:5432/stubwise)"
        : "deve essere un URL di connessione valido (es. postgres://user:pass@host:5432/stubwise)",
  }),
  ENCRYPTION_KEY: z
    .string({
      error: () =>
        "variabile mancante: chiave di cifratura, la STESSA del server (genera con: openssl rand -base64 32)",
    })
    .refine((value) => BASE64_RE.test(value) && Buffer.from(value, "base64").length === 32, {
      error: "deve essere 32 byte codificati in base64 (genera con: openssl rand -base64 32)",
    }),
  MIRRORS_DIR: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere il path della directory dei mirror git" })
      .min(1)
      .default("/var/stubwise/mirrors"),
  ),
  WORKER_CONCURRENCY: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero tra 1 e 16 (es. 2)" })
      .int("deve essere un intero tra 1 e 16 (es. 2)")
      .min(1, "deve essere un intero tra 1 e 16 (es. 2)")
      .max(16, "deve essere un intero tra 1 e 16 (es. 2)")
      .default(2),
  ),
  // Soglia di staleness per requeueStale: un job in lavorazione senza
  // heartbeat oltre questo limite è orfano di un worker crashato e torna in
  // coda. Deve restare > del timeout del fix (+ triage): vedi l'invariante
  // verificata in index.ts. Min 1 (il default copre il fix da 30').
  WORKER_STALE_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 in minuti (es. 30)" })
      .int("deve essere un intero ≥ 1 in minuti (es. 30)")
      .min(1, "deve essere un intero ≥ 1 in minuti (es. 30)")
      .default(30),
  ),
});

export interface WorkerConfig {
  databaseUrl: string;
  /** Chiave AES-256 già decodificata: pronta per decrypt(). */
  encryptionKey: Buffer;
  mirrorsDir: string;
  /** Job in volo contemporanei (su progetti DIVERSI: quelli dello stesso
   * progetto vengono comunque serializzati dall'handler). */
  concurrency: number;
  /** Minuti di inattività oltre cui un job in lavorazione è considerato
   * orfano e riportato in coda (default 30). */
  staleAfterMinutes: number;
}

/**
 * Valida le variabili d'ambiente e restituisce la configurazione del worker.
 * Lancia un errore con un messaggio leggibile che elenca ogni variabile
 * mancante o non valida.
 */
export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(
      [
        "Configurazione del worker non valida. Correggi queste variabili d'ambiente:",
        ...lines,
        "Vedi .env.example per la descrizione di ogni variabile.",
      ].join("\n"),
    );
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    encryptionKey: Buffer.from(parsed.ENCRYPTION_KEY, "base64"),
    mirrorsDir: parsed.MIRRORS_DIR,
    concurrency: parsed.WORKER_CONCURRENCY,
    staleAfterMinutes: parsed.WORKER_STALE_MINUTES,
  };
}
