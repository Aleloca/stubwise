import {
  serverHealth,
  type Reader,
  type ServerCheckView,
  type ServerDetail as ServerDetailShape,
  type ServerView,
} from "@stubwise/shared";
import type { EpisodeReason, ServerCheck, ServerService } from "../../model";
import type { InstanceServerRow } from "../../servers/reads";
import type { ServerDetail, ServerRow, SshAccessView } from "../../servers/visibility";
import { inPrototypeWords } from "./automationRefs";
import { appClient } from "./client";

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
) {
  return {
    /** I server degli ambienti del progetto, in ordine di numero. */
    async listProjectServers(projectId: string): Promise<ServerRow[]> {
      const rows = (await api.list(projectId)).flatMap((v) => rowOf(v, now()) ?? []);
      return rows.sort(byNumber);
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
      return out;
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
export const liveServers = createRealServers({
  list: (projectId) => appClient().servers.list(projectId),
  byCode: (code) => appClient().servers.byCode(code),
});
