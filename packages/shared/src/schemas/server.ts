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
// Schemi admin (superficie interna /api/servers)
// ---------------------------------------------------------------------------

/** Registrazione di un nuovo server: l'utente fornisce solo il nome. */
export const createServerSchema = z.object({
  name: z.string().min(1).max(255),
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
