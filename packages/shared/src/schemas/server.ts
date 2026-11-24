import { z } from "zod";

// ---------------------------------------------------------------------------
// Enum di base
// ---------------------------------------------------------------------------

export const checkTypeSchema = z.enum(["http", "tcp", "process", "postgres", "mysql"]);
export type CheckType = z.infer<typeof checkTypeSchema>;

export const checkStatusSchema = z.enum(["up", "down", "unknown"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const serverStatusSchema = z.enum(["online", "offline", "never_connected"]);
export type ServerStatus = z.infer<typeof serverStatusSchema>;

/**
 * Determina lo stato di un server dal suo ultimo heartbeat. Unica fonte della
 * regola, condivisa da API (/api/servers), worker (evaluator alert) e UI:
 * `never_connected` se non ha mai fatto ingest; `offline` se l'ultimo campione
 * è più vecchio di 3× l'intervallo di campionamento (margine per un ciclo perso
 * senza allarmare); altrimenti `online`.
 */
export function computeServerStatus(
  lastSeenAt: Date | null,
  sampleIntervalSeconds: number,
  now: Date,
): ServerStatus {
  if (!lastSeenAt) return "never_connected";
  const offlineThresholdMs = 3 * sampleIntervalSeconds * 1000;
  return now.getTime() - lastSeenAt.getTime() > offlineThresholdMs ? "offline" : "online";
}

export const serviceSourceSchema = z.enum(["docker", "pm2", "pm2_fallback"]);
export type ServiceSource = z.infer<typeof serviceSourceSchema>;

// ---------------------------------------------------------------------------
// Intervalli (riusati tra config agente e schemi admin)
// ---------------------------------------------------------------------------

/** Intervallo di esecuzione di un check, in secondi (10s–1h). */
export const checkIntervalSecondsSchema = z.number().int().min(10).max(3600);

/** Intervallo di campionamento delle metriche host, in secondi (10s–5m). */
export const sampleIntervalSecondsSchema = z.number().int().min(10).max(300);

// ---------------------------------------------------------------------------
// Payload di ingest (agente → server, superficie pubblica /monitor)
// ---------------------------------------------------------------------------

/**
 * Un servizio scoperto sull'host dall'agente (container Docker o processo PM2).
 * `cpuPct`/`memBytes` sono null quando la source non li espone; `restarts` è
 * valorizzato solo da PM2 (null per Docker).
 */
export const discoveredServiceSchema = z.object({
  source: serviceSourceSchema,
  name: z.string().min(1).max(200),
  state: z.string().max(50), // "running", "exited", "online", "errored"…
  cpuPct: z.number().min(0).nullable(),
  memBytes: z.number().int().min(0).nullable(),
  restarts: z.number().int().min(0).nullable(), // solo PM2
  /**
   * Fase 8, Task 4: `Image` del container Docker (es. `acme/web:1.2.3`),
   * dalla stessa risposta `/containers/json` che il collector legge già —
   * non un permesso in più. `.optional()`: solo Docker la porta (mai PM2), e
   * un agente vecchio che non la manda deve continuare a funzionare (l'app
   * non c'entra qui, ma gli host NON si auto-aggiornano — CLAUDE.md — quindi
   * la stessa regola vale per il server verso un agente più vecchio).
   */
  image: z.string().max(500).optional(),
  /**
   * Fase 8, Task 4: label OCI `org.opencontainers.image.revision` del
   * container, quando il buildchain del cliente la imposta — tipicamente lo
   * sha del commit rilasciato. `.optional()`: molte immagini non la portano.
   */
  commitSha: z.string().max(100).optional(),
});
export type DiscoveredService = z.infer<typeof discoveredServiceSchema>;

/**
 * Un campione di metriche host a un istante `ts` (ISO, UTC, generato
 * dall'agente). `netRxBytes`/`netTxBytes` sono DELTA nell'intervallo, non
 * contatori cumulativi.
 */
export const metricSampleSchema = z.object({
  ts: z.iso.datetime(), // ISO, UTC, generato dall'agente
  cpuPct: z.number().min(0).max(100),
  load1m: z.number().min(0),
  memUsedBytes: z.number().int().min(0),
  memTotalBytes: z.number().int().min(1),
  swapUsedBytes: z.number().int().min(0),
  diskUsedBytes: z.number().int().min(0),
  diskTotalBytes: z.number().int().min(1),
  disks: z
    .array(
      z.object({
        mount: z.string().min(1).max(500),
        usedBytes: z.number().int().min(0),
        totalBytes: z.number().int().min(1),
      }),
    )
    .max(20)
    .default([]),
  netRxBytes: z.number().int().min(0), // DELTA nell'intervallo, non contatore
  netTxBytes: z.number().int().min(0),
  services: z.array(discoveredServiceSchema).max(200).default([]),
});
export type MetricSample = z.infer<typeof metricSampleSchema>;

/**
 * Esito di un check periodico (HTTP/TCP/process/DB). `metrics` porta le
 * metriche specifiche del check (es. connessioni DB, cpu/mem del processo);
 * null quando il check non ne produce.
 */
export const checkResultSchema = z.object({
  checkId: z.uuid(),
  ts: z.iso.datetime(),
  status: checkStatusSchema,
  latencyMs: z.number().int().min(0).nullable(),
  error: z.string().max(500).nullable(),
  metrics: z.record(z.string().max(100), z.number()).nullable(), // metriche DB / cpu-mem process
});
export type CheckResult = z.infer<typeof checkResultSchema>;

/**
 * Corpo della richiesta di ingest: un batch di campioni (buffer 2h @30s ≈ 240,
 * cap 300) più gli esiti dei check accumulati dall'agente.
 */
export const ingestBodySchema = z.object({
  hostname: z.string().min(1).max(255),
  agentVersion: z.string().min(1).max(50),
  samples: z.array(metricSampleSchema).min(1).max(300), // buffer 2h @30s ≈ 240
  checkResults: z.array(checkResultSchema).max(2000).default([]),
  /**
   * Area 8, F4b: ciò che l'agente dichiara (le operazioni accese). Facoltativo:
   * un agente vecchio non lo manda, e vale «spente». Una dichiarazione, non un
   * permesso: senza la firma del server l'agente non esegue niente comunque.
   */
  capabilities: z.object({ operations: z.boolean().default(false) }).optional(),
});
export type IngestBody = z.infer<typeof ingestBodySchema>;

// ---------------------------------------------------------------------------
// Config restituita all'agente (server → agente)
// ---------------------------------------------------------------------------

/**
 * Un check nella config dell'agente. `target` è già in chiaro (i DSN dei check
 * DB vengono decifrati dal server prima di consegnare la config).
 */
export const agentCheckConfigSchema = z.object({
  id: z.uuid(),
  type: checkTypeSchema,
  name: z.string().min(1).max(200),
  target: z.string().min(1), // URL / host:porta / pattern / DSN (decifrato)
  intervalSeconds: checkIntervalSecondsSchema,
});
export type AgentCheckConfig = z.infer<typeof agentCheckConfigSchema>;

export const agentConfigSchema = z.object({
  sampleIntervalSeconds: sampleIntervalSecondsSchema,
  checks: z.array(agentCheckConfigSchema),
  /**
   * Area 8, F4b: l'id del server, che l'agente fissa alla prima config e
   * confronta con quello di ogni comando firmato. Facoltativo: un server
   * vecchio non lo manda (e allora l'agente non esegue comandi).
   */
  serverId: z.uuid().optional(),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ---------------------------------------------------------------------------
// Soglie di alert (per-server, persistite come jsonb)
// ---------------------------------------------------------------------------

/**
 * Soglie di alert per-server. Una soglia null disattiva l'alert relativo;
 * `sustainedMinutes` è la durata di superamento continuo prima di scattare.
 */
export const alertThresholdsSchema = z.object({
  cpuPct: z.number().min(1).max(100).nullable().default(95),
  memPct: z.number().min(1).max(100).nullable().default(90),
  diskPct: z.number().min(1).max(100).nullable().default(90),
  sustainedMinutes: z.number().int().min(1).max(60).default(5),
});
export type AlertThresholds = z.infer<typeof alertThresholdsSchema>;

// ---------------------------------------------------------------------------
// Proiezioni di LETTURA (superficie interna /api/servers → SPA e app mobile)
// ---------------------------------------------------------------------------

/**
 * ⚠️ PERCHÉ STANNO QUI E NON NELLA ROTTA (23 set 2026, hub di progetto,
 * tappa 3). Fino a questa data `serverViewSchema` e `serverDetailSchema`
 * erano dichiarati dentro `apps/server/src/routes/servers.ts`, e il web ne
 * teneva una TERZA copia scritta a mano in `lib/api.ts`. L'app mobile PARSA
 * davvero le risposte (`readerSchema(schema).parse`), quindi senza lo schema
 * in un package condiviso non poteva leggere questa rotta affatto.
 *
 * Lo spostamento NON ha cambiato nessuna forma: stesse chiavi, stessi tipi,
 * stessi nullable. È la condizione che lo rende sicuro verso un'app che si
 * aggiorna dagli store — e la prova è che i test di `servers.test.ts` sono
 * rimasti verdi senza essere toccati.
 *
 * Verso l'app valgono da qui in avanti le regole di sempre: un campo NUOVO
 * nasce `.default()`/`.optional()`/`.nullable()`, mai obbligatorio; nessun
 * campo si rimuove né si rinomina.
 */

/** Progetto associato a un server, ridotto ai campi che servono alla UI (id + nome). */
export const serverProjectSummarySchema = z.object({ id: z.uuid(), name: z.string() });
export type ServerProjectSummary = z.infer<typeof serverProjectSummarySchema>;

/**
 * Area 8, F4a: perché un server è in difficoltà. `kind` è testo (cpu, memory,
 * disk, check, agent_silent…) e gli altri campi sono facoltativi: un motivo
 * nuovo di un server più nuovo non fa crollare il parse.
 */
export const serverEpisodeReasonSchema = z.object({
  kind: z.string(),
  valuePct: z.number().optional(),
  thresholdPct: z.number().optional(),
  checkId: z.string().optional(),
  since: z.string().optional(),
});

/** Area 8, F4a: un episodio, dall'allarme al rientro; un secondo allarme durante si aggiunge ai motivi. */
export const serverEpisodeSchema = z.object({
  id: z.uuid(),
  severity: z.enum(["trouble", "down"]),
  reasons: z.array(serverEpisodeReasonSchema),
  startedAt: z.string(),
  /** null = ancora aperto. */
  recoveredAt: z.string().nullable(),
});
export type ServerEpisodeView = z.infer<typeof serverEpisodeSchema>;

/** Area 8, F4a: la salute in una parola (`serverHealth` di shared, calcolata dal server). */
export const serverHealthSchema = z.object({
  health: z.enum(["healthy", "trouble", "down", "recovered", "never_connected"]),
  since: z.string().nullable(),
  reasons: z.array(serverEpisodeReasonSchema),
});

/** Area 8, F4a: un ambiente che usa il server (per repository), solo dei progetti che chi guarda vede. */
export const serverEnvironmentRefSchema = z.object({
  projectId: z.uuid(),
  projectCode: z.string(),
  environmentId: z.uuid(),
  name: z.string(),
  kind: z.enum(["test", "staging", "production"]),
  repositoryId: z.uuid(),
  repositoryName: z.string(),
});
export type ServerEnvironmentRef = z.infer<typeof serverEnvironmentRefSchema>;

/**
 * Proiezione pubblica di un server: dati anagrafici, stato calcolato,
 * progetti associati, conteggi check e la coda di CPU recente per la
 * sparkline. NON contiene MAI `keyHash` né la chiave in chiaro (quella si
 * mostra solo alla creazione e alla rigenerazione, in uno schema dedicato che
 * resta nella rotta: nessun client che parsa la legge).
 */
/**
 * ⌘K (rimandi, lotto 5): un server trovato per codice (`SRV-2`), nome o
 * hostname, fra quelli che chi cerca vede — la forma del prototipo
 * (`ServerSearchResult` di `data/servers/reads.ts`). `projectCode` è il
 * progetto da cui aprirlo: il primo visibile (per codice) fra i suoi
 * ambienti; null senza un ambiente visibile (un server visto con
 * `monitor.view`): il client apre la pagina d'istanza del server (review del
 * lotto 5, M-7).
 */
export const serverSearchResultSchema = z.object({
  code: z.string(),
  name: z.string(),
  projectCode: z.string().nullable(),
});
export type ServerSearchResult = z.infer<typeof serverSearchResultSchema>;

export const serverViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Hostname dichiarato dall'agente al primo ingest; null se mai connesso. */
  hostname: z.string().nullable(),
  status: serverStatusSchema,
  sampleIntervalSeconds: z.number().int(),
  /** Versione dell'agente all'ultimo ingest; null se mai connesso. */
  agentVersion: z.string().nullable(),
  alertThresholds: alertThresholdsSchema,
  /** ISO dell'ultimo heartbeat; null se il server non ha mai inviato campioni. */
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  projects: z.array(serverProjectSummarySchema),
  checksUp: z.number().int(),
  checksDown: z.number().int(),
  /** Ultimi valori di CPU dai campioni fini, dal più vecchio al più recente. */
  recentCpu: z.array(z.number()),
  // --- Area 8, F4a: campi additivi (default per un server più vecchio). ---
  /** `SRV-<n>`, d'istanza, mai riusato. */
  code: z.string().nullable().default(null),
  health: serverHealthSchema.nullable().default(null),
  /** Gli ambienti che lo usano (la visibilità passa da qui). */
  environments: z.array(serverEnvironmentRefSchema).default([]),
  /** Il lavoro di Claude sul server: nella F4a sempre `none` (analisi e correzione sono F4b). */
  work: z.enum(["none", "analyzing", "diagnosis_ready", "fixing"]).default("none"),
  /** Nessun ambiente di nessun progetto lo usa (vale anche per chi non vede quei progetti). */
  orphan: z.boolean().default(false),
  /** Lo usano solo ambienti di progetti archiviati. */
  inArchivedOnly: z.boolean().default(false),
  // --- Area 8, F4b: additivi. ---
  /** L'agente dichiara le operazioni accese (una dichiarazione, non un permesso). */
  agentOperations: z.boolean().default(false),
});
export type ServerView = z.infer<typeof serverViewSchema>;

/** Uso di un disco per punto di mount (dettaglio server, ultimo campione). */
export const serverDiskSchema = z.object({
  mount: z.string(),
  usedBytes: z.number(),
  totalBytes: z.number(),
});
export type ServerDisk = z.infer<typeof serverDiskSchema>;

/** Un controllo come lo vede chi legge il server: mai il DSN (solo `hasDsn`). */
export const serverCheckViewSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid(),
  type: checkTypeSchema,
  name: z.string(),
  target: z.string(),
  hasDsn: z.boolean(),
  intervalSeconds: z.number().int(),
  enabled: z.boolean(),
  lastStatus: checkStatusSchema,
  lastCheckedAt: z.string().nullable(),
  lastLatencyMs: z.number().int().nullable(),
  lastError: z.string().nullable(),
  downSince: z.string().nullable(),
  createdAt: z.string(),
});
export type ServerCheckView = z.infer<typeof serverCheckViewSchema>;

/**
 * Dettaglio (solo GET /:id, non la lista): aggiunge lo snapshot corrente
 * dall'ULTIMO campione di server_metrics — servizi auto-scoperti
 * (docker/pm2), dischi per mount e il ts del campione (`metricsAt`, per
 * marcare in UI i dati stantii). Vuoti/null se il server non ha mai inviato
 * campioni.
 */
export const serverDetailSchema = serverViewSchema.extend({
  services: z.array(discoveredServiceSchema),
  disks: z.array(serverDiskSchema),
  metricsAt: z.string().nullable(),
  /**
   * Memoria dell'ULTIMO campione (23 set 2026, hub di progetto, tappa 3):
   * letta nella stessa query di `services`/`disks`/`metricsAt`, nessun join
   * nuovo. È un campo AGGIUNTO alla risposta, non spostato.
   *
   * `.nullable().default(null)`, mai obbligatori: un'app nuova che parla con
   * un server più vecchio — un rollback, un'istanza self-hosted non
   * aggiornata — non li riceve, e senza il default il parse dell'intero
   * dettaglio fallirebbe. `null` ha quindi DUE significati, che chi legge
   * tiene distinti: nessun campione mai ricevuto (`metricsAt` è null anche
   * lui), oppure server che il campo non lo manda. In nessuno dei due casi
   * vuol dire «0».
   *
   * ⚠️ Il web NON parsa (fa un cast): se un giorno li leggesse, `?? null` nel
   * punto di lettura.
   */
  memUsedBytes: z.number().nullable().default(null),
  memTotalBytes: z.number().nullable().default(null),
  // --- Area 8, F4a: campi additivi. ---
  // Senza `z.lazy` (readerSchema non lo attraversa): lo schema è definito sopra.
  checks: z.array(serverCheckViewSchema).default([]),
  /** Dal più recente, al più 20. */
  episodes: z.array(serverEpisodeSchema).default([]),
  /** Le produzioni che lo usano, dei progetti visibili. */
  productionProjects: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string() })).default([]),
  /** `monitor.manage`, calcolato dal server. */
  canManage: z.boolean().default(false),
  /**
   * Area 8, F4b: chi guarda può chiedere un'analisi a mano (`servers.operate`
   * in un progetto il cui ambiente usa il server) e nessuna è in corso.
   * Calcolato dal server. Additivo.
   */
  canStartAnalysis: z.boolean().default(false),
  /**
   * Area 8, F4b: lo STATO dell'accesso SSH di sola lettura, per chi vede il
   * server (senza chiavi, comandi né esito della verifica: quelli restano a
   * `servers.ssh.manage`, `GET /api/servers/:id/ssh`). Additivo.
   */
  ssh: z
    .object({ status: z.enum(["none", "pending", "verified", "failed", "revoked"]), usable: z.boolean() })
    .default({ status: "none", usable: false }),
});
export type ServerDetail = z.infer<typeof serverDetailSchema>;

// ---------------------------------------------------------------------------
// Schemi admin (superficie interna /api/servers)
// ---------------------------------------------------------------------------

/**
 * Registrazione di un nuovo server: il nome e, facoltativo (area 8, F4a), un
 * ambiente a cui collegarlo per le repository date, nella stessa transazione
 * (`environments.manage` in quel progetto).
 */
export const createServerSchema = z.object({
  name: z.string().min(1).max(255),
  // `repositoryIds` assente = TUTTE le repository del progetto e l'ambiente
  // intero (`serverId`), come il form degli ambienti.
  environment: z.object({ environmentId: z.uuid(), repositoryIds: z.array(z.uuid()).min(1).optional() }).optional(),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

/**
 * Aggiornamento di un server: patch parziale. `projectIds` sostituisce l'intero
 * insieme di progetti collegati (un server può appartenere a N progetti).
 */
export const updateServerSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  sampleIntervalSeconds: sampleIntervalSecondsSchema.optional(),
  projectIds: z.array(z.uuid()).optional(),
  // ATTENZIONE: full-replacement, non merge. I default interni dello schema
  // valorizzano i campi omessi: mandare `{ cpuPct: 80 }` resetta memPct/diskPct/
  // sustainedMinutes ai default (90/90/5). I client devono mandare l'oggetto
  // completo delle soglie correnti.
  alertThresholds: alertThresholdsSchema.optional(),
});
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

/**
 * Creazione di un check. Per i tipi `postgres`/`mysql`, `target` è la
 * connection string in chiaro in ingresso: verrà cifrata dal server.
 */
export const createCheckSchema = z.object({
  type: checkTypeSchema,
  name: z.string().min(1).max(200),
  target: z.string().min(1),
  intervalSeconds: checkIntervalSecondsSchema,
  enabled: z.boolean(),
});
export type CreateCheckInput = z.infer<typeof createCheckSchema>;

/** Aggiornamento di un check: patch parziale. */
export const updateCheckSchema = z.object({
  type: checkTypeSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  target: z.string().min(1).optional(),
  intervalSeconds: checkIntervalSecondsSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateCheckInput = z.infer<typeof updateCheckSchema>;

/**
 * Area 8, F4a: la risposta di creazione e di rigenerazione — la vista più la
 * chiave in chiaro (UNA volta) e l'URL dell'istanza per il comando
 * d'installazione (`agentInstallCommand`). Mai in un elenco.
 */
export const serverWithKeySchema = serverViewSchema.extend({
  key: z.string(),
  ingestUrl: z.string().nullable().default(null),
});
export type ServerWithKey = z.infer<typeof serverWithKeySchema>;


// --- Le metriche (`GET /api/servers/:id/metrics`) -----------------------------

export const serverRawPointSchema = z.object({
  ts: z.string(),
  cpuPct: z.number(),
  load1m: z.number(),
  memUsedBytes: z.number(),
  memTotalBytes: z.number(),
  swapUsedBytes: z.number(),
  diskUsedBytes: z.number(),
  diskTotalBytes: z.number(),
  netRxBytes: z.number(),
  netTxBytes: z.number(),
});

/** Un punto aggregato (5 min, e dalla F4a 1 h e 4 h): coppie avg/max più le somme di rete. */
export const serverRollupPointSchema = z.object({
  ts: z.string(),
  cpuPctAvg: z.number(),
  cpuPctMax: z.number(),
  load1mAvg: z.number(),
  load1mMax: z.number(),
  memUsedBytesAvg: z.number(),
  memUsedBytesMax: z.number(),
  memTotalBytes: z.number(),
  diskUsedBytesAvg: z.number(),
  diskUsedBytesMax: z.number(),
  diskTotalBytes: z.number(),
  netRxBytesSum: z.number(),
  netTxBytesSum: z.number(),
});

export const serverRawCheckPointSchema = z.object({
  ts: z.string(),
  /**
   * Testo, non l'enum (review F4a): sta in una union (raw | aggregato), e
   * readerSchema non apre un enum dentro una union — uno stato nuovo farebbe
   * fallire il parse delle metriche intere. Chi legge confronta coi valori di
   * `checkStatusSchema`; uno sconosciuto non è né su né giù.
   */
  status: z.string(),
  latencyMs: z.number().int().nullable(),
});

export const serverRollupCheckPointSchema = z.object({
  ts: z.string(),
  upCount: z.number().int(),
  downCount: z.number().int(),
  latencyMsAvg: z.number().nullable(),
  latencyMsMax: z.number().int().nullable(),
});

export const serverMetricsQuerySchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  checkId: z.uuid().optional(),
});

/**
 * `resolution`: `raw` fino a 48 h, `5m` fino a 7 giorni, `1h` fino a 30, `4h`
 * oltre (area 8, F4a: i passi larghi sono valori NUOVI, i client passano dal
 * `readerSchema`). `truncated`: una serie ha saturato il tetto di punti.
 */
export const serverMetricsResponseSchema = z.object({
  resolution: z.enum(["raw", "5m", "1h", "4h"]),
  truncated: z.boolean(),
  points: z.array(z.union([serverRawPointSchema, serverRollupPointSchema])),
  checkPoints: z.array(z.union([serverRawCheckPointSchema, serverRollupCheckPointSchema])).optional(),
});
export type ServerMetricsResponse = z.infer<typeof serverMetricsResponseSchema>;
