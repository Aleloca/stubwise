import {
  serverHealth,
  type Reader,
  type AlertThresholds,
  type CreateCheckInput,
  type ServerCheckView,
  type ServerDetail as ServerDetailShape,
  type ServerMetricsResponse,
  type ServerView,
  type ServerWithKey,
  type UpdateCheckInput,
} from "@stubwise/shared";
import { downsample, downsampleSamples } from "../../../domain/servers/metrics";
import type {
  CheckSample,
  EpisodeReason,
  MetricPoint,
  ServerCheck,
  ServerService,
  ServerThresholds,
} from "../../model";
import type { CheckInput, CreateServerInput, UpdateServerInput } from "../../servers/monitor";
import type { InstanceServerRow, MetricRange, ServerMetrics } from "../../servers/reads";
import type { ServerDetail, ServerRow, SshAccessView } from "../../servers/visibility";
import { inPrototypeWords } from "./automationRefs";
import { appClient } from "./client";
import { instanceOrigin } from "./supportWidgets";

// I Server della build app (area 8, F4a) sopra le rotte vere, con le firme
// del prototipo (`data/servers/reads.ts`). Visibilità, salute (`serverHealth`
// di shared, calcolata dal server), ambienti e `orphan` li dice il server: il
// client legge, non deduce. Un server senza codice (un server più vecchio di
// SRV-<n>) non si mostra: la sua pagina si apre per codice. Nulla di ciò che
// agisce sul server (SSH, analisi, correzione: F4b) entra qui.

/** Le rotte (sul client vero: `client.servers`). */
export interface ServersApi {
  list(projectId?: string): Promise<Reader<ServerView>[]>;
  byCode(code: string): Promise<Reader<ServerDetailShape>>;
  metrics(
    serverId: string,
    range: { from: string; to: string; checkId?: string },
  ): Promise<Reader<ServerMetricsResponse>>;
  create(input: {
    name: string;
    environment?: { environmentId: string };
  }): Promise<Reader<ServerWithKey>>;
  update(
    serverId: string,
    patch: { name?: string; sampleIntervalSeconds?: number },
  ): Promise<Reader<ServerView>>;
  setThresholds(serverId: string, thresholds: AlertThresholds): Promise<Reader<ServerView>>;
  regenerateKey(serverId: string): Promise<Reader<ServerWithKey>>;
  delete(serverId: string): Promise<void>;
  createCheck(serverId: string, input: CreateCheckInput): Promise<Reader<ServerCheckView>>;
  updateCheck(
    serverId: string,
    checkId: string,
    patch: UpdateCheckInput,
  ): Promise<Reader<ServerCheckView>>;
  deleteCheck(serverId: string, checkId: string): Promise<void>;
}

const RANGE_MS: Record<MetricRange, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
  "90d": 90 * 24 * 3_600_000,
};

/** Di quanti secondi è la media di un punto, per la nota sotto i grafici (solo i passi larghi). */
const AVERAGED_SECONDS: Partial<Record<string, number>> = { "1h": 3_600, "4h": 14_400 };

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

type ServerPoint = Reader<ServerMetricsResponse>["points"][number];
type ServerCheckPoint = NonNullable<Reader<ServerMetricsResponse>["checkPoints"]>[number];

/** Un punto del server (byte; grezzo o aggregato) nella forma del prototipo (percentuali). */
function pointOf(p: ServerPoint): MetricPoint {
  if ("cpuPct" in p) {
    return {
      ts: p.ts,
      cpuPct: p.cpuPct,
      memPct: pct(p.memUsedBytes, p.memTotalBytes),
      diskPct: pct(p.diskUsedBytes, p.diskTotalBytes),
      load1m: p.load1m,
      netRxBytes: p.netRxBytes,
      netTxBytes: p.netTxBytes,
    };
  }
  return {
    ts: p.ts,
    cpuPct: p.cpuPctAvg,
    memPct: pct(p.memUsedBytesAvg, p.memTotalBytes),
    diskPct: pct(p.diskUsedBytesAvg, p.diskTotalBytes),
    load1m: p.load1mAvg,
    netRxBytes: p.netRxBytesSum,
    netTxBytes: p.netTxBytesSum,
  };
}

/** Un campione di controllo: giù se nel passo è stato giù almeno una volta; uno «sconosciuto» non si disegna. */
function sampleOf(c: ServerCheckPoint): CheckSample | null {
  if ("status" in c) {
    if (c.status !== "up" && c.status !== "down") return null;
    return { ts: c.ts, status: c.status, latencyMs: c.latencyMs };
  }
  return {
    ts: c.ts,
    status: c.downCount > 0 ? "down" : "up",
    latencyMs: c.latencyMsAvg === null ? null : Math.round(c.latencyMsAvg),
  };
}

type View = Reader<ServerView>;

/** Lo stato dell'agente; uno sconosciuto (un server più nuovo) si legge come non raggiungibile. */
const statusOf = (v: View): ServerRow["status"] =>
  v.status === "__unknown__" ? "offline" : v.status;

/**
 * La salute: quella del server; da un server di prima della F4a (nessun
 * campo), o con una parola che l'app non conosce, la si deriva con la stessa
 * regola, senza episodi.
 */
function healthOf(v: View, now: string): ServerRow["health"] {
  const h =
    v.health && v.health.health !== "__unknown__"
      ? { ...v.health, health: v.health.health }
      : serverHealth({ status: statusOf(v), lastSeenAt: v.lastSeenAt }, [], now);
  // I motivi sono quelli del server (`kind` testo): il prototipo li legge per `kind`.
  return { ...h, reasons: h.reasons as EpisodeReason[] };
}

/** Gli ambienti, uno per ambiente (il server li dà per repository). */
function environmentsOf(v: View): ServerRow["environments"] {
  const seen = new Map<string, ServerRow["environments"][number]>();
  for (const e of v.environments) {
    // Un tipo d'ambiente che l'app non conosce (un server più nuovo) non si mostra.
    if (e.kind === "__unknown__") continue;
    if (!seen.has(e.environmentId)) {
      seen.set(e.environmentId, { projectCode: e.projectCode, name: e.name, kind: e.kind });
    }
  }
  return [...seen.values()];
}

/** La riga nella forma del prototipo; `null` senza codice. */
export function rowOf(v: View, now: string): ServerRow | null {
  if (!v.code) return null;
  return {
    code: v.code,
    name: v.name,
    hostname: v.hostname,
    status: statusOf(v),
    health: healthOf(v, now),
    // F4a: analisi e correzione sono F4b, il server dice sempre `none`.
    work: v.work === "__unknown__" ? "none" : v.work,
    workTaskCode: null,
    // L'accesso SSH è della F4b: nella build app il pannello non c'è.
    access: "not_linked",
    environments: environmentsOf(v),
    // Il progetto principale e l'analisi sono della F4b (I1).
    primaryProjectCode: null,
    analysisProject: null,
    recentCpu: [...v.recentCpu],
  };
}

/** La riga di «Tutti i server»: i progetti per codice (dagli ambienti), `orphan`, `inArchivedOnly`. */
export function instanceRowOf(v: View, now: string): InstanceServerRow | null {
  const row = rowOf(v, now);
  if (!row) return null;
  const codeOf = new Map(v.environments.map((e) => [e.projectId, e.projectCode]));
  const projects = v.projects
    .flatMap((p) => {
      const code = codeOf.get(p.id);
      return code ? [{ code, name: p.name }] : [];
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return { ...row, projects, orphan: v.orphan, inArchivedOnly: v.inArchivedOnly };
}

/** L'accesso SSH è della F4b: nella build app è sempre «non collegato», e il pannello non c'è. */
const NO_ACCESS: SshAccessView = {
  state: "not_linked",
  read: null,
  fix: null,
  pending: null,
  verification: null,
  usable: { read: false, fix: false },
  lastUse: { read: null, fix: null },
  revokedAt: null,
  canManage: false,
};

/** Un controllo nella forma del prototipo (il DSN non esce mai: `hasDsn` resta del server). */
function checkOf(serverCode: string, c: Reader<ServerCheckView>): ServerCheck | null {
  if (c.type === "__unknown__") return null;
  return {
    id: c.id,
    serverCode,
    name: c.name,
    type: c.type,
    target: c.target,
    intervalSeconds: c.intervalSeconds,
    enabled: c.enabled,
    status: c.lastStatus === "__unknown__" ? "unknown" : c.lastStatus,
    latencyMs: c.lastLatencyMs,
    lastError: c.lastError,
  };
}

/** Il dettaglio nella forma del prototipo; `null` senza codice. */
export function detailOf(d: Reader<ServerDetailShape>, now: string): ServerDetail | null {
  const row = rowOf(d, now);
  if (!row) return null;
  const services: ServerService[] = d.services.flatMap((x) =>
    x.source === "__unknown__"
      ? []
      : [
          {
            name: x.name,
            // `pm2_fallback` è PM2 letto dal file: per chi guarda è PM2.
            source: x.source === "docker" ? ("docker" as const) : ("pm2" as const),
            state: x.state,
            cpuPct: x.cpuPct,
            memBytes: x.memBytes,
            restarts: x.restarts,
            ...(x.image ? { image: x.image } : {}),
          },
        ],
  );
  return {
    ...row,
    access: NO_ACCESS,
    agentVersion: d.agentVersion,
    lastSeenAt: d.lastSeenAt,
    sampleIntervalSeconds: d.sampleIntervalSeconds,
    createdAt: d.createdAt,
    thresholds: { ...d.alertThresholds },
    services,
    disks: d.disks.map((x) => ({ ...x })),
    checks: d.checks.flatMap((c) => checkOf(row.code, c) ?? []),
    episodes: d.episodes.map((e) => ({
      id: e.id,
      serverCode: row.code,
      severity: e.severity === "__unknown__" ? "trouble" : e.severity,
      reasons: e.reasons as EpisodeReason[],
      startedAt: e.startedAt,
      recoveredAt: e.recoveredAt,
      // L'analisi automatica è della F4b.
      analysisId: null,
      analysis: null,
      taskCode: null,
    })),
    productionProjects: d.productionProjects.map((p) => ({ ...p })),
    canManage: d.canManage,
    sshReachable: false,
    orphan: d.orphan,
    inArchivedOnly: d.inArchivedOnly,
  };
}

const byNumber = (a: { code: string }, b: { code: string }) =>
  Number(a.code.split("-")[1]) - Number(b.code.split("-")[1]);

export function createRealServers(
  api: ServersApi,
  now: () => string = () => new Date().toISOString(),
  origin: () => Promise<string> = instanceOrigin,
) {
  /** L'id del server per codice (le metriche vanno per id): dall'ultimo dettaglio letto. */
  const ids = new Map<string, string>();
  const idOf = async (code: string) =>
    ids.get(code) ?? (await inPrototypeWords(() => api.byCode(code))).id;
  /** Di quale server è un controllo (le rotte dei controlli vanno per server): dall'ultimo dettaglio. */
  const checkHome = new Map<string, { serverId: string; code: string }>();
  const homeOf = (checkId: string) => {
    const home = checkHome.get(checkId);
    if (!home) throw new Error("not_found");
    return home;
  };
  /** La chiave UNA volta, con l'indirizzo dell'istanza per il comando d'installazione. */
  const keyOf = async (r: Reader<ServerWithKey>) => ({
    agentKey: r.key,
    instanceUrl: r.ingestUrl ?? (await origin()),
  });
  return {
    /** I server degli ambienti del progetto, in ordine di numero. */
    async listProjectServers(projectId: string): Promise<ServerRow[]> {
      const rows = (await api.list(projectId)).flatMap((v) => rowOf(v, now()) ?? []);
      return rows.sort(byNumber);
    },

    /** I server che chi guarda può collegare a un ambiente: quelli che vede (S3). */
    async listLinkableServers(): Promise<{ code: string; name: string }[]> {
      return (await api.list())
        .flatMap((v) => (v.code ? [{ code: v.code, name: v.name }] : []))
        .sort(byNumber);
    },

    /** Tutti i server dell'istanza (Amministrazione, `monitor.manage`), in ordine di numero. */
    async listAllServers(): Promise<InstanceServerRow[]> {
      const rows = (await api.list()).flatMap((v) => instanceRowOf(v, now()) ?? []);
      return rows.sort(byNumber);
    },

    /** Il dettaglio per codice (`SRV-1`); `not_found` se invisibile o inesistente (R-G5). */
    async getServer(code: string): Promise<ServerDetail> {
      const d = await inPrototypeWords(() => api.byCode(code));
      const out = detailOf(d, now());
      if (!out) throw new Error("not_found");
      ids.set(out.code, d.id);
      for (const c of out.checks) checkHome.set(c.id, { serverId: d.id, code: out.code });
      return out;
    },

    /**
     * Un server nuovo. Dall'Amministrazione nasce orfano (`environmentId:
     * null`); dalla sezione di un progetto nasce dentro un suo ambiente, per
     * tutto il progetto (decisione c: l'ambiente senza repository, il server
     * lo stende su ognuna e imposta il `serverId` dell'ambiente).
     */
    async createServer(
      input: CreateServerInput,
    ): Promise<{ server: ServerRow; agentKey: string; instanceUrl?: string }> {
      const r = await inPrototypeWords(() =>
        api.create({
          name: input.name,
          ...(input.environmentId !== null
            ? { environment: { environmentId: input.environmentId } }
            : {}),
        }),
      );
      const server = rowOf(r, now());
      if (!server) throw new Error("not_found");
      ids.set(server.code, r.id);
      return { server, ...(await keyOf(r)) };
    },

    async regenerateAgentKey(code: string): Promise<{ agentKey: string; instanceUrl?: string }> {
      const id = await idOf(code);
      return keyOf(await inPrototypeWords(() => api.regenerateKey(id)));
    },

    /** Nome e intervallo; il progetto principale è della F4b (I1): non si manda. */
    async updateServer(code: string, patch: UpdateServerInput): Promise<ServerRow> {
      const id = await idOf(code);
      const body = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.sampleIntervalSeconds !== undefined
          ? { sampleIntervalSeconds: patch.sampleIntervalSeconds }
          : {}),
      };
      const row = rowOf(await inPrototypeWords(() => api.update(id, body)), now());
      if (!row) throw new Error("not_found");
      return row;
    },

    /** Le soglie: il server le SOSTITUISCE, si mandano intere. */
    async setThresholds(code: string, t: ServerThresholds): Promise<ServerThresholds> {
      const id = await idOf(code);
      const v = await inPrototypeWords(() => api.setThresholds(id, { ...t }));
      return { ...v.alertThresholds };
    },

    async deleteServer(code: string): Promise<void> {
      const id = await idOf(code);
      await inPrototypeWords(() => api.delete(id));
      ids.delete(code);
    },

    async createCheck(code: string, input: CheckInput): Promise<ServerCheck> {
      const id = await idOf(code);
      const c = await inPrototypeWords(() => api.createCheck(id, { ...input }));
      const out = checkOf(code, c);
      if (!out) throw new Error("not_found");
      checkHome.set(out.id, { serverId: id, code });
      return out;
    },

    async updateCheck(checkId: string, patch: Partial<CheckInput>): Promise<ServerCheck> {
      const home = homeOf(checkId);
      const c = await inPrototypeWords(() => api.updateCheck(home.serverId, checkId, { ...patch }));
      const out = checkOf(home.code, c);
      if (!out) throw new Error("not_found");
      return out;
    },

    async deleteCheck(checkId: string): Promise<void> {
      const home = homeOf(checkId);
      await inPrototypeWords(() => api.deleteCheck(home.serverId, checkId));
      checkHome.delete(checkId);
    },

    /**
     * Le metriche dell'intervallo: il passo lo sceglie il server dalla durata
     * (grezzo fino a 48 h, 5 min fino a 7 giorni, 1 h fino a 30, 4 h oltre),
     * le percentuali si calcolano qui dai byte, e il grafico non disegna più
     * di `METRIC_POINTS_MAX` punti.
     */
    async getServerMetrics(
      code: string,
      range: MetricRange,
      checkId?: string,
    ): Promise<ServerMetrics> {
      const id = await idOf(code);
      const to = now();
      const from = new Date(Date.parse(to) - RANGE_MS[range]).toISOString();
      const res = await inPrototypeWords(() =>
        api.metrics(id, { from, to, ...(checkId ? { checkId } : {}) }),
      );
      const all = res.points.map(pointOf);
      const reduced = downsample(all);
      const samples = (res.checkPoints ?? []).flatMap((c) => sampleOf(c) ?? []);
      const reducedSamples = downsampleSamples(samples);
      return {
        points: reduced.points,
        truncated: reduced.truncated || res.truncated,
        sampleCount: all.length,
        averagedSeconds: AVERAGED_SECONDS[res.resolution] ?? null,
        check: checkId
          ? {
              samples: reducedSamples.samples,
              truncated: reducedSamples.truncated || res.truncated,
              sampleCount: samples.length,
            }
          : null,
      };
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
export const liveServers = createRealServers({
  list: (projectId) => appClient().servers.list(projectId),
  byCode: (code) => appClient().servers.byCode(code),
  metrics: (id, range) => appClient().servers.metrics(id, range),
  create: (input) => appClient().servers.create(input),
  update: (id, patch) => appClient().servers.update(id, patch),
  setThresholds: (id, t) => appClient().servers.setThresholds(id, t),
  regenerateKey: (id) => appClient().servers.regenerateKey(id),
  delete: (id) => appClient().servers.delete(id),
  createCheck: (id, input) => appClient().servers.createCheck(id, input),
  updateCheck: (id, checkId, patch) => appClient().servers.updateCheck(id, checkId, patch),
  deleteCheck: (id, checkId) => appClient().servers.deleteCheck(id, checkId),
});
