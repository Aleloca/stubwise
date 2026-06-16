import { z } from "zod";

/**
 * Configurazione del worker via variabili d'ambiente, validata con Zod come
 * quella del server (apps/server/src/config.ts): un solo errore leggibile
 * che elenca tutte le variabili mancanti o non valide (self-hosting).
 * ENCRYPTION_KEY deve essere la STESSA del server: è la chiave con cui il
 * server cifra git_accounts.encrypted_credentials che il worker decifra
 * (caricando l'account collegato al progetto del ticket).
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
  // coda. Deve restare > del tempo massimo di un job: vedi l'invariante
  // verificata in index.ts. Min 1; il default 150 min supera con margine
  // l'invariante col fix in due fasi (plan 10' + fix 30') PIÙ il loop di
  // self-repair (2 RE-tentativi × (fix 30' + test 5') = 70') + 2× triage 2' +
  // margine 5' ≈ 119'.
  WORKER_STALE_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 in minuti (es. 150)" })
      .int("deve essere un intero ≥ 1 in minuti (es. 150)")
      .min(1, "deve essere un intero ≥ 1 in minuti (es. 150)")
      .default(150),
  ),
  // Fix in DUE FASI per ridurre i costi: un modello "forte" (FIX_PLAN_MODEL)
  // analizza il bug in sola lettura e produce un piano; un modello più
  // economico (FIX_EXECUTE_MODEL) implementa il fix seguendo il piano. Con
  // FIX_TWO_PHASE=false si esegue un singolo run con FIX_EXECUTE_MODEL (il
  // comportamento storico, utile per confronto/rollback).
  FIX_PLAN_MODEL: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere il nome di un modello (es. opus)" })
      .min(1)
      .default("opus"),
  ),
  FIX_EXECUTE_MODEL: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere il nome di un modello (es. sonnet)" })
      .min(1)
      .default("sonnet"),
  ),
  FIX_TWO_PHASE: z.preprocess(
    (value) => (value === "" ? undefined : value === "true" ? true : value === "false" ? false : value),
    z.boolean({ error: "deve essere true o false" }).default(true),
  ),
  // Timeout dedicato del run di pianificazione (default 10'): più corto del fix
  // perché è sola analisi. Entra nell'invariante di staleness in index.ts
  // (plan + fix invece di 2× fix), così la soglia resta più contenuta.
  FIX_PLAN_TIMEOUT_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero > 0 in millisecondi (es. 600000)" })
      .int("deve essere un intero > 0 in millisecondi (es. 600000)")
      .min(1, "deve essere un intero > 0 in millisecondi (es. 600000)")
      .default(600_000),
  ),
  // Loop di self-repair (Task 5): dopo il run di esecuzione, il WORKER esegue
  // da sé il comando di test del repo nel worktree; se i test falliscono
  // reinvoca l'agente con l'output del fallimento, fino a questo numero di
  // RE-tentativi (1 esecuzione iniziale + fino a N riparazioni). 0 = loop
  // disattivato (comportamento storico: si committa senza eseguire i test).
  // Entra nell'invariante di staleness in index.ts perché può aggiungere fino a
  // N esecuzioni extra dell'agente + altrettanti run del comando di test.
  SELF_REPAIR_MAX_ATTEMPTS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 (es. 2; 0 = disattivato)" })
      .int("deve essere un intero ≥ 0 (es. 2; 0 = disattivato)")
      .min(0, "deve essere un intero ≥ 0 (es. 2; 0 = disattivato)")
      .default(2),
  ),
  // Timeout di OGNI esecuzione del comando di test nel loop di self-repair
  // (default 5'). Entra nell'invariante di staleness in index.ts.
  SELF_REPAIR_TEST_TIMEOUT_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero > 0 in millisecondi (es. 300000)" })
      .int("deve essere un intero > 0 in millisecondi (es. 300000)")
      .min(1, "deve essere un intero > 0 in millisecondi (es. 300000)")
      .default(300_000),
  ),
  // URL pubblico dell'istanza, usato SOLO per comporre il link al ticket nelle
  // notifiche webhook in uscita. Opzionale: vuoto (default) = il link è il solo
  // path (/tickets/:id). Gli slash finali vengono rimossi così la concatenazione
  // non produce doppi slash.
  PUBLIC_URL: z.preprocess(
    (value) => (typeof value === "string" ? value.replace(/\/+$/, "") : value),
    z.string().default(""),
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
   * orfano e riportato in coda (default 150). */
  staleAfterMinutes: number;
  /** Modello del run di pianificazione del fix (forte, read-only; default
   * "opus"). */
  fixPlanModel: string;
  /** Modello del run di esecuzione del fix (economico; default "sonnet"). */
  fixExecuteModel: string;
  /** Se true (default) il fix gira in due fasi (plan + execute); se false un
   * solo run con fixExecuteModel (comportamento storico). */
  fixTwoPhase: boolean;
  /** Timeout del run di pianificazione in ms (default 600000 = 10'). */
  fixPlanTimeoutMs: number;
  /** Numero massimo di RE-tentativi del loop di self-repair (default 2; 0 =
   * disattivato). 1 esecuzione iniziale + fino a N riparazioni. */
  selfRepairMaxAttempts: number;
  /** Timeout di ogni esecuzione del comando di test nel self-repair (default
   * 300000 = 5'). */
  selfRepairTestTimeoutMs: number;
  /** URL pubblico dell'istanza (senza slash finali) per i link nelle notifiche;
   * vuoto = il link al ticket è il solo path. */
  publicUrl: string;
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
    fixPlanModel: parsed.FIX_PLAN_MODEL,
    fixExecuteModel: parsed.FIX_EXECUTE_MODEL,
    fixTwoPhase: parsed.FIX_TWO_PHASE,
    fixPlanTimeoutMs: parsed.FIX_PLAN_TIMEOUT_MS,
    selfRepairMaxAttempts: parsed.SELF_REPAIR_MAX_ATTEMPTS,
    selfRepairTestTimeoutMs: parsed.SELF_REPAIR_TEST_TIMEOUT_MS,
    publicUrl: parsed.PUBLIC_URL,
  };
}
