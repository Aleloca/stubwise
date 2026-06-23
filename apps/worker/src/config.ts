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
  // self-repair (2 RE-tentativi × (fix 30' + test 5') = 70') + install (una
  // volta) 10' + 2× triage 2' + margine 5' ≈ 129'.
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
  // Timeout dell'install delle dipendenze nel worktree (default 10'). L'install
  // gira UNA SOLA VOLTA, prima dell'agente, così le sue dipendenze sono già
  // presenti. Entra nell'invariante di staleness in index.ts come addendo unico
  // (non per tentativo).
  INSTALL_TIMEOUT_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero > 0 in millisecondi (es. 600000)" })
      .int("deve essere un intero > 0 in millisecondi (es. 600000)")
      .min(1, "deve essere un intero > 0 in millisecondi (es. 600000)")
      .default(600_000),
  ),
  // URL pubblico dell'istanza, usato SOLO per comporre il link al ticket nelle
  // notifiche webhook in uscita. Opzionale: vuoto (default) = il link è il solo
  // path (/tickets/:id). Gli slash finali vengono rimossi così la concatenazione
  // non produce doppi slash.
  PUBLIC_URL: z.preprocess(
    (value) => (typeof value === "string" ? value.replace(/\/+$/, "") : value),
    z.string().default(""),
  ),
  // Intervallo in minuti del poller dell'usage residuo dell'abbonamento (task
  // separato dal loop dei job, vedi agent/usage-poller.ts): legge `/usage` via
  // PTY e salva uno snapshot. È BEST-EFFORT e non tocca i timeout dei job.
  // 0 = disabilitato. Default 5'.
  USAGE_POLL_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 in minuti (es. 5; 0 = disabilitato)" })
      .int("deve essere un intero ≥ 0 in minuti (es. 5; 0 = disabilitato)")
      .min(0, "deve essere un intero ≥ 0 in minuti (es. 5; 0 = disabilitato)")
      .default(5),
  ),
  // Intervallo di poll (secondi) del tester delle credenziali AI (task separato
  // dal loop dei job, vedi agent/credential-tester.ts): raccoglie le richieste
  // di test marcate `pending` dal server ed esegue un `claude -p` di prova con
  // quella credenziale. Più frequente dell'usage-poll perché è interattivo
  // (l'admin attende l'esito in UI). È BEST-EFFORT e non tocca i timeout dei
  // job. 0 = disabilitato. Default 5".
  CREDENTIAL_TEST_POLL_SECONDS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 in secondi (es. 5; 0 = disabilitato)" })
      .int("deve essere un intero ≥ 0 in secondi (es. 5; 0 = disabilitato)")
      .min(0, "deve essere un intero ≥ 0 in secondi (es. 5; 0 = disabilitato)")
      .default(5),
  ),
  // Modello usato dalla pipeline di generazione della documentazione (Docs):
  // un run per modulo che scrive la pagina tecnica/funzionale. Forte per
  // default (qualità della prosa e comprensione del codice), come FIX_PLAN_MODEL.
  DOC_GENERATION_MODEL: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere il nome di un modello (es. opus)" })
      .min(1)
      .default("opus"),
  ),
  // Tetto al numero di moduli documentati in una singola generazione: protegge
  // da repo enormi (un run dell'agente per modulo → costo/tempo lineari). Lo
  // scoring di docs-engine ordina i moduli e taglia oltre questa soglia.
  DOC_MAX_MODULES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 (es. 80)" })
      .int("deve essere un intero ≥ 1 (es. 80)")
      .min(1, "deve essere un intero ≥ 1 (es. 80)")
      .default(80),
  ),
  // Tetto al numero di capability documentate in PROFONDITÀ in una singola
  // generazione (deep pass funzionale): un run dell'agente per capability →
  // costo/tempo lineari. Le capability oltre la soglia non sono scartate in
  // silenzio: docs-engine le LOGGA (cappedCapabilities) e restano comunque
  // nell'indice della mappa funzionale.
  DOC_MAX_CAPABILITIES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 (es. 40)" })
      .int("deve essere un intero ≥ 1 (es. 40)")
      .min(1, "deve essere un intero ≥ 1 (es. 40)")
      .default(40),
  ),
  // Timeout (ms) di OGNI singola chiamata dell'agente nella generazione dei Docs
  // (map per modulo, reduce, deep pass per capability). Più corto del timeout del
  // fix (30'): una chiamata appesa fallisce in ~8' (default) e va in best-effort
  // (skip/retry della pagina) invece di tenere il job bloccato per mezz'ora.
  DOC_AGENT_TIMEOUT_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero > 0 in millisecondi (es. 480000)" })
      .int("deve essere un intero > 0 in millisecondi (es. 480000)")
      .min(1, "deve essere un intero > 0 in millisecondi (es. 480000)")
      .default(480_000),
  ),
  // Numero massimo di turni dell'agente per la pagina di un singolo modulo:
  // limita esplorazione/iterazioni del run (costo e durata per modulo).
  DOC_MODULE_MAX_TURNS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 (es. 30)" })
      .int("deve essere un intero ≥ 1 (es. 30)")
      .min(1, "deve essere un intero ≥ 1 (es. 30)")
      .default(30),
  ),
  // Profondità massima del DAG di documentazione ricorsivo: un nodo a questa
  // profondità è trattato come FOGLIA anche se l'esplorazione proporrebbe figli
  // (i figli vengono ignorati e loggati, mai un cap silenzioso). Protegge da una
  // ricorsione patologica su repo molto annidati. Default 6 (≈ radice + 5 livelli).
  DOC_MAX_DEPTH: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 (es. 6)" })
      .int("deve essere un intero ≥ 1 (es. 6)")
      .min(1, "deve essere un intero ≥ 1 (es. 6)")
      .default(6),
  ),
  // Tetto al numero TOTALE di nodi del DAG in una singola generazione: ogni nodo
  // è un run dell'agente (explore/synthesize), quindi costo/tempo crescono col
  // numero di nodi. Quando creare i figli proposti supererebbe questo tetto, la
  // child-list viene TAGLIATA per restare nel budget (i figli scartati sono
  // loggati, mai un cap silenzioso). Default 400.
  DOC_MAX_NODES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 (es. 400)" })
      .int("deve essere un intero ≥ 1 (es. 400)")
      .min(1, "deve essere un intero ≥ 1 (es. 400)")
      .default(400),
  ),
  // Cap di costo (USD) per SINGOLA generazione di documentazione: se il costo
  // aggregato dei run dell'agente lo supera, la generazione è marcata `failed`
  // e il job messo in `held` con ragione loggata (mai un cap silenzioso); NON
  // si fa lo swap del puntatore. Opzionale: NON impostata (default) = nessun
  // cap, costo ILLIMITATO — i deploy esistenti non cambiano comportamento. Va
  // impostata a un valore > 0 per attivare il guardrail (es. 5 = $5/generazione).
  DOC_COST_CAP_USD: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un numero > 0 in USD (es. 5)" })
      .positive("deve essere un numero > 0 in USD (es. 5)")
      .optional(),
  ),
  // Endpoint OpenAI-compatibile per gli embedding della ricerca semantica sui
  // Docs (/v1/embeddings). Di default Ollama in-rete (servizio "ollama" del
  // compose); puntabile a un provider esterno cambiando la sola variabile.
  EMBEDDING_BASE_URL: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere l'URL base di un endpoint /v1 OpenAI-compatibile" })
      .min(1)
      .default("http://ollama:11434/v1"),
  ),
  // Modello di embedding richiesto all'endpoint sopra. Default bge-m3
  // (multilingue, 1024 dim — vedi la colonna vector dello schema).
  EMBEDDING_MODEL: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere il nome di un modello di embedding (es. bge-m3)" })
      .min(1)
      .default("bge-m3"),
  ),
  // Chiave API per l'endpoint di embedding. Opzionale: Ollama in-rete non la
  // richiede (vuoto/non impostata); un provider esterno sì.
  EMBEDDING_API_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
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
  /** Timeout dell'install delle dipendenze nel worktree, eseguito una sola
   * volta prima dell'agente (default 600000 = 10'). */
  installTimeoutMs: number;
  /** URL pubblico dell'istanza (senza slash finali) per i link nelle notifiche;
   * vuoto = il link al ticket è il solo path. */
  publicUrl: string;
  /** Intervallo in minuti del poller dell'usage residuo (default 5; 0 =
   * disabilitato). */
  usagePollMinutes: number;
  /** Intervallo in secondi del tester delle credenziali AI (default 5; 0 =
   * disabilitato). */
  credentialTestPollSeconds: number;
  /** Modello della pipeline di generazione dei Docs (default "opus"). */
  docGenerationModel: string;
  /** Tetto al numero di moduli documentati per generazione (default 80). */
  docMaxModules: number;
  /** Tetto al numero di capability documentate in profondità per generazione
   * (deep pass funzionale; default 40). */
  docMaxCapabilities: number;
  /** Timeout (ms) di ogni singola chiamata dell'agente nella generazione dei Docs
   * (map/reduce/deep pass); default 480000 = 8'. */
  docAgentTimeoutMs: number;
  /** Turni massimi dell'agente per la pagina di un modulo (default 30). */
  docModuleMaxTurns: number;
  /** Profondità massima del DAG ricorsivo: a questa profondità un nodo è
   * trattato come foglia (figli proposti ignorati e loggati; default 6). */
  docMaxDepth: number;
  /** Tetto al numero totale di nodi del DAG per generazione: la creazione dei
   * figli che lo supererebbe viene tagliata e loggata (default 400). */
  docMaxNodes: number;
  /** Cap di costo (USD) per generazione di documentazione; undefined = nessun
   * cap (costo illimitato, default). Se sforato la generazione è `held`. */
  docCostCapUsd: number | undefined;
  /** Endpoint /v1 OpenAI-compatibile per gli embedding dei Docs
   * (default "http://ollama:11434/v1"). */
  embeddingBaseUrl: string;
  /** Modello di embedding (default "bge-m3"). */
  embeddingModel: string;
  /** Chiave API dell'endpoint di embedding; undefined se non richiesta. */
  embeddingApiKey: string | undefined;
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
    installTimeoutMs: parsed.INSTALL_TIMEOUT_MS,
    publicUrl: parsed.PUBLIC_URL,
    usagePollMinutes: parsed.USAGE_POLL_MINUTES,
    credentialTestPollSeconds: parsed.CREDENTIAL_TEST_POLL_SECONDS,
    docGenerationModel: parsed.DOC_GENERATION_MODEL,
    docMaxModules: parsed.DOC_MAX_MODULES,
    docMaxCapabilities: parsed.DOC_MAX_CAPABILITIES,
    docAgentTimeoutMs: parsed.DOC_AGENT_TIMEOUT_MS,
    docModuleMaxTurns: parsed.DOC_MODULE_MAX_TURNS,
    docMaxDepth: parsed.DOC_MAX_DEPTH,
    docMaxNodes: parsed.DOC_MAX_NODES,
    docCostCapUsd: parsed.DOC_COST_CAP_USD,
    embeddingBaseUrl: parsed.EMBEDDING_BASE_URL,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingApiKey: parsed.EMBEDDING_API_KEY,
  };
}
