# Monitoraggio server — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Agente Docker che spinge metriche host/servizi/DB a Stubwise, con storage time-series su Postgres, alerting via notifiche e sezione Monitor nella SPA.

**Architecture:** Push dall'agente (`packages/agent`, TS bundlato esbuild) verso una superficie pubblica `/monitor/*` sul Fastify esistente (auth chiave per-server hashata sha256, pattern widget); rollup e valutazione alert come poller nel worker (pattern `startLimitResumePoller`); UI TanStack Router/Query + uPlot.

**Tech Stack:** Drizzle/Postgres, Fastify+Zod, undici (docker.sock), pm2 client, postgres-js + mysql2 (check DB), esbuild, uPlot.

**Design di riferimento:** `docs/plans/2026-07-13-server-monitoring-design.md` — LEGGERLO PRIMA. Le decisioni (retention 48h/90g, soglie jsonb, alert solo notifiche, server→N progetti) sono lì e non si ridiscutono.

**Worktree:** `.worktrees/server-monitoring`, branch `feat/server-monitoring`. Baseline typecheck+test verde al commit `875da7b`.

**Convenzioni obbligatorie del repo:**
- TDD: test prima, poi implementazione minima. Commit frequenti (`feat:`/`test:` in italiano, come i commit recenti).
- Test server/db/worker con testcontainers: `startTestDb()` da `@stubwise/db/testing`, teardown `stop()`.
- Route: Zod ovunque, errori business via `apiError(reply, status, code, message)` (`apps/server/src/errors.ts`), 401 indistinguibile sulle superfici pubbliche.
- Prima di ogni commit di fine task: typecheck del package toccato. Prima del merge finale: `pnpm lint && pnpm typecheck && pnpm test` dalla radice (la CI fallisce su lint!).

---

## Fase A — Contratti e schema dati

### Task A1: Schemi Zod condivisi

**Files:**
- Create: `packages/shared/src/schemas/server.ts`
- Create: `packages/shared/src/schemas/server.test.ts`
- Modify: `packages/shared/src/index.ts` (aggiungi `export * from "./schemas/server.js";`)

**Step 1: test fallente** — `server.test.ts` valida: un payload ingest completo passa; `cpuPct` fuori 0-100 fallisce; batch di max 300 campioni; tipo check sconosciuto fallisce.

**Step 2:** `pnpm --filter @stubwise/shared exec vitest run src/schemas/server.test.ts` → FAIL (modulo mancante).

**Step 3: implementazione.** Contenuto di `server.ts` (pattern di `project.ts`: coppie schema+tipo):

```ts
import { z } from "zod";

export const checkTypeSchema = z.enum(["http", "tcp", "process", "postgres", "mysql"]);
export const checkStatusSchema = z.enum(["up", "down", "unknown"]);
export const serverStatusSchema = z.enum(["online", "offline", "never_connected"]);
export const serviceSourceSchema = z.enum(["docker", "pm2", "pm2_fallback"]);

export const discoveredServiceSchema = z.object({
  source: serviceSourceSchema,
  name: z.string().min(1).max(200),
  state: z.string().max(50),            // "running", "exited", "online", "errored"…
  cpuPct: z.number().min(0).nullable(),
  memBytes: z.number().int().min(0).nullable(),
  restarts: z.number().int().min(0).nullable(), // solo PM2
});

export const metricSampleSchema = z.object({
  ts: z.string().datetime(),            // ISO, UTC, generato dall'agente
  cpuPct: z.number().min(0).max(100),
  load1m: z.number().min(0),
  memUsedBytes: z.number().int().min(0),
  memTotalBytes: z.number().int().min(1),
  swapUsedBytes: z.number().int().min(0),
  diskUsedBytes: z.number().int().min(0),
  diskTotalBytes: z.number().int().min(1),
  disks: z.array(z.object({
    mount: z.string(), usedBytes: z.number().int().min(0), totalBytes: z.number().int().min(1),
  })).max(20).default([]),
  netRxBytes: z.number().int().min(0),  // DELTA nell'intervallo, non contatore
  netTxBytes: z.number().int().min(0),
  services: z.array(discoveredServiceSchema).max(200).default([]),
});

export const checkResultSchema = z.object({
  checkId: z.string().uuid(),
  ts: z.string().datetime(),
  status: checkStatusSchema,
  latencyMs: z.number().int().min(0).nullable(),
  error: z.string().max(500).nullable(),
  metrics: z.record(z.string(), z.number()).nullable(), // metriche DB / cpu-mem process
});

export const ingestBodySchema = z.object({
  hostname: z.string().min(1).max(255),
  agentVersion: z.string().max(50),
  samples: z.array(metricSampleSchema).min(1).max(300), // buffer 2h @30s ≈ 240
  checkResults: z.array(checkResultSchema).max(2000).default([]),
});
export type IngestBody = z.infer<typeof ingestBodySchema>;

export const agentCheckConfigSchema = z.object({
  id: z.string().uuid(),
  type: checkTypeSchema,
  name: z.string(),
  target: z.string(),                   // URL / host:porta / pattern / DSN (decifrato)
  intervalSeconds: z.number().int().min(10).max(3600),
});
export const agentConfigSchema = z.object({
  sampleIntervalSeconds: z.number().int().min(10).max(300),
  checks: z.array(agentCheckConfigSchema),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const alertThresholdsSchema = z.object({
  cpuPct: z.number().min(1).max(100).nullable().default(95),
  memPct: z.number().min(1).max(100).nullable().default(90),
  diskPct: z.number().min(1).max(100).nullable().default(90),
  sustainedMinutes: z.number().int().min(1).max(60).default(5),
});
export type AlertThresholds = z.infer<typeof alertThresholdsSchema>;
```

Aggiungi anche gli schemi admin (`createServerSchema` {name}, `updateServerSchema` {name?, sampleIntervalSeconds?, projectIds?, alertThresholds?}, `createCheckSchema` {type,name,target,intervalSeconds,enabled} con `target` che per postgres/mysql è la connection string in chiaro in ingresso, `updateCheckSchema` parziale).

**Step 4:** test PASS. **Step 5:** `git commit -m "feat(shared): schemi zod monitoraggio server"`.

### Task A2: Tabelle Drizzle + migrazione

**Files:**
- Modify: `packages/db/src/schema.ts` (in fondo, dopo il blocco widget)
- Create: `packages/db/src/monitor-schema.test.ts`
- Generated: `packages/db/drizzle/0047_*.sql` (via drizzle-kit)

**Step 1: test fallente** — `monitor-schema.test.ts` (pattern `widget-schema.test.ts`): `startTestDb()`, inserisce un server, la join verso un progetto seedato, un campione metrico, un check, un sample check; verifica unique su `(server_id, ts)` (secondo insert → violazione), FK cascade su delete server.

**Step 2:** `pnpm --filter @stubwise/db exec vitest run src/monitor-schema.test.ts` → FAIL.

**Step 3: implementazione.** Enum via `enumValues` dagli schemi shared (fonte di verità Zod, pattern esistente):

```ts
export const checkType = pgEnum("check_type", enumValues(checkTypeSchema));
export const checkStatus = pgEnum("check_status", enumValues(checkStatusSchema));

export const servers = pgTable("servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  hostname: text("hostname"),
  keyHash: text("key_hash").notNull().unique(),      // sha256 hex della chiave sk_…
  sampleIntervalSeconds: integer("sample_interval_seconds").notNull().default(30),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  agentVersion: text("agent_version"),
  alertThresholds: jsonb("alert_thresholds").$type<AlertThresholds>()
    .notNull().default({ cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 }),
  activeAlerts: jsonb("active_alerts")
    .$type<Record<string, { since: string; notifiedAt: string | null }>>()
    .notNull().default({}),   // chiavi: "offline"|"cpu"|"mem"|"disk" — stato anti-spam
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Nota: NON esiste colonna `status` — si calcola da `lastSeenAt` (offline = più vecchio di 3×intervallo). Lo stato "in allarme offline" vive in `activeAlerts.offline`.

`serverProjects`: join N:M (pattern `ticketRepositories`): `serverId` FK cascade, `projectId` FK cascade, uniqueIndex sulla coppia.

`serverMetrics`: colonne del design (tutti `bigint("…", { mode: "number" })` per i byte, `real` per pct/load), `services` jsonb `$type<DiscoveredService[]>`, `disks` jsonb; `uniqueIndex("server_metrics_server_ts_unique").on(t.serverId, t.ts)` (serve per l'upsert idempotente) + index su `(serverId, ts)` non necessario in più (l'unique fa da indice).

`serverMetricsRollup`: stessa forma con coppie `avg`/`max` (`cpuPctAvg`, `cpuPctMax`, `memUsedBytesAvg`, `memUsedBytesMax`, `diskUsedBytesAvg/Max`, `netRxBytesSum`, `netTxBytesSum`, `load1mAvg/Max`, più `memTotalBytes`/`diskTotalBytes` presi all'ultimo campione), senza jsonb; uniqueIndex `(serverId, ts)`.

`serviceChecks`: `serverId` FK cascade, `type` checkType, `name`, `target` (per http/tcp/process in chiaro; per postgres/mysql VUOTO), `dsnEncrypted` text nullable (connection string cifrata con `encrypt()` di `packages/db/src/secrets.ts`), `intervalSeconds` default 60, `enabled` default true, `lastStatus` checkStatus default `unknown`, `lastCheckedAt`, `lastLatencyMs`, `lastError`, `downSince`, `downNotifiedAt` (anti-spam), `createdAt`.

`checkSamples`: `checkId` FK cascade, `ts`, `status`, `latencyMs`, `metrics` jsonb nullable, uniqueIndex `(checkId, ts)`.
`checkSamplesRollup`: `checkId`, `ts`, `upCount`, `downCount`, `latencyMsAvg`, `latencyMsMax`, uniqueIndex `(checkId, ts)`.

Genera la migrazione: `pnpm --filter @stubwise/db exec drizzle-kit generate` → controlla il SQL generato (0047): enum NUOVI creati e usati nella stessa migrazione = OK (la trappola è solo `ALTER TYPE ADD VALUE`).

**Step 4:** test PASS. **Step 5:** commit `feat(db): tabelle monitoraggio server + migrazione 0047`.

---

## Fase B — API server

### Task B1: Superficie pubblica `/monitor` (ingest + config)

**Files:**
- Create: `apps/server/src/routes/monitor.ts`
- Create: `apps/server/src/routes/monitor.test.ts`
- Modify: `apps/server/src/routes/shared.ts` (aggiungi `generateServerKey` + `hashServerKey`)
- Modify: `apps/server/src/app.ts` (registrazione, vedi Step 3)
- Modify: `Caddyfile:38` (aggiungi `/monitor/*` al matcher `@backend`)

**Step 1: test fallenti** (pattern `widget.test.ts`: `buildApp` con testDb, niente cookie):
- `POST /monitor/ingest` con chiave valida e batch di 2 campioni → 200, righe in `server_metrics`, `last_seen_at`/`hostname`/`agent_version` aggiornati.
- Stesso batch rispedito (retry del buffer) → 200 e NESSUN duplicato (conta righe).
- Chiave sbagliata / assente → 401 identico (`invalid_server_key`).
- `checkResults` per un check esistente → riga in `check_samples` + `last_status`/`last_latency_ms`/`down_since` aggiornati su `service_checks` (down_since si valorizza SOLO alla transizione up→down, non si sovrascrive se già down).
- `GET /monitor/config` → intervallo + check abilitati; per un check `postgres` con `dsnEncrypted`, `target` contiene il DSN DECIFRATO; check `enabled=false` esclusi.

**Step 2:** `pnpm --filter @stubwise/server exec vitest run src/routes/monitor.test.ts` → FAIL.

**Step 3: implementazione.**

In `shared.ts`:
```ts
export function generateServerKey(): string {
  return `sk_${randomBytes(24).toString("hex")}`;
}
export function hashServerKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
```

`monitor.ts` — plugin con auth `preValidation` (variante del pattern widget, ma lookup diretto per hash — niente scan):
```ts
const authenticateServer = async (request, reply) => {
  const provided = request.headers["x-stubwise-server-key"];
  let server: ServerRow | undefined;
  if (typeof provided === "string" && provided.length > 0) {
    [server] = await app.db.select().from(servers)
      .where(eq(servers.keyHash, hashServerKey(provided)));
  }
  if (!server) { await apiError(reply, 401, "invalid_server_key", "Invalid server key"); return; }
  request.monitorServer = server;
};
```
(sha256 del provided + lookup su colonna unique = nessun confronto variabile in tempo; il timing non rivela nulla di utile.)

- CORS: NON serve (l'agente è server-to-server, niente browser). Niente `fastify-cors` qui.
- Rate limit per-route come widget (`keyGenerator` su header chiave, fallback ip), opzione `opts.rateLimit` passata da `app.ts`.
- `POST /ingest`: valida con `ingestBodySchema` (da shared), `schemaErrorFormatter: unprocessableEntityFormatter`; upsert:
```ts
await app.db.insert(serverMetrics).values(rows).onConflictDoNothing({
  target: [serverMetrics.serverId, serverMetrics.ts],
});
```
idem per `check_samples` su `(checkId, ts)` — scarta silenziosamente checkId non appartenenti al server (filtro preventivo con `inArray` sui check del server). Aggiorna `servers.lastSeenAt = new Date()`, hostname, agentVersion. Poi per ogni checkId presente aggiorna lo stato corrente usando il risultato più recente del batch: se `status="down"` e `lastStatus!=="down"` → `downSince = ts`, `downNotifiedAt = null`; se `up` → azzera `downSince`/`downNotifiedAt`.
- `GET /config`: costruisce `AgentConfig`; per i check postgres/mysql `target = decrypt(dsnEncrypted, app.encryptionKey)` (try/catch: se la decifratura fallisce, escludi il check e logga — mai 500 all'agente).

In `app.ts`: import + registrazione accanto a `widgetRoutes` (~riga 405):
```ts
void app.register(monitorRoutes, {
  prefix: "/monitor",
  rateLimit: opts.monitorRateLimit ?? { max: 600, timeWindow: "1 minute" },
});
```
Aggiungi `monitorRateLimit?` a `BuildAppOptions`. Nel Caddyfile: `@backend path /api/* /ingest/* /webhooks/* /widget/* /monitor/*`.

**Step 4:** test PASS. **Step 5:** commit `feat(server): superficie pubblica /monitor (ingest + config agente)`.

### Task B2: CRUD interno `/api/servers`

**Files:**
- Create: `apps/server/src/routes/servers.ts`, `apps/server/src/routes/servers.test.ts`
- Modify: `apps/server/src/app.ts` (`void app.register(serverRoutes, { prefix: "/api/servers" });` dopo repositoryRoutes)

**Step 1: test fallenti** (pattern `projects.test.ts` con `seedUsers`):
- `POST /` (admin) `{name}` → 201 con `key` in chiaro (`sk_…`) UNA volta; in DB c'è solo `key_hash`. Member → 403.
- `GET /` (auth) → lista con stato calcolato (`never_connected` se `lastSeenAt` null; `offline` se `< now - 3×intervallo`; altrimenti `online`), progetti associati, conteggio check up/down. La `key` NON compare mai.
- `PATCH /:id` (admin): name, sampleIntervalSeconds, alertThresholds (validati con `alertThresholdsSchema`), `projectIds` → sincronizza `server_projects` (delete+insert in transazione).
- `POST /:id/regenerate-key` (admin) → nuova chiave in chiaro, hash aggiornato; la vecchia smette di autenticare (verifica su `/monitor/config`).
- `DELETE /:id` (admin) → cascade su metrics/checks (verifica).
- `GET /?projectId=…` → solo i server associati a quel progetto.

**Step 2:** vitest run → FAIL. **Step 3:** implementazione con `requireAuth`/`requireAdmin` in `preHandler`, `authErrorResponses` nelle response, `apiError` per 404. **Step 4:** PASS. **Step 5:** commit `feat(server): CRUD /api/servers con chiave one-shot`.

> Nota: `GET /:id` espone anche `services`/`disks`/`metricsAt` correnti dall'ultimo campione di `server_metrics` (aggiunto in B3-fix; solo dettaglio, non la lista).

### Task B3: CRUD check + metriche per i grafici

**Files:**
- Modify: `apps/server/src/routes/servers.ts` (+ test)

**Step 1: test fallenti:**
- `POST /:id/checks` (admin): per `type=postgres` il body porta `dsn` (stringa); in DB finisce SOLO `dsnEncrypted` (verifica che `decrypt()` restituisca il DSN e che la risposta non lo contenga); per `type=http` finisce in `target`.
- `PUT /:id/checks/:checkId`, `DELETE`, `GET /:id/checks` (lo stato corrente incluso; `dsn` mai restituito, al suo posto `hasDsn: true`).
- `GET /:id/metrics?from&to`: seed di campioni fini (ultima ora) e rollup (7 giorni fa); range 1h → risponde dai fini con `resolution: "raw"`; range 7g → dal rollup con `resolution: "5m"`. Regola: `to - from <= 48h` → fini, altrimenti rollup. Response: array di punti con i campi del range scelto + serie check latenza opzionale (`?checkId=`).

**Step 2:** FAIL. **Step 3:** implementazione (query con `and(eq(serverId), gte(ts, from), lte(ts, to))`, order by ts asc, LIMIT 6000 di sicurezza). **Step 4:** PASS. **Step 5:** commit `feat(server): check CRUD con dsn cifrato e endpoint metriche`.

---

## Fase C — Worker

### Task C1: Eventi di notifica monitor

**Files:**
- Modify: `packages/notifications/src/` — tipi eventi, `dispatch.ts` (mappa kind→toggle), formatter, `sampleEvents` (+ test esistenti come pattern)

**Step 1: test fallente** — `formatEvent("slack", monitorAlertEvent)` produce testo con nome server e condizione; kind `monitor.alert` e `monitor.recovered` rispettano il toggle.

**Step 3:** nuovi tipi:
```ts
export interface MonitorAlertEvent {
  kind: "monitor.alert";
  serverName: string;
  condition: "offline" | "cpu" | "mem" | "disk" | "check_down";
  detail: string;      // es. "disco al 93% (soglia 90%)" o "check api-health down: timeout"
  url: string;         // link alla pagina del server nella SPA
}
export interface MonitorRecoveredEvent { kind: "monitor.recovered"; /* stessi campi */ }
```
Toggle: aggiungi `monitor.alert` / `monitor.recovered` alla mappa kind→colonna toggles (riusa un'unica colonna toggle nuova `monitor` se lo schema notification_settings ha colonne per kind — segui il pattern esistente in dispatch.ts:68; se serve una colonna nuova in `notification_settings`, aggiungila nella migrazione 0048 con default true).

**Step 5:** commit `feat(notifications): eventi monitor.alert e monitor.recovered`.

### Task C2: Job rollup + retention

**Files:**
- Create: `apps/worker/src/monitor/rollup.ts`, `apps/worker/src/monitor/rollup.test.ts`

**Step 1: test fallenti** (testcontainers): seed campioni fini a cavallo delle 48h →
- `rollupMonitorOnce(db, now)`: i campioni più vecchi di 48h vengono aggregati in bucket da 5 min (avg+max corretti su un bucket noto con 3 campioni; net = SUM) e CANCELLATI dai fini; i più recenti restano; rollup >90 giorni cancellati; check_samples idem verso `check_samples_rollup` (upCount/downCount/latency avg-max).
- Idempotenza: seconda chiamata con stesso `now` → nessuna riga nuova (upsert `onConflictDoNothing` sui bucket).

**Step 3:** implementazione SQL-first (una INSERT…SELECT per efficienza):
```ts
// Il cutoff fine va ALLINEATO al confine di bucket (floor sui 5 min), MAI il
// cutoff grezzo now-48h: un cutoff in mezzo a un bucket aggrega il bucket a
// cavallo in modo parziale e il run successivo (on conflict do nothing) cancella
// i campioni restanti senza che contribuiscano → avg/max/somme distorti.
const bucketMs = 300 * 1000;
const cutoff48h = new Date(Math.floor((now.getTime() - 48 * 3600_000) / bucketMs) * bucketMs);
await db.execute(sql`
  insert into server_metrics_rollup (server_id, ts, cpu_pct_avg, cpu_pct_max, …)
  select server_id,
         to_timestamp(floor(extract(epoch from ts) / 300) * 300) as bucket,
         avg(cpu_pct), max(cpu_pct), …, sum(net_rx_bytes), sum(net_tx_bytes),
         max(mem_total_bytes), max(disk_total_bytes)
  from server_metrics where ts < ${cutoff48h}
  group by server_id, bucket
  on conflict (server_id, ts) do nothing`);
await db.delete(serverMetrics).where(lt(serverMetrics.ts, cutoff48h));
await db.delete(serverMetricsRollup).where(lt(serverMetricsRollup.ts, cutoff90d));
```
Poi `startMonitorRollupPoller` fotocopia strutturale di `startLimitResumePoller` (`apps/worker/src/providers/limit-resume-poller.ts:394-439`): guardia `running`, try/catch che NON propaga, `timer.unref()`, stop su AbortSignal, `intervalMinutes <= 0` = disabilitato.

**Step 5:** commit `feat(worker): rollup e retention metriche monitor`.

### Task C3: Job valutazione alert

**Files:**
- Create: `apps/worker/src/monitor/alerts.ts`, `apps/worker/src/monitor/alerts.test.ts`

**Step 1: test fallenti** (testcontainers, `dispatch` iniettato fake che accumula eventi — pattern `apps/worker/src/pipeline/notify.ts`):
- Server con `lastSeenAt` vecchio 3×intervallo → evento `monitor.alert` condition `offline`, `activeAlerts.offline` scritto; seconda valutazione → NESSUN nuovo evento (anti-spam); torna online → `monitor.recovered` e chiave rimossa.
- CPU sopra soglia da `sustainedMinutes` (seed campioni fini) → alert; sopra soglia da MENO di sustainedMinutes → niente (isteresi). Soglia `null` = condizione disattivata.
- Check con `lastStatus=down` e `downNotifiedAt` null → alert `check_down` + `downNotifiedAt` scritto; già notificato → niente; risalita (up con `downNotifiedAt` valorizzato… nota: la risalita azzera i campi nell'ingest, quindi il recovered lo manda l'ingest? NO — semplice: l'evaluator tiene traccia: se `downNotifiedAt` è null E esiste un sample recente up E c'era stato un notified → troppo fragile. Soluzione: l'ingest NON azzera `downNotifiedAt`; l'evaluator: se `lastStatus=up` e `downNotifiedAt` non null → manda recovered e azzera `downNotifiedAt`).
  **Correzione a B1:** nell'ingest, alla transizione down→up azzera SOLO `downSince`, lascia `downNotifiedAt` (lo consuma l'evaluator). Aggiorna il test B1 di conseguenza in questo task.
- `evaluateMonitorAlertsOnce(db, dispatch, now)`: mai lancia (check con dati sporchi → log e continua).

**Step 3:** implementazione: per le soglie sostenute, query sui fini: `select count(*) from server_metrics where server_id=… and ts >= now - sustainedMinutes and cpu_pct > soglia` confrontato col numero di campioni attesi (tolleranza: alert se TUTTI i campioni presenti nel periodo sforano e ce n'è almeno `sustainedMinutes*60/interval*0.5`). mem/disk in percentuale calcolata da used/total. Stato in `servers.activeAlerts` (update jsonb per server). Notifiche via `dispatchNotification` (best-effort, già non-lanciante). `startMonitorAlertPoller` come sopra, default 1 minuto.

**Step 5:** commit `feat(worker): valutazione alert monitor con isteresi e recovery`.

### Task C4: Wiring config + index worker

**Files:**
- Modify: `apps/worker/src/config.ts` (env `MONITOR_ROLLUP_INTERVAL_MINUTES` default 5, `MONITOR_ALERT_INTERVAL_MINUTES` default 1 — pattern `z.preprocess(emptyAsUndefined, z.coerce.number()…)`)
- Modify: `apps/worker/src/index.ts` (avvia i due poller accanto a `startLimitResumePoller`, index.ts:284)
- Modify: `docker-compose.yml` (documenta le env del worker, forma lista)

**Step 1:** test config esistente esteso: env vuota → default; valore invalido → messaggio aggregato. **Step 3:** wiring. **Step 4:** `pnpm --filter @stubwise/worker test` completo verde. **Step 5:** commit `feat(worker): wiring poller monitor + env`.

---

## Fase D — Agente (`packages/agent`)

Package nuovo. Setup: `package.json` (`name: "@stubwise/agent"`, deps: `undici`, `pm2`, `postgres`, `mysql2`, `zod`, `@stubwise/shared` workspace; devDeps `esbuild`, `vitest`, `typescript`), `tsconfig.json` come gli altri package, build: `esbuild src/index.ts --bundle --platform=node --target=node22 --outfile=dist/agent.cjs --format=cjs` + typecheck script. Vitest config standard (niente testcontainers).

**Principio test:** ogni collector legge da una ROOT configurabile (`/host` in prod, directory fixture nei test) e i client esterni (docker, pm2, ingest) sono iniettati — tutto testabile senza Docker/PM2 veri.

### Task D1: Scaffold + parser /proc

**Files:**
- Create: `packages/agent/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/agent/src/collectors/proc.ts`, `proc.test.ts`
- Create: `packages/agent/test/fixtures/proc/{stat,meminfo,loadavg,net-dev}*.txt` (copiare output reali)

**Step 1: test fallenti** su fixture:
- `parseCpu(stat1, stat2)` → pct corretta su valori noti (delta busy/total); secondo campione uguale al primo → 0.
- `parseMeminfo(text)` → `{memUsedBytes, memTotalBytes, swapUsedBytes}` (used = MemTotal − MemAvailable, in byte da kB).
- `parseLoadavg`, `parseNetDev(prev, curr)` → delta rx/tx sommati sulle interfacce NON loopback; contatore che si azzera (riavvio) → delta 0, non negativo.

**Step 3:** implementazione parser puri (string in, oggetti out). **Step 5:** commit `feat(agent): scaffold package + parser /proc`.

### Task D2: Disco, Docker, PM2

**Files:**
- Create: `packages/agent/src/collectors/{disk,docker,pm2}.ts` + test

**Disk:** `collectDisks(rootPath)` usa `statfs` di `node:fs/promises` su `rootPath` (= `/host/root`) + mount extra letti da `/host/proc/mounts` filtrando pseudo-fs (proc, sysfs, tmpfs, overlay, cgroup…) e i mount sotto `/var/lib/docker`. Test: con una directory temporanea → totale >0, used ≤ total.

**Docker:** client con `undici` `Client` su `socketPath` iniettabile:
```ts
const client = new Client("http://localhost", { socketPath });
// GET /containers/json?all=false → lista; per ciascuno GET /containers/:id/stats?stream=false&one-shot=true
```
CPU pct dai delta `cpu_stats` vs `precpu_stats` (formula standard Docker: `(cpuDelta/systemDelta)*onlineCpus*100`), mem da `memory_stats.usage`. Test: server HTTP fake su unix socket temporaneo (undici lo permette) con risposte JSON registrate → `DiscoveredService[]` con `source: "docker"`. Errore socket → ritorna `[]` e segnala (mai throw).

**PM2:** `collectPm2({ pm2Home, procRoot })`: prova `pm2` lib (`PM2_HOME` puntato al mount, `pm2.connect` con timeout 3s → `pm2.list` → map a `DiscoveredService` con `source: "pm2"`, restarts da `pm2_env.restart_time`); su QUALSIASI errore/timeout → fallback: scan `procRoot` per processi con `PM2` nella cmdline del parent (God Daemon) → figli con nome/cpu/rss da `/proc/<pid>/stat` e `status`, `source: "pm2_fallback"`, restarts null. Test: solo il fallback su fixture proc finte + un test che verifica che l'errore della lib non propaga (mock del modulo pm2 che lancia).

**Step 5:** commit `feat(agent): collector disco, docker e pm2 con fallback`.

### Task D3: Esecutori check

**Files:**
- Create: `packages/agent/src/checks/run.ts` + test

**Step 1: test fallenti:**
- `http`: server locale che risponde 200 → up con latenza; 500 → down `http_500`; timeout (server che non risponde) → down `timeout`. Timeout 10s (nei test: 200ms iniettabile).
- `tcp`: porta aperta (net.createServer) → up; porta chiusa → down.
- `process`: match su cmdline nelle fixture proc → up + `{cpuPct, memBytes}` in metrics; nessun match → down.
- `postgres`: con `postgres` (postgres-js) su un DSN NON raggiungibile → down senza throw. Il ramo felice (query `pg_stat_database`: `numbackends`, delta `xact_commit` fra due run → `tps`, `blks_hit/(blks_hit+blks_read)` → `cacheHitRatio`, `pg_database_size` → `dbSizeBytes`) si testa in D5 contro il testcontainer già in casa. `mysql2`: `SHOW GLOBAL STATUS` (Threads_connected, delta Questions, dimensioni da information_schema) — solo ramo errore nei test unit.

**Step 3:** `runCheck(config, ctx): Promise<CheckResult>` — MAI throw, sempre un risultato con status/error. Lo stato per i delta DB (valori precedenti per TPS) vive in una Map in memoria del modulo chiamante.

**Step 5:** commit `feat(agent): esecutori check http/tcp/process/db`.

### Task D4: Loop principale + buffer + client ingest

**Files:**
- Create: `packages/agent/src/{main.ts,ingest-client.ts,buffer.ts,config.ts,index.ts}` + test

**Step 1: test fallenti:**
- `RingBuffer(maxSamples)`: push oltre il limite → scarta i più vecchi.
- `IngestClient` contro un Fastify/`http.createServer` di test: POST con header `x-stubwise-server-key`; risposta 500/rete giù → i campioni restano nel buffer; risposta 200 → buffer svuotato; al recupero manda TUTTO il buffer in un batch (max 300 per request, spezzato).
- `fetchConfig` → parse con `agentConfigSchema`; risposta invalida → mantiene la config precedente.
- `mainLoop` con clock/collectors iniettati (fake timers vitest): a ogni tick raccoglie, accoda, invia; ogni 10 tick rilegge la config; i check girano sul PROPRIO `intervalSeconds` (scheduler semplice: `nextRunAt` per check).

**Step 3:** `index.ts` legge env `STUBWISE_URL`, `STUBWISE_SERVER_KEY` (obbligatorie, exit 1 con messaggio se mancano), `HOST_ROOT=/host`, `PM2_HOME=/host/pm2`, `DOCKER_SOCKET=/var/run/docker.sock`, `AGENT_VERSION` (iniettata al build). Graceful shutdown su SIGTERM (flush finale best-effort).

**Step 5:** commit `feat(agent): loop principale con buffer e retry`.

### Task D5: Test d'integrazione agente↔server + Dockerfile.agent

**Files:**
- Create: `packages/agent/src/integration.test.ts`
- Create: `Dockerfile.agent` (radice, accanto a Dockerfile.caddy)
- Modify: `docs/plans/2026-07-13-server-monitoring-design.md` — nessuna modifica; aggiorna invece `CLAUDE.md` (riga architettura runtime: menziona `/monitor` e l'immagine agent)

**Step 1: test fallente** — `integration.test.ts` (testcontainers, gira nei limiti maxForks? è in packages/agent che non ha vitest maxForks: aggiungilo, `maxForks: 1`): avvia `startTestDb()` + `buildApp()` reale del server su porta effimera (`app.listen({ port: 0 })`), registra un server via route admin, lancia il mainLoop dell'agente con collectors fake per 2 tick → le metriche compaiono in `server_metrics`; check postgres puntato al testcontainer stesso → metrics con `numbackends` ecc. (Se importare `apps/server` da `packages/agent` crea un ciclo di workspace, sposta questo test in `apps/server/src/routes/monitor-agent.integration.test.ts` importando il mainLoop da `@stubwise/agent` — direzione di dipendenza server→agent solo nei devDeps, accettabile.)

**Step 3:** `Dockerfile.agent` multi-stage (pattern del Dockerfile worker, MOLTO più piccolo): stage build con pnpm install filtrato `@stubwise/agent...` + esbuild bundle; runtime `node:22-alpine`, utente non-root, `CMD ["node", "/app/agent.cjs"]`. Build di verifica locale: `docker build -f Dockerfile.agent -t stubwise/agent .` (solo build, il run è manuale in prod).

**Step 5:** commit `feat(agent): integrazione end-to-end + Dockerfile.agent`.

---

## Fase E — UI (apps/web)

Pattern: funzioni in `apps/web/src/lib/api.ts` → `queryOptions` in `lib/queries.ts` → route code-based in `router.tsx` (figlie di `authedRoute`) → componenti. Test happy-dom come i `.test.tsx` esistenti. i18n: chiavi in `apps/web/src/i18n` (entrambe le lingue).

### Task E1: Client API + dipendenza uPlot

**Files:**
- Modify: `apps/web/src/lib/api.ts` (tipi + `listServers`, `getServer`, `createServer`, `updateServer`, `deleteServer`, `regenerateServerKey`, `listServerChecks`, `createServerCheck`, `updateServerCheck`, `deleteServerCheck`, `getServerMetrics(id, {from,to,checkId?})`)
- Modify: `apps/web/src/lib/queries.ts` (`serverKeys` factory + queryOptions; `refetchInterval: 30_000` sulla lista e sul dettaglio)
- Run: `pnpm --filter @stubwise/web add uplot`

**Step 1:** test di un paio di funzioni api con fetch mockato (pattern test esistenti se presente, altrimenti solo typecheck). **Step 5:** commit `feat(web): client api monitor + uplot`.

### Task E2: Sezione Monitor — lista server

**Files:**
- Create: `apps/web/src/routes/monitor/index.tsx` (+ `server-card.tsx` componente riusabile)
- Create: `apps/web/src/routes/monitor/index.test.tsx`
- Modify: `apps/web/src/router.tsx` (route `/monitor` + figlia `/monitor/$serverId`, in `authedRoute.addChildren`)
- Modify: `apps/web/src/components/app-layout.tsx` (`NAV_ITEMS`: `{ to: "/monitor", labelKey: "common:nav.monitor", code: "MON" }`)
- Modify: i18n (`nav.monitor`, chiavi sezione monitor)

**Step 1: test fallente** — render lista con 2 server mockati (online/offline): pallino stato, nome, CPU/RAM/disco correnti, conteggio servizi; server offline con classe di evidenza. **Step 3:** `ServerCard` stile terminal coerente con le card esistenti; sparkline = piccolo SVG inline (polyline su ultime N misure della lista — l'endpoint lista include `recentCpu: number[]` — aggiungilo in B2 se non c'è: 20 punti dal fine). **Step 5:** commit `feat(web): sezione monitor con card server`.

### Task E3: Dettaglio server con grafici uPlot

**Files:**
- Create: `apps/web/src/routes/monitor/server-detail.tsx` + test + `apps/web/src/components/uplot-chart.tsx` (wrapper React: crea/distrugge uPlot in useEffect, resize via ResizeObserver, tema da CSS variables)

**Step 1: test fallenti** — render con metriche mock: 4 pannelli (CPU+load, RAM+swap, disco, rete), selettore range `1h/24h/7g/30g/90g` che cambia `from` nella query; tabella servizi auto-scoperti (docker+pm2, badge source) e check espliciti con stato/latenza/errore; per check DB le metriche interne; pannello soglie (form PATCH thresholds). uPlot nei test happy-dom: mockare il modulo (`vi.mock("uplot")`) — il wrapper si testa solo per mount/unmount senza crash.

**Step 3:** implementazione. Percentuali RAM/disco calcolate client-side da used/total. **Step 5:** commit `feat(web): dettaglio server con grafici e servizi`.

> Nota: range 30g/90g: il rollup 5m sfora `METRICS_POINT_LIMIT` → decidere downsampling server-side (bucket orari via `date_trunc`) o riduzione client-side; il flag `truncated` della response lo segnala.

### Task E4: Registrazione server + editor check (Impostazioni)

**Files:**
- Create: `apps/web/src/routes/settings/servers.tsx` + test (pattern delle altre pagine settings)
- Modify: router + nav interna settings

**Step 1: test fallenti** — lista server in settings; "nuovo server" → dialog con nome → mostra UNA volta il comando `docker run` completo (chiave inclusa, bottone copia, varianti con/senza mount PM2 — testo multiriga preformattato); rigenerazione chiave con conferma; associazione progetti (multi-select dai progetti esistenti); editor check (form per tipo: url per http, host:porta per tcp, pattern per process, DSN per postgres/mysql con nota "salvato cifrato"); delete con conferma. **Step 5:** commit `feat(web): registrazione server e gestione check`.

Esporre il toggle `notifyMonitor` in GET/PUT /api/settings/notifications e come checkbox nella sezione notifiche della SPA (gap rilevato in C1-review).

### Task E5: Tab Server nel progetto

**Files:**
- Modify: la pagina progetto esistente (`apps/web/src/routes/projects/…` — individua il file del dettaglio progetto e il suo pattern tab) + test

**Step 1: test fallente** — progetto con server associati mostra tab "Server" con le stesse `ServerCard` (riuso, filtro `?projectId=`); senza server → tab con empty-state e link alle impostazioni. **Step 5:** commit `feat(web): tab server nella vista progetto`.

---

## Fase F — Finalizzazione

### Task F1: Verifica completa + docs

**Steps:**
1. Dalla radice del worktree: `pnpm lint` → 0 errori (OBBLIGATORIO, la CI fallisce su lint).
2. `pnpm typecheck` → verde.
3. `pnpm test` → verde (testcontainers: non parallelizzare a mano, lascia fare a maxForks).
4. E2E Playwright NON girano in `-r test`: per la UI nuova esegui manualmente `pnpm --filter @stubwise/web exec playwright test` se l'ambiente lo consente; altrimenti annota nel PR che vanno verificati in CI.
5. Aggiorna `CLAUDE.md`: superficie `/monitor` in architettura runtime, immagine `stubwise/agent` nel deploy ("modifica all'agente → build/push immagine agent"), env worker nuove.
6. Commit `docs: aggiorna CLAUDE.md per il monitoraggio server`.

### Task F2: Chiusura branch

Usa la skill superpowers:finishing-a-development-branch (merge/PR a scelta dell'utente). Promemoria deploy (dal design): ribuildare `server`, `worker`, `caddy`; pubblicare l'immagine agent; backup DB prima (migrazione 0047/0048); nessuna env obbligatoria nuova.

---

## Note trasversali per l'esecutore

- **Ordine:** le fasi A→B→C sono sequenziali (dipendenze reali). D dipende solo da A (contratti shared) e può procedere in parallelo a B/C. E dipende da B. Dentro ogni fase, i task nell'ordine dato.
- **Mai** salvare la chiave server in chiaro in DB; mai restituire `dsn` nelle risposte; mai loggare DSN o chiavi.
- Le route pubbliche `/monitor` NON hanno CORS (nessun browser le chiama). Il widget resta l'unico posto con `reply.hijack()`+ACAO manuale — qui non serve SSE.
- Se una migrazione tocca `notification_settings` (C1), è separata dalla 0047 ed è additiva con default: nessuna trappola enum-batch.
- In caso di dubbio sul comportamento di un pattern esistente (auth, poller, secrets), leggere il file citato nel task PRIMA di scrivere codice.
