import type { MonitoredServer, ServerCheck, ServerThresholds } from "../../types";
import { TODAY } from "../dates";

// I server dell'area 8b (spec «Dati finti», R-K3 e R-L2): oggetti d'istanza
// che entrano nei progetti attraverso gli ambienti
// (`data/seed/releases/environments.ts`).
//
// - SRV-1 `acq-prod-01`: la produzione di ACQ; l'allarme di memoria del seme.
// - SRV-2 `db-stw-01`: la produzione di STW; disco quasi pieno adesso, e il
//   controllo della replica giù.
// - SRV-3 `aud-app-01`: la produzione di AUD per `audin-app`.
// - SRV-4 `aud-admin-01`: la produzione di AUD per `audin-admin`.
//
// I server creati dall'app partono da SRV-5 (`serverCodeSeq`).

/** Le soglie di base, quelle del web: CPU 95%, memoria 90%, disco 90%, per 5 minuti. */
export const DEFAULT_THRESHOLDS: ServerThresholds = {
  cpuPct: 95,
  memPct: 90,
  diskPct: 90,
  sustainedMinutes: 5,
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** L'ultimo campione: trenta secondi fa (l'adesso del prototipo è mezzogiorno di `TODAY`). */
const LAST_SEEN = `${TODAY}T11:59:30Z`;

// Un servizio per riga: la tabella si legge meglio di oggetti a capo.
// prettier-ignore
export const SERVERS: MonitoredServer[] = [
  {
    id: "srv-1",
    code: "SRV-1",
    name: "acq-prod-01",
    hostname: "acq-prod-01.colline.internal",
    status: "online",
    agentVersion: "1.8.2",
    lastSeenAt: LAST_SEEN,
    sampleIntervalSeconds: 30,
    thresholds: { ...DEFAULT_THRESHOLDS },
    services: [
      { name: "caddy", source: "docker", state: "running", cpuPct: 0.4, memBytes: 38 * MB, restarts: 0, image: "caddy:2.8" },
      { name: "portale-web", source: "docker", state: "running", cpuPct: 3.1, memBytes: 210 * MB, restarts: 0, image: "colline/portale-web:3.4.1" },
      { name: "portale-api", source: "docker", state: "running", cpuPct: 7.8, memBytes: 640 * MB, restarts: 0, image: "colline/portale-api:3.4.1" },
      { name: "portale-import", source: "docker", state: "running", cpuPct: 1.2, memBytes: 590 * MB, restarts: 0, image: "colline/portale-import:3.4.1" },
      { name: "postgres", source: "docker", state: "running", cpuPct: 4.5, memBytes: 1640 * MB, restarts: 0, image: "postgres:16" },
    ],
    disks: [
      { mount: "/", usedBytes: 41 * GB, totalBytes: 80 * GB },
      { mount: "/var/lib/postgresql", usedBytes: 62 * GB, totalBytes: 200 * GB },
    ],
    primaryProjectId: "prj-acq",
    createdAt: "2026-09-12T10:00:00Z",
    sshReachable: true,
  },
  {
    id: "srv-2",
    code: "SRV-2",
    name: "db-stw-01",
    hostname: "db-stw-01.stubwise.internal",
    status: "online",
    agentVersion: "1.8.2",
    lastSeenAt: LAST_SEEN,
    sampleIntervalSeconds: 30,
    thresholds: { ...DEFAULT_THRESHOLDS },
    services: [
      { name: "postgres", source: "docker", state: "running", cpuPct: 11.2, memBytes: 2460 * MB, restarts: 0, image: "postgres:17" },
      { name: "pgbouncer", source: "docker", state: "running", cpuPct: 0.6, memBytes: 24 * MB, restarts: 0, image: "edoburu/pgbouncer:1.23" },
      { name: "wal-archiver", source: "pm2", state: "online", cpuPct: 0.9, memBytes: 96 * MB, restarts: 3 },
    ],
    // 186 GB su 200: il 93% dell'episodio aperto.
    disks: [{ mount: "/", usedBytes: 186 * GB, totalBytes: 200 * GB }],
    primaryProjectId: "prj-stw",
    createdAt: "2026-08-03T09:00:00Z",
    sshReachable: true,
  },
  {
    id: "srv-3",
    code: "SRV-3",
    name: "aud-app-01",
    hostname: "aud-app-01.audin.internal",
    status: "online",
    agentVersion: "1.8.1",
    lastSeenAt: LAST_SEEN,
    sampleIntervalSeconds: 30,
    thresholds: { ...DEFAULT_THRESHOLDS },
    services: [
      { name: "caddy", source: "docker", state: "running", cpuPct: 0.3, memBytes: 34 * MB, restarts: 0, image: "caddy:2.8" },
      { name: "audin-app", source: "docker", state: "running", cpuPct: 14.6, memBytes: 1130 * MB, restarts: 1, image: "audin/audin-app:2.0.2" },
      { name: "audin-worker", source: "docker", state: "running", cpuPct: 5.2, memBytes: 480 * MB, restarts: 0, image: "audin/audin-app:2.0.2" },
      { name: "redis", source: "docker", state: "running", cpuPct: 0.8, memBytes: 120 * MB, restarts: 0, image: "redis:7.4" },
    ],
    disks: [{ mount: "/", usedBytes: 58 * GB, totalBytes: 160 * GB }],
    primaryProjectId: "prj-aud",
    createdAt: "2026-07-20T14:00:00Z",
    sshReachable: true,
  },
  {
    id: "srv-4",
    code: "SRV-4",
    name: "aud-admin-01",
    hostname: "aud-admin-01.audin.internal",
    status: "online",
    agentVersion: "1.8.2",
    lastSeenAt: LAST_SEEN,
    sampleIntervalSeconds: 30,
    thresholds: { ...DEFAULT_THRESHOLDS },
    services: [
      { name: "caddy", source: "docker", state: "running", cpuPct: 0.2, memBytes: 31 * MB, restarts: 0, image: "caddy:2.8" },
      { name: "audin-admin", source: "pm2", state: "online", cpuPct: 2.4, memBytes: 310 * MB, restarts: 0 },
    ],
    disks: [{ mount: "/", usedBytes: 19 * GB, totalBytes: 80 * GB }],
    primaryProjectId: "prj-aud",
    createdAt: "2026-09-30T11:00:00Z",
    sshReachable: true,
  },
];

/**
 * I controlli: stato e latenza sono quelli dell'ultimo campione
 * (`metrics.ts` fa finire la serie su questi valori). Uno solo giù: la
 * replica di SRV-2, uno dei motivi dell'episodio aperto.
 */
// prettier-ignore
export const SERVER_CHECKS: ServerCheck[] = [
  { id: "chk-srv-1-api", serverCode: "SRV-1", name: "API health", type: "http", target: "https://portale.acquedottocolline.test/api/health", intervalSeconds: 60, enabled: true, status: "up", latencyMs: 142, lastError: null },
  { id: "chk-srv-1-db", serverCode: "SRV-1", name: "Postgres", type: "postgres", target: "127.0.0.1:5432", intervalSeconds: 60, enabled: true, status: "up", latencyMs: 4, lastError: null },
  { id: "chk-srv-1-import", serverCode: "SRV-1", name: "Import worker", type: "process", target: "portale-import", intervalSeconds: 60, enabled: true, status: "up", latencyMs: null, lastError: null },
  { id: "chk-srv-2-db", serverCode: "SRV-2", name: "Postgres", type: "postgres", target: "127.0.0.1:5432", intervalSeconds: 60, enabled: true, status: "up", latencyMs: 6, lastError: null },
  { id: "chk-srv-2-replica", serverCode: "SRV-2", name: "Replica port", type: "tcp", target: "10.0.4.12:5433", intervalSeconds: 60, enabled: true, status: "down", latencyMs: null, lastError: "connection refused" },
  { id: "chk-srv-3-app", serverCode: "SRV-3", name: "App health", type: "http", target: "https://app.audin.test/health", intervalSeconds: 60, enabled: true, status: "up", latencyMs: 96, lastError: null },
  { id: "chk-srv-3-redis", serverCode: "SRV-3", name: "Redis", type: "tcp", target: "127.0.0.1:6379", intervalSeconds: 60, enabled: true, status: "up", latencyMs: 2, lastError: null },
  { id: "chk-srv-4-admin", serverCode: "SRV-4", name: "Admin health", type: "http", target: "https://admin.audin.test/health", intervalSeconds: 60, enabled: true, status: "up", latencyMs: 188, lastError: null },
];
