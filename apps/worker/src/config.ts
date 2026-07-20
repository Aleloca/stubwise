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
  DATABASE_POOL_MAX: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero tra 1 e 100 (es. 10)" })
      .int("deve essere un intero tra 1 e 100 (es. 10)")
      .min(1, "deve essere un intero tra 1 e 100 (es. 10)")
      .max(100, "deve essere un intero tra 1 e 100 (es. 10)")
      .default(10),
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
  // Intervallo di poll (secondi) del poller di auto-aggiornamento Docs (task
  // separato dal loop dei job, vedi docs/auto-update-poller.ts): reclama i pending
  // di doc_auto_update_jobs scaduti (debounce) ed esegue l'agente che produce la
  // entry release. È BEST-EFFORT e non tocca i timeout dei job. 0 = disabilitato.
  // Default 60".
  DOCS_AUTOUPDATE_POLL_SECONDS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 in secondi (es. 60; 0 = disabilitato)" })
      .int("deve essere un intero ≥ 0 in secondi (es. 60; 0 = disabilitato)")
      .min(0, "deve essere un intero ≥ 0 in secondi (es. 60; 0 = disabilitato)")
      .default(60),
  ),
  // Tetto al numero di pagine di documentazione rigenerate in-place ad ogni push
  // dell'auto-aggiornamento Docs (Fase 2, vedi docs/auto-update.ts): l'agente di
  // refresh-pagina riscrive solo le pagine il cui sourcePath è toccato dal diff, fino
  // a questo cap (le altre impattate sono segnalate come "troncate" nella entry). 0 =
  // disabilita la rigenerazione mirata lasciando SOLO la entry release (comportamento
  // Fase 1). Default 10.
  DOCS_AUTOUPDATE_MAX_PAGES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 (es. 10; 0 = disabilita la rigenerazione)" })
      .int("deve essere un intero ≥ 0 (es. 10; 0 = disabilita la rigenerazione)")
      .min(0, "deve essere un intero ≥ 0 (es. 10; 0 = disabilita la rigenerazione)")
      .default(10),
  ),
  // Tetto al numero di pagine di documentazione NUOVE create ad ogni push per le AREE
  // non ancora documentate (Fase 3, vedi docs/auto-update.ts): un mini-orient propone
  // fino a questo numero di pagine per i file cambiati che nessuna pagina copre, e le
  // crea nella generazione corrente. 0 = disabilita la creazione incrementale (le aree
  // nuove restano solo segnalate nella entry release). Default 5.
  DOCS_AUTOUPDATE_MAX_NEW_PAGES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 (es. 5; 0 = disabilita la creazione)" })
      .int("deve essere un intero ≥ 0 (es. 5; 0 = disabilita la creazione)")
      .min(0, "deve essere un intero ≥ 0 (es. 5; 0 = disabilita la creazione)")
      .default(5),
  ),
  // Tetto al numero di pagine di documentazione PRODUCT create PER VERTICALE dalla FASE
  // product (Fase B, vedi docs/recursive/product-handler.ts): dopo la chiusura dei due
  // alberi interni, per ogni superficie PUBBLICA UI del brief si genera una verticale
  // (radice + guide per journey + FAQ) fino a questo tetto PER SUPERFICIE (ogni verticale
  // riparte col suo budget). Budget SEPARATO da DOC_MAX_NODES.
  // 0 = fase product spenta (nessuna verticale pubblica; retrocompatibilità totale).
  // Default 12.
  DOC_PRODUCT_MAX_PAGES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 (es. 12; 0 = fase product disattivata)" })
      .int("deve essere un intero ≥ 0 (es. 12; 0 = fase product disattivata)")
      .min(0, "deve essere un intero ≥ 0 (es. 12; 0 = fase product disattivata)")
      .default(12),
  ),
  // Intervallo di poll (secondi) del poller dell'automazione PR Review (task
  // separato dal loop dei job, vedi review/poller.ts): reclama i pending di
  // pr_review_jobs scaduti (debounce dei push sulla PR) ed esegue l'agente di
  // review — READ-ONLY, in plan mode: legge diff e worktree e produce
  // verdetto+analisi, non modifica nulla. È BEST-EFFORT e non tocca i timeout
  // dei job. 0 = disabilitato. Default 60".
  PR_REVIEW_POLL_SECONDS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 in secondi (es. 60; 0 = disabilitato)" })
      .int("deve essere un intero ≥ 0 in secondi (es. 60; 0 = disabilitato)")
      .min(0, "deve essere un intero ≥ 0 in secondi (es. 60; 0 = disabilitato)")
      .default(60),
  ),
  // Modello dell'agente di PR Review. Economico per default ("sonnet", come
  // FIX_EXECUTE_MODEL): la review gira ad ogni push su ogni PR aperta e il run
  // è di sola analisi sul diff.
  PR_REVIEW_MODEL: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere il nome di un modello (es. sonnet)" })
      .min(1)
      .default("sonnet"),
  ),
  // Turni massimi del run di review: limita esplorazione/iterazioni dell'agente
  // (costo e durata per review).
  PR_REVIEW_MAX_TURNS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 (es. 50)" })
      .int("deve essere un intero ≥ 1 (es. 50)")
      .min(1, "deve essere un intero ≥ 1 (es. 50)")
      .default(50),
  ),
  // Intervallo in minuti del RESUME POLLER dei limiti provider (task separato
  // dal loop dei job, vedi providers/limit-resume-poller.ts): riprende le
  // generazioni Docs `paused` e riaccoda i job `held` con held_reason "limit"
  // quando il provider ha di nuovo headroom (snapshot /usage fresco) o dopo un
  // cooldown a tempo. È BEST-EFFORT e non tocca i timeout dei job.
  // 0 = disabilitato. Default 5'.
  LIMIT_RESUME_POLL_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 in minuti (es. 5; 0 = disabilitato)" })
      .int("deve essere un intero ≥ 0 in minuti (es. 5; 0 = disabilitato)")
      .min(0, "deve essere un intero ≥ 0 in minuti (es. 5; 0 = disabilitato)")
      .default(5),
  ),
  // Soglia di headroom del resume poller: una credenziale `account` è
  // considerata di nuovo utilizzabile quando la sessione usata (dall'ultimo
  // snapshot /usage fresco) è SOTTO questa percentuale (e la weekly < 100%).
  // Default 95: si riparte con almeno il 5% di sessione libera.
  LIMIT_RESUME_HEADROOM_PERCENT: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero tra 1 e 100 (es. 95)" })
      .int("deve essere un intero tra 1 e 100 (es. 95)")
      .min(1, "deve essere un intero tra 1 e 100 (es. 95)")
      .max(100, "deve essere un intero tra 1 e 100 (es. 95)")
      .default(95),
  ),
  // Cooldown (MINUTI) del fallback A TEMPO del resume poller: per le credenziali
  // `api_key` (nessuno snapshot /usage) o con snapshot stantio/assente/non
  // parsato, la ripresa avviene quando la pausa dura da più di questo tempo.
  // Garantisce che nulla resti fermo per sempre. Default 60'.
  LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 in minuti (es. 60)" })
      .int("deve essere un intero ≥ 1 in minuti (es. 60)")
      .min(1, "deve essere un intero ≥ 1 in minuti (es. 60)")
      .default(60),
  ),
  // Timeout (MINUTI) del run dell'agente di review. Default 15': una review
  // appesa fallisce lì e la riga pr_reviews viene chiusa failed. VINCOLO da
  // tenere: deve restare SOTTO WORKER_STALE_MINUTES (default 150) — il recovery
  // del poller (review/poller.ts) chiude failed le righe `running` senza
  // heartbeat da staleAfterMinutes; se mai questo timeout superasse lo stale,
  // il recovery marcherebbe failed una review ancora viva.
  PR_REVIEW_TIMEOUT_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 in minuti (es. 15)" })
      .int("deve essere un intero ≥ 1 in minuti (es. 15)")
      .min(1, "deve essere un intero ≥ 1 in minuti (es. 15)")
      .default(15),
  ),
  // Intervallo in minuti del poller di ROLLUP + retention delle metriche di
  // monitoraggio (task separato dal loop dei job, vedi monitor/rollup.ts):
  // aggrega i campioni fini oltre le 48h in bucket da 5' e applica la retention.
  // È BEST-EFFORT (transazione con rollback su errore) e non tocca i timeout dei
  // job. 0 = disabilitato. Default 5'.
  MONITOR_ROLLUP_INTERVAL_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero tra 0 e 1440 in minuti (es. 5; 0 = disabilitato)" })
      .int("deve essere un intero tra 0 e 1440 in minuti (es. 5; 0 = disabilitato)")
      .min(0, "deve essere un intero tra 0 e 1440 in minuti (es. 5; 0 = disabilitato)")
      .max(1440, "deve essere un intero tra 0 e 1440 in minuti (es. 5; 0 = disabilitato)")
      .default(5),
  ),
  // Intervallo in minuti del poller di VALUTAZIONE ALERT del monitoraggio (task
  // separato dal loop dei job, vedi monitor/alerts.ts): per ogni server valuta
  // offline/soglie sostenute/check down con isteresi ed emette
  // monitor.alert/recovered. È BEST-EFFORT (non lancia mai) e non tocca i timeout
  // dei job. Più frequente del rollup (allarmi reattivi). 0 = disabilitato.
  // Default 1'.
  MONITOR_ALERT_INTERVAL_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero tra 0 e 60 in minuti (es. 1; 0 = disabilitato)" })
      .int("deve essere un intero tra 0 e 60 in minuti (es. 1; 0 = disabilitato)")
      .min(0, "deve essere un intero tra 0 e 60 in minuti (es. 1; 0 = disabilitato)")
      .max(60, "deve essere un intero tra 0 e 60 in minuti (es. 1; 0 = disabilitato)")
      .default(1),
  ),
  // Intervallo in minuti del poller del daily activity report (task separato
  // dal loop dei job): raccoglie i commit del giorno per progetto e genera lo
  // "standup notturno". È BEST-EFFORT e non tocca i timeout dei job.
  // 0 = disabilitato. Default 15'.
  DAILY_REPORT_POLL_MINUTES: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 in minuti (es. 15; 0 = disabilitato)" })
      .int("deve essere un intero ≥ 0 in minuti (es. 15; 0 = disabilitato)")
      .min(0, "deve essere un intero ≥ 0 in minuti (es. 15; 0 = disabilitato)")
      .default(15),
  ),
  // deprecato: non più usato dal modello per-commit (il poller genera una
  // descrizione per OGNI commit non-merge, senza cap per-autore). Lasciato per
  // non rompere la config esistente (env e campo WorkerConfig restano).
  // Massimo autori per progetto per cui generare il riassunto AI del daily
  // report: oltre questo numero si producono solo i dati grezzi (niente run
  // AI per autore) per contenere costo e durata. Default 25.
  DAILY_REPORT_MAX_AUTHORS_PER_PROJECT: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 (es. 25)" })
      .int("deve essere un intero ≥ 1 (es. 25)")
      .min(1, "deve essere un intero ≥ 1 (es. 25)")
      .default(25),
  ),
  // Giorni di retention dei report di attività: la pulizia elimina i report più
  // vecchi di questo limite. Default 90.
  DAILY_REPORT_RETENTION_DAYS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 1 in giorni (es. 90)" })
      .int("deve essere un intero ≥ 1 in giorni (es. 90)")
      .min(1, "deve essere un intero ≥ 1 in giorni (es. 90)")
      .default(90),
  ),
  // Soglia di similarità (0–1) sopra cui, all'intake del backlog di discovery, un
  // nuovo feedback si FONDE automaticamente in una voce esistente (dedup). Alta
  // per default (0.90): si fondono solo i quasi-duplicati. Da tarare sul campo.
  BACKLOG_MERGE_THRESHOLD: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un numero tra 0 e 1 (es. 0.9)" })
      .min(0, "deve essere un numero tra 0 e 1 (es. 0.9)")
      .max(1, "deve essere un numero tra 0 e 1 (es. 0.9)")
      .default(0.9),
  ),
  // Soglia di similarità (0–1) sopra cui una NUOVA voce del backlog segnala
  // "simile a X" (zona grigia: sotto la merge ma sopra questa → badge + fusione
  // manuale possibile). Deve restare ≤ BACKLOG_MERGE_THRESHOLD (verificato sotto).
  // Default 0.78. Da tarare sul campo.
  BACKLOG_SIMILAR_THRESHOLD: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un numero tra 0 e 1 (es. 0.78)" })
      .min(0, "deve essere un numero tra 0 e 1 (es. 0.78)")
      .max(1, "deve essere un numero tra 0 e 1 (es. 0.78)")
      .default(0.78),
  ),
  // Intervallo di poll (secondi) del poller del backlog di discovery (task
  // separato dal loop dei job): reclama i job `backlog_jobs` queued (intake e
  // deep dive) e li esegue nella CATENA PER-PROGETTO (serializer condiviso).
  // È BEST-EFFORT e non tocca i timeout dei job. 0 = disabilitato. Default 20".
  BACKLOG_POLL_SECONDS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero ≥ 0 in secondi (es. 20; 0 = disabilitato)" })
      .int("deve essere un intero ≥ 0 in secondi (es. 20; 0 = disabilitato)")
      .min(0, "deve essere un intero ≥ 0 in secondi (es. 20; 0 = disabilitato)")
      .default(20),
  ),
  // Modello dell'agente del backlog (intake + deep dive). Economico per default
  // ("sonnet", come PR_REVIEW_MODEL): l'intake è testo, il deep dive è analisi.
  BACKLOG_MODEL: z.preprocess(
    emptyAsUndefined,
    z
      .string({ error: "deve essere il nome di un modello (es. sonnet)" })
      .min(1)
      .default("sonnet"),
  ),
  // Timeout (ms) di ogni run dell'agente del backlog (intake e deep dive).
  // Default 900000 = 15', come il run di review: un run appeso fallisce lì e il
  // job del backlog viene riaccodato/fallito dal poller.
  // NOTA staleness: il recovery degli orfani del poller (BACKLOG_STALE_MINUTES,
  // 15') riaccoda i `running` con startedAt oltre soglia — e startedAt parte al
  // CLAIM, PRIMA dell'eventuale attesa nella catena del serializer, quindi un job
  // vivo può legittimamente superarla (attesa + run fino a questo timeout). È
  // sicuro SOLO per l'invariante SINGLE-PROCESS del poller: i tick non si
  // sovrappongono (guard `running` in startBacklogPoller) e il recovery gira a
  // inizio tick, quando nessun job è in volo — un `running` stantio è quindi
  // sempre di un worker morto, mai vivo. Se il poller diventasse multi-processo
  // servirebbe un heartbeat (pattern pr_reviews.lastActivityAt).
  BACKLOG_AGENT_TIMEOUT_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce
      .number({ error: "deve essere un intero > 0 in millisecondi (es. 900000)" })
      .int("deve essere un intero > 0 in millisecondi (es. 900000)")
      .min(1, "deve essere un intero > 0 in millisecondi (es. 900000)")
      .default(900_000),
  ),
}).refine(
  (env) => env.BACKLOG_SIMILAR_THRESHOLD <= env.BACKLOG_MERGE_THRESHOLD,
  {
    error:
      "BACKLOG_SIMILAR_THRESHOLD deve essere ≤ BACKLOG_MERGE_THRESHOLD (la zona grigia 'simile a X' sta SOTTO la soglia di merge)",
    path: ["BACKLOG_SIMILAR_THRESHOLD"],
  },
);

export interface WorkerConfig {
  databaseUrl: string;
  /** Chiave AES-256 già decodificata: pronta per decrypt(). */
  encryptionKey: Buffer;
  mirrorsDir: string;
  /** Job in volo contemporanei (su progetti DIVERSI: quelli dello stesso
   * progetto vengono comunque serializzati dall'handler). */
  concurrency: number;
  /** Dimensione del pool di connessioni Postgres (default 10). Va alzato in
   * proporzione a concurrency: i job concorrenti si contendono le connessioni. */
  databasePoolMax: number;
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
  /** Tetto alle pagine PRODUCT create dalla fase product PER VERTICALE/superficie (Fase B;
   * ogni verticale riparte col suo budget; separato da docMaxNodes; default 12; 0 = spenta). */
  docProductMaxPages: number;
  /** Endpoint /v1 OpenAI-compatibile per gli embedding dei Docs
   * (default "http://ollama:11434/v1"). */
  embeddingBaseUrl: string;
  /** Modello di embedding (default "bge-m3"). */
  embeddingModel: string;
  /** Chiave API dell'endpoint di embedding; undefined se non richiesta. */
  embeddingApiKey: string | undefined;
  /** Intervallo in secondi del poller di auto-aggiornamento Docs (default 60; 0 =
   * disabilitato). */
  docsAutoUpdatePollSeconds: number;
  /** Tetto alle pagine rigenerate in-place per push dall'auto-update (Fase 2; default
   * 10; 0 = solo la entry release, niente rigenerazione mirata). */
  docsAutoUpdateMaxPages: number;
  /** Tetto alle pagine NUOVE create per push per le aree non documentate (Fase 3;
   * default 5; 0 = niente creazione incrementale). */
  docsAutoUpdateMaxNewPages: number;
  /** Intervallo in secondi del poller dell'automazione PR Review (default 60;
   * 0 = disabilitato). */
  prReviewPollSeconds: number;
  /** Modello dell'agente di PR Review, read-only in plan mode (default "sonnet"). */
  prReviewModel: string;
  /** Turni massimi del run di review (default 50). */
  prReviewMaxTurns: number;
  /** Timeout del run di review in ms (da PR_REVIEW_TIMEOUT_MINUTES, default
   * 15' = 900000). Deve restare sotto staleAfterMinutes (vedi config sopra). */
  prReviewTimeoutMs: number;
  /** Intervallo in minuti del resume poller dei limiti provider (default 5;
   * 0 = disabilitato). */
  limitResumePollMinutes: number;
  /** Soglia di headroom (% di sessione usata) sotto cui una credenziale
   * `account` è di nuovo utilizzabile (default 95). */
  limitResumeHeadroomPercent: number;
  /** Cooldown del fallback a tempo del resume poller in ms (da
   * LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES, default 60' = 3600000). */
  limitResumeCooldownMs: number;
  /** Intervallo in minuti del poller di rollup + retention delle metriche di
   * monitoraggio (default 5; 0 = disabilitato). */
  monitorRollupIntervalMinutes: number;
  /** Intervallo in minuti del poller di valutazione alert del monitoraggio
   * (default 1; 0 = disabilitato). */
  monitorAlertIntervalMinutes: number;
  /** Intervallo in minuti del poller del daily activity report (default 15;
   * 0 = disabilitato). */
  dailyReportPollMinutes: number;
  /** @deprecated Non più usato dal modello per-commit (descrizione per OGNI
   * commit non-merge, senza cap per-autore). Lasciato per non rompere la config.
   * Massimo autori per progetto per cui generare il riassunto AI notturno
   * (default 25). */
  dailyReportMaxAuthorsPerProject: number;
  /** Giorni di retention dei report di attività prima della pulizia (default 90). */
  dailyReportRetentionDays: number;
  /** Soglia di similarità (0–1) sopra cui l'intake del backlog fonde in una voce
   * esistente (default 0.90). */
  backlogMergeThreshold: number;
  /** Soglia di similarità (0–1) sopra cui una nuova voce del backlog segnala
   * "simile a X" (default 0.78; ≤ backlogMergeThreshold). */
  backlogSimilarThreshold: number;
  /** Intervallo in secondi del poller del backlog di discovery (default 20;
   * 0 = disabilitato). */
  backlogPollSeconds: number;
  /** Modello dell'agente del backlog, intake + deep dive (default "sonnet"). */
  backlogModel: string;
  /** Timeout (ms) di ogni run dell'agente del backlog (default 900000 = 15'). */
  backlogAgentTimeoutMs: number;
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
    databasePoolMax: parsed.DATABASE_POOL_MAX,
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
    docAgentTimeoutMs: parsed.DOC_AGENT_TIMEOUT_MS,
    docModuleMaxTurns: parsed.DOC_MODULE_MAX_TURNS,
    docMaxDepth: parsed.DOC_MAX_DEPTH,
    docMaxNodes: parsed.DOC_MAX_NODES,
    docProductMaxPages: parsed.DOC_PRODUCT_MAX_PAGES,
    embeddingBaseUrl: parsed.EMBEDDING_BASE_URL,
    embeddingModel: parsed.EMBEDDING_MODEL,
    embeddingApiKey: parsed.EMBEDDING_API_KEY,
    docsAutoUpdatePollSeconds: parsed.DOCS_AUTOUPDATE_POLL_SECONDS,
    docsAutoUpdateMaxPages: parsed.DOCS_AUTOUPDATE_MAX_PAGES,
    docsAutoUpdateMaxNewPages: parsed.DOCS_AUTOUPDATE_MAX_NEW_PAGES,
    prReviewPollSeconds: parsed.PR_REVIEW_POLL_SECONDS,
    prReviewModel: parsed.PR_REVIEW_MODEL,
    prReviewMaxTurns: parsed.PR_REVIEW_MAX_TURNS,
    // Minuti → ms: il runner dell'agente vuole millisecondi.
    prReviewTimeoutMs: parsed.PR_REVIEW_TIMEOUT_MINUTES * 60_000,
    limitResumePollMinutes: parsed.LIMIT_RESUME_POLL_MINUTES,
    limitResumeHeadroomPercent: parsed.LIMIT_RESUME_HEADROOM_PERCENT,
    // Minuti → ms: il poller confronta età della pausa in millisecondi.
    limitResumeCooldownMs: parsed.LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES * 60_000,
    monitorRollupIntervalMinutes: parsed.MONITOR_ROLLUP_INTERVAL_MINUTES,
    monitorAlertIntervalMinutes: parsed.MONITOR_ALERT_INTERVAL_MINUTES,
    dailyReportPollMinutes: parsed.DAILY_REPORT_POLL_MINUTES,
    dailyReportMaxAuthorsPerProject: parsed.DAILY_REPORT_MAX_AUTHORS_PER_PROJECT,
    dailyReportRetentionDays: parsed.DAILY_REPORT_RETENTION_DAYS,
    backlogMergeThreshold: parsed.BACKLOG_MERGE_THRESHOLD,
    backlogSimilarThreshold: parsed.BACKLOG_SIMILAR_THRESHOLD,
    backlogPollSeconds: parsed.BACKLOG_POLL_SECONDS,
    backlogModel: parsed.BACKLOG_MODEL,
    backlogAgentTimeoutMs: parsed.BACKLOG_AGENT_TIMEOUT_MS,
  };
}
