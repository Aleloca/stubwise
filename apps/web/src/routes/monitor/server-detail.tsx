import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServerStatus } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatRelativeTime } from "../../lib/format";
import {
  projectsQueryOptions,
  serverChecksQueryOptions,
  serverDetailQueryOptions,
  serverMetricsQueryOptions,
} from "../../lib/queries";
import { ChecksTable } from "./checks-table";
import { DisksPanel } from "./disks-panel";
import { CheckLatencyChart, MetricsCharts } from "./metrics-charts";
import { ServerSettingsPanel } from "./server-admin";
import { ServicesTable } from "./services-table";
import { ThresholdsPanel } from "./thresholds-panel";

const route = getRouteApi("/authed/monitor/servers/$serverId");

/** Colore del pallino di stato (gemello di server-card.tsx). */
const STATUS_DOT: Record<ServerStatus, string> = {
  online: "bg-ok",
  offline: "bg-danger",
  never_connected: "bg-fg-faint",
};

/** Intervalli selezionabili → durata in ms. Chiavi allineate all'i18n. */
const RANGES = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
} as const;
type RangeKey = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

/** `now` quantizzato al minuto: chiave cache stabile (vedi vincolo E1). */
function quantizeToMinute(now: number): number {
  return Math.floor(now / 60_000) * 60_000;
}

/**
 * Dettaglio di un server monitorato: header con stato/heartbeat, selettore di
 * range, i 4 pannelli metrici uPlot, tabelle di servizi e check, dischi e il
 * form delle soglie di alert. Le query dettaglio/check sono live (refetch 30s);
 * le metriche seguono il range con `to` quantizzato al minuto per non creare una
 * entry di cache nuova a ogni render.
 */
export function ServerDetailPage() {
  const { t } = useTranslation();
  const { serverId } = route.useParams();

  const { data: server } = useSuspenseQuery(serverDetailQueryOptions(serverId));
  const { data: checks } = useSuspenseQuery(serverChecksQueryOptions(serverId));
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";
  // Progetti per l'editor anagrafica (solo admin): query secondaria non-suspense
  // così un errore/latenza qui non blocca né abbatte il resto del dettaglio.
  const { data: projects } = useQuery({ ...projectsQueryOptions, enabled: isAdmin });

  const [range, setRange] = useState<RangeKey>("24h");
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);

  // from/to DERIVATI dal range e da `now` quantizzato al minuto: stabili entro
  // il minuto (chiave cache), avanzano al minuto successivo.
  const to = quantizeToMinute(Date.now());
  const from = to - RANGES[range];
  const metricsRange = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    ...(selectedCheckId ? { checkId: selectedCheckId } : {}),
  };
  const metricsQuery = useQuery(serverMetricsQueryOptions(serverId, metricsRange));
  const metrics = metricsQuery.data;

  const selectedCheck = checks.find((c) => c.id === selectedCheckId) ?? null;

  // Dati stantii: l'ultimo campione è più vecchio di ~2× l'intervallo di
  // campionamento (un ciclo perso è normale, due segnalano un problema).
  const stale =
    server.metricsAt !== null &&
    Date.now() - new Date(server.metricsAt).getTime() > 2 * server.sampleIntervalSeconds * 1000;

  return (
    <div className="page">
      <div>
        <Link
          to="/monitor"
          className="font-mono text-[11px] text-fg-muted transition-colors hover:text-signal"
        >
          {t("monitor:detail.back")}
        </Link>
      </div>

      {/* Header: nome, stato, hostname, versione agente, last seen, progetti. */}
      <header className="mt-3 border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden
            className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[server.status]}`}
          />
          <h1 className="text-xl font-semibold">{server.name}</h1>
          <span className="font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
            {t(`monitor:status.${server.status}`)}
          </span>
          {server.hostname && (
            <span className="font-mono text-[12px] text-fg-faint">{server.hostname}</span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-fg-faint">
          {server.agentVersion && (
            <span>{t("monitor:card.agentVersion", { version: server.agentVersion })}</span>
          )}
          {server.lastSeenAt && (
            <span>
              {t("monitor:detail.lastSeen", { time: formatRelativeTime(server.lastSeenAt) })}
            </span>
          )}
          {stale && server.metricsAt && (
            <span className="text-signal">
              {t("monitor:detail.staleData", { time: formatRelativeTime(server.metricsAt) })}
            </span>
          )}
        </div>
        {server.projects.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {server.projects.map((project) => (
              <span
                key={project.id}
                className="rounded-sm border border-line bg-ink-800/60 px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-fg-muted"
              >
                {project.name}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* Selettore di range (stile terminal). */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase">
          {t("monitor:detail.rangeLabel")}
        </span>
        {RANGE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setRange(key)}
            aria-pressed={range === key}
            className={`rounded-sm border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              range === key
                ? "border-signal-dim bg-signal/10 text-signal"
                : "border-line text-fg-muted hover:border-line-strong hover:text-fg"
            }`}
          >
            {t(`monitor:detail.range.${key}`)}
          </button>
        ))}
      </div>

      {/* Nota discreta quando la serie è stata tagliata al tetto di punti del
          server (nessun numero hardcoded qui: il tetto è un dettaglio server). */}
      {metrics?.truncated && (
        <p className="mt-3 font-mono text-[10px] text-fg-faint">
          {t("monitor:detail.truncated")}
        </p>
      )}

      <div className="mt-4">
        {metrics ? (
          <MetricsCharts server={server} metrics={metrics} />
        ) : (
          <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
            {t("monitor:detail.loading")}
          </p>
        )}
      </div>

      <div className="mt-6 grid gap-3 lg:grid-cols-2">
        <ServicesTable services={server.services} />
        <DisksPanel disks={server.disks} threshold={server.alertThresholds.diskPct} />
      </div>

      <div className="mt-6 space-y-3">
        <ChecksTable
          serverId={serverId}
          checks={checks}
          selectedCheckId={selectedCheckId}
          onSelect={(id) => setSelectedCheckId((prev) => (prev === id ? null : id))}
          isAdmin={isAdmin}
        />
        {selectedCheck && metrics && <CheckLatencyChart metrics={metrics} check={selectedCheck} />}
        {checks.length > 0 && !selectedCheck && (
          <p className="font-mono text-[10px] text-fg-faint">
            {t("monitor:detail.checks.selectHint")}
          </p>
        )}
      </div>

      <div className="mt-6">
        <ThresholdsPanel server={server} />
      </div>

      {isAdmin && (
        <div className="mt-6">
          <ServerSettingsPanel server={server} projects={projects ?? []} />
        </div>
      )}
    </div>
  );
}
