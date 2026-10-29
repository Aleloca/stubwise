import { downsample, downsampleSamples } from "../../domain/servers/metrics";
import { fold } from "../../domain/textSearch";
import { gate, now, state } from "../store";
import type { CheckSample, MetricPoint } from "../types";
import { notFound } from "../writer";
import {
  homeProjectCode,
  metricsSince,
  projectServerCodes,
  sees,
  serverDetail,
  serverFor,
  serverRow,
  serversVisibleTo,
  type ServerDetail,
  type ServerRow,
} from "./visibility";

// Le letture dei Server (area 8b). La lista di un progetto che chi guarda
// non vede è vuota; un server invisibile risponde `not_found`, come uno che
// non esiste (R-G5). I grafici non portano mai più di `METRIC_POINTS_MAX`
// punti (RF 5): i giorni lunghi si riducono a media.

/** I server degli ambienti del progetto (R-L2), in ordine di numero. */
export async function listProjectServers(projectId: string): Promise<ServerRow[]> {
  const me = await gate("servers.listProjectServers");
  if (!sees(me, projectId)) return [];
  return projectServerCodes(projectId).flatMap((code) => {
    const s = state.servers.find((x) => x.code === code);
    return s ? [serverRow(me, s)] : [];
  });
}

/** Il dettaglio di un server (`SRV-1`); `not_found` se invisibile o inesistente. */
export async function getServer(code: string): Promise<ServerDetail> {
  const me = await gate("servers.getServer");
  return serverDetail(me, serverFor(me, code));
}

export type MetricRange = "1h" | "24h" | "7d";

const RANGE_MS: Record<MetricRange, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};

export interface ServerMetrics {
  points: MetricPoint[];
  truncated: boolean;
  /**
   * Con un controllo (R-L1): i suoi campioni nello stesso intervallo, per il
   * grafico «Response time» e le fasce dei momenti giù; `null` senza.
   */
  check: { samples: CheckSample[]; truncated: boolean } | null;
}

/** Le metriche di un server nell'intervallo (ultimi 1h / 24h / 7d), ridotte per il grafico. */
export async function getServerMetrics(
  code: string,
  range: MetricRange,
  checkId?: string,
): Promise<ServerMetrics> {
  const me = await gate("servers.getServerMetrics");
  const server = serverFor(me, code);
  const fromMs = Date.parse(now()) - RANGE_MS[range];
  let check: ServerMetrics["check"] = null;
  if (checkId !== undefined) {
    const own = state.serverChecks.find((c) => c.id === checkId && c.serverCode === server.code);
    if (!own) throw notFound();
    const samples = (state.serverCheckSamples.get(checkId) ?? []).filter(
      (s) => Date.parse(s.ts) > fromMs,
    );
    check = downsampleSamples(samples);
  }
  return { ...downsample(metricsSince(server.code, fromMs)), check };
}

export interface ServerSearchResult {
  code: string;
  name: string;
  /** Il progetto da cui si apre (`serverHref`): il principale, o il primo visibile. */
  projectCode: string;
}

/** ⌘K: i server per codice, nome o hostname, solo fra quelli che chi cerca vede. */
export async function searchServers(q: string): Promise<ServerSearchResult[]> {
  const me = await gate("servers.searchServers");
  const needle = fold(q.trim());
  if (!needle) return [];
  const visible = serversVisibleTo(me);
  return state.servers
    .filter((s) => visible.has(s.code))
    .filter((s) => [s.code, s.name, s.hostname ?? ""].some((x) => fold(x).includes(needle)))
    .flatMap((s) => {
      const projectCode = homeProjectCode(me, s);
      return projectCode ? [{ code: s.code, name: s.name, projectCode }] : [];
    });
}
