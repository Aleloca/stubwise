import {
  serverHealth,
  type Reader,
  type AlertThresholds,
  type CreateCheckInput,
  type ServerAnalysisView as ServerAnalysisWire,
  type ServerSshAccessView as SshWire,
  type ServerCheckView,
  type ServerDetail as ServerDetailShape,
  type ServerMetricsResponse,
  type ServerView,
  type ServerWithKey,
  type UpdateCheckInput,
} from "@stubwise/shared";
import { METRIC_POINTS_MAX } from "../../../domain/servers/limits";
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
import type {
  ServerAnalysisView,
  ServerAttributionView,
  ServerDetail,
  ServerRow,
  SshAccessView,
} from "../../servers/visibility";
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
  /** Area 8, F4b: le ultime analisi del server (`client.serverOps.analyses`). */
  analyses(serverId: string): Promise<{ analyses: Reader<ServerAnalysisWire>[] }>;
  /** L'analisi a mano (`client.serverOps.startAnalysis`): 409 `analysis_running`. */
  startAnalysis(serverId: string): Promise<Reader<ServerAnalysisWire>>;
  /** L'accesso SSH di sola lettura (`client.serverOps.ssh*`), `servers.ssh.manage`. */
  ssh(serverId: string): Promise<Reader<SshWire>>;
  connectSsh(serverId: string, input: { host?: string; port?: number }): Promise<Reader<SshWire>>;
  verifySsh(serverId: string): Promise<Reader<SshWire>>;
  regenerateSsh(serverId: string): Promise<Reader<SshWire>>;
  revokeSsh(serverId: string): Promise<Reader<SshWire>>;
  /** La chiave pubblica d'istanza dei comandi (R3, `monitor.manage`). */
  commandKey(): Promise<{ publicKey: string }>;
}

/**
 * L'accesso SSH del server nella forma del prototipo (area 8, F4b). Gli
 * stati: `none` → non collegato, `pending` → in attesa del comando,
 * `verified` → verificato; `failed` col risultato (sudo, docker…) →
 * privilegiato, senza (connessione, comando, host key) → verifica fallita.
 * Una chiave sola: nessuna «rigenerazione» con la vecchia ancora usabile.
 * `usable` lo calcola il server; l'ultimo uso è solo la data.
 */
export function sshAccessOf(v: Reader<SshWire>): SshAccessView {
  const status = v.status === "__unknown__" ? "none" : v.status;
  const key =
    v.publicKey && status !== "revoked"
      ? { publicKey: v.publicKey, fingerprint: v.fingerprint ?? "", createdAt: v.verifiedAt ?? "" }
      : null;
  const r = v.verifyResult;
  const state: SshAccessView["state"] =
    status === "none"
      ? "not_linked"
      : status === "pending"
        ? "awaiting_command"
        : status === "verified"
          ? "verified"
          : status === "revoked"
            ? "revoked"
            : r && !r.ok
              ? "privileged"
              : "verify_failed";
  return {
    state,
    username: v.username,
    key: state === "awaiting_command" ? null : key,
    pending: state === "awaiting_command" ? key : null,
    verification: r
      ? {
          at: v.verifiedAt ?? "",
          login: "ok",
          groups: [...r.groups],
          sudo: r.sudo,
          docker: r.docker,
          journal: r.journal,
          ok: r.ok,
          reason: null,
          ofPending: false,
        }
      : null,
    usable: v.usable,
    journal: r?.journal ?? false,
    lastUse: v.lastUsedAt ? { at: v.lastUsedAt, label: null, sessionId: null } : null,
    revokedAt: v.revokedAt,
    canManage: v.canManage,
  };
}

/** Le parole dello stato del server nell'esito del prototipo (`done` è la diagnosi). */
const OUTCOME: Record<string, ServerAnalysisView["outcome"]> = {
  running: "running",
  done: "diagnosed",
  failed: "failed",
  // Bloccata prima di partire: nessuna diagnosi; il perché è `blockedBy`.
  blocked: "stopped",
};

/**
 * Un'analisi del server nella forma del prototipo (area 8, F4b). Diagnosi e
 * sessione le dà il server solo con `canViewDiagnosis`; il client non le
 * deduce. Un esito che l'app non conosce non si inventa: `stopped`.
 */
export function analysisOf(v: Reader<ServerAnalysisWire>, serverCode: string): ServerAnalysisView {
  const at = v.attribution;
  const attribution: ServerAttributionView | null =
    at === null || at.kind === "__unknown__"
      ? null
      : at.kind === "attributed"
        ? { kind: "attributed", projectCode: at.projectCode }
        : {
            kind: "undetermined",
            reason: (at.reason ?? "no_project") as Extract<
              ServerAttributionView,
              { kind: "undetermined" }
            >["reason"],
          };
  return {
    id: v.id,
    serverCode,
    episodeId: v.episodeId,
    // `done` al tetto dei minuti (`endedBy: "time"`) è la diagnosi parziale del prototipo.
    outcome:
      v.status === "done" && v.endedBy === "time" ? "timed_out" : (OUTCOME[v.status] ?? "stopped"),
    // Registro, A11 r.1414: chi non si conosce arriva col nome null (e un id `hidden-…`).
    startedBy: v.startedBy ? { id: v.startedBy.id, name: v.startedBy.name ?? "" } : null,
    startedAt: v.startedAt,
    endedAt: v.finishedAt,
    canViewDiagnosis: v.canViewDiagnosis,
    sessionId: v.canViewDiagnosis ? v.sessionId : null,
    attribution,
    diagnosis: v.canViewDiagnosis ? v.diagnosis : null,
    taskCode: v.taskCode,
    ...(v.status === "blocked" && v.blockedBy && v.blockedBy !== "__unknown__"
      ? { blockedBy: v.blockedBy }
      : {}),
  };
}

/** Le analisi lette sul dettaglio: l'analisi di ogni episodio e l'ultima a mano. */
function withAnalyses(d: ServerDetail, wire: Reader<ServerAnalysisWire>[]): ServerDetail {
  const all = wire.map((w) => analysisOf(w, d.code));
  const newest = (xs: ServerAnalysisView[]) =>
    [...xs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  return {
    ...d,
    episodes: d.episodes.map((e) => {
      const mine = newest(all.filter((a) => a.episodeId === e.id));
      // Bloccata all'allarme: nessuna analisi, l'episodio lo ricorda (come il prototipo).
      if (mine?.blockedBy) {
        const blocked =
          mine.blockedBy === "monthly_budget" || mine.blockedBy === "disabled"
            ? mine.blockedBy
            : null;
        return { ...e, analysis: null, analysisBlocked: blocked };
      }
      return { ...e, analysis: mine, taskCode: mine?.taskCode ?? e.taskCode };
    }),
    manualAnalysis: newest(all.filter((a) => a.startedBy !== null)),
  };
}

const RANGE_MS: Record<MetricRange, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
  "90d": 90 * 24 * 3_600_000,
};

/** Il passo del server in secondi (un punto aggregato è la media del suo passo). */
const STEP_SECONDS: Partial<Record<string, number>> = { "5m": 300, "1h": 3_600, "4h": 14_400 };

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

type ServerPoint = Reader<ServerMetricsResponse>["points"][number];
type ServerCheckPoint = NonNullable<Reader<ServerMetricsResponse>["checkPoints"]>[number];

/**
 * Un punto del server (byte; grezzo o aggregato) nella forma del prototipo:
 * percentuali, e la rete in byte al SECONDO (review F4a, M2) — il grezzo è il
 * delta del campionamento, l'aggregato la somma del passo.
 */
function pointOf(p: ServerPoint, sampleSeconds: number, stepSeconds: number): MetricPoint {
  if ("cpuPct" in p) {
    return {
      ts: p.ts,
      cpuPct: p.cpuPct,
      memPct: pct(p.memUsedBytes, p.memTotalBytes),
      diskPct: pct(p.diskUsedBytes, p.diskTotalBytes),
      load1m: p.load1m,
      netRxBytes: p.netRxBytes / sampleSeconds,
      netTxBytes: p.netTxBytes / sampleSeconds,
    };
  }
  return {
    ts: p.ts,
    cpuPct: p.cpuPctAvg,
    memPct: pct(p.memUsedBytesAvg, p.memTotalBytes),
    diskPct: pct(p.diskUsedBytesAvg, p.diskTotalBytes),
    load1m: p.load1mAvg,
    netRxBytes: p.netRxBytesSum / stepSeconds,
    netTxBytes: p.netTxBytesSum / stepSeconds,
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
    // Una produzione fra gli ambienti che il server dà: gli allarmi avvisano
    // (e, con la F4b, l'analisi del server parte).
    alerting: v.environments.some((e) => e.kind === "production"),
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

/** La base dell'accesso, senza chiavi né azioni. */
const NO_ACCESS: SshAccessView = {
  state: "not_linked",
  username: "stubwise-read",
  key: null,
  pending: null,
  verification: null,
  usable: false,
  journal: false,
  lastUse: null,
  revokedAt: null,
  canManage: false,
};

/**
 * Per chi non gestisce l'SSH (403 su `GET /ssh`): lo stato dal riassunto del
 * dettaglio (`ssh: { status, usable }`, 72), che vede chiunque veda il
 * server. Una verifica fallita qui non dice se per privilegi: niente esito.
 */
function summaryAccess(s: Reader<ServerDetailShape>["ssh"]): SshAccessView {
  const status = s.status === "__unknown__" ? "none" : s.status;
  const state: SshAccessView["state"] =
    status === "none"
      ? "not_linked"
      : status === "pending"
        ? "awaiting_command"
        : status === "failed"
          ? "verify_failed"
          : status;
  return { ...NO_ACCESS, state, usable: s.usable };
}

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
    // Area 8, F4b: dichiarazione dell'agente, di base spenta.
    agentOperations: d.agentOperations,
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
    // Il permesso lo calcola il server (servers.operate in un progetto del server, nessuna in corso).
    canStartAnalysis: d.canStartAnalysis,
    manualAnalysis: null,
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
  /** L'intervallo di campionamento per codice (la rete grezza è per campione). */
  const intervals = new Map<string, number>();
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
      const base = detailOf(d, now());
      if (!base) throw new Error("not_found");
      // Le analisi (F4b): una lettura che non riesce non toglie la pagina.
      const wire = await api.analyses(d.id).then(
        (r) => r.analyses,
        () => [],
      );
      // L'accesso SSH (F4b): chi lo gestisce legge la vista intera; gli altri il riassunto.
      const access = await api.ssh(d.id).then(sshAccessOf, () => summaryAccess(d.ssh));
      const out = { ...withAnalyses(base, wire), access };
      ids.set(out.code, d.id);
      intervals.set(out.code, d.sampleIntervalSeconds);
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
    /** Collega l'accesso: host di base quello che l'agente riporta (`host_required` senza). */
    async linkSshAccess(code: string): Promise<{ command: string }> {
      const id = await idOf(code);
      const v = await inPrototypeWords(() => api.connectSsh(id, {}));
      return { command: v.setupCommand ?? "" };
    },

    async verifySshAccess(code: string): Promise<SshAccessView> {
      const id = await idOf(code);
      return sshAccessOf(await inPrototypeWords(() => api.verifySsh(id)));
    },

    /** Una coppia nuova: la vecchia smette subito di valere (sul server non esistono due chiavi). */
    async regenerateSshAccess(code: string): Promise<{ command: string }> {
      const id = await idOf(code);
      const v = await inPrototypeWords(() => api.regenerateSsh(id));
      return { command: v.setupCommand ?? "" };
    },

    async revokeSshAccess(code: string): Promise<{ removalCommand: string }> {
      const id = await idOf(code);
      const v = await inPrototypeWords(() => api.revokeSsh(id));
      return { removalCommand: v.removeCommand ?? "" };
    },

    /** Il comando da (ri)vedere: quello del server (in inglese, senza la lingua del prototipo). */
    async getInstallCommand(code: string): Promise<{ command: string }> {
      const id = await idOf(code);
      const v = await inPrototypeWords(() => api.ssh(id));
      if (!v.setupCommand) throw new Error("invalid: state");
      return { command: v.setupCommand };
    },

    async getRemovalCommand(code: string): Promise<{ command: string }> {
      const id = await idOf(code);
      const v = await inPrototypeWords(() => api.ssh(id));
      if (!v.removeCommand) throw new Error("invalid: state");
      return { command: v.removeCommand };
    },

    /** La chiave dei comandi per il comando d'installazione con le operazioni (R3). */
    async getCommandKey(): Promise<{ publicKey: string }> {
      const r = await inPrototypeWords(() => api.commandKey());
      return { publicKey: r.publicKey };
    },

    /** «Ask Claude to look into it» (R0-A2): `POST /api/servers/:id/analyses`. */
    async startServerAnalysis(code: string): Promise<ServerAnalysisView> {
      const id = await idOf(code);
      return analysisOf(await inPrototypeWords(() => api.startAnalysis(id)), code);
    },

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
      const sample = intervals.get(code) ?? 30;
      const step = STEP_SECONDS[res.resolution] ?? sample;
      const all = res.points.map((p) => pointOf(p, sample, step));
      const reduced = downsample(all);
      const samples = (res.checkPoints ?? []).flatMap((c) => sampleOf(c) ?? []);
      const reducedSamples = downsampleSamples(samples);
      return {
        points: reduced.points,
        truncated: reduced.truncated || res.truncated,
        sampleCount: all.length,
        // La media vera (review F4a, M1), come il prototipo: solo a 30 e 90
        // giorni, la finestra dopo la riduzione a 300 punti (o il passo del
        // server se non serve ridurre). Fino a 7 giorni vale la nota dei punti
        // ridotti (`sampleCount`): mai «5 minuti» su punti che sono medie di più.
        averagedSeconds:
          range !== "30d" && range !== "90d"
            ? null
            : reduced.truncated
              ? Math.round(RANGE_MS[range] / 1000 / (METRIC_POINTS_MAX - 2))
              : (STEP_SECONDS[res.resolution] ?? null),
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
  analyses: (id) => appClient().serverOps.analyses(id),
  startAnalysis: (id) => appClient().serverOps.startAnalysis(id),
  ssh: (id) => appClient().serverOps.ssh(id),
  connectSsh: (id, input) =>
    appClient().serverOps.connectSsh(id, input as { host: string; port?: number }),
  verifySsh: (id) => appClient().serverOps.verifySsh(id),
  regenerateSsh: (id) => appClient().serverOps.regenerateSsh(id),
  revokeSsh: (id) => appClient().serverOps.revokeSsh(id),
  commandKey: () => appClient().serverOps.commandKey(),
});
