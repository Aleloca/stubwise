import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ServerStatus, ServerView } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";

/** Colore del pallino di stato: verde online, rosso offline, grigio mai visto. */
const STATUS_DOT: Record<ServerStatus, string> = {
  online: "bg-ok",
  offline: "bg-danger",
  never_connected: "bg-fg-faint",
};

/**
 * Sparkline CPU: polyline SVG normalizzata su una griglia 0-100 (CPU in
 * percentuale, già nel dominio giusto), niente librerie. `preserveAspectRatio`
 * "none" lascia che il box si stiri alla larghezza disponibile mantenendo
 * l'altezza fissa. Con meno di 2 punti non c'è una linea da tracciare.
 */
function CpuSparkline({ values }: { values: number[] }) {
  const { t } = useTranslation();
  if (values.length < 2) {
    return (
      <span className="font-mono text-[10px] text-fg-faint">{t("monitor:card.noSparkline")}</span>
    );
  }
  // Ultimi ~20 campioni, dal più vecchio al più recente (come li manda l'API).
  const points = values.slice(-20);
  const height = 28;
  const width = 100;
  const step = width / (points.length - 1);
  const coords = points
    .map((value, index) => {
      const clamped = Math.max(0, Math.min(100, value));
      const x = index * step;
      // y in [1, height-1]: un margine di 1 unità sopra e sotto, così una
      // linea piatta a 0 o 100 non giace sul bordo del viewBox con metà
      // stroke clippata.
      const y = 1 + (1 - clamped / 100) * (height - 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-7 w-full text-signal"
    >
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Card di un server monitorato, riusata dalla lista Monitor e (in E5) dal tab
 * Server di un progetto. Prop unica `server` (proiezione `ServerView` della
 * lista): NON contiene RAM/disco correnti — la lista espone solo `recentCpu`,
 * quindi la card mostra CPU + sparkline, conteggi check e progetti; RAM/disco
 * vivono nel dettaglio. L'intera card linka al dettaglio del server.
 *
 * Stato d'allarme (offline o check giù) → bordo/accento rosso per farla saltare
 * all'occhio in una griglia.
 */
export function ServerCard({ server }: { server: ServerView }) {
  const { t } = useTranslation();
  const isAlarm = server.status === "offline" || server.checksDown > 0;
  const currentCpu = server.recentCpu.at(-1) ?? null;

  return (
    <Link
      to="/monitor/servers/$serverId"
      params={{ serverId: server.id }}
      className={`group flex flex-col gap-3 rounded-sm border bg-ink-900 p-4 transition-colors hover:bg-ink-850 ${
        isAlarm ? "border-danger/40" : "border-line hover:border-line-strong"
      }`}
    >
      {/* Riga di testa: pallino stato + nome + hostname, versione agente a destra. */}
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={`mt-1.5 size-2 shrink-0 rounded-full ${STATUS_DOT[server.status]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[15px] font-medium text-fg group-hover:text-signal">
              {server.name}
            </span>
            {server.hostname && (
              <span className="truncate font-mono text-[12px] text-fg-faint">
                {server.hostname}
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
            {t(`monitor:status.${server.status}`)}
            {/* Offline: "visto l'ultima volta" relativo; mai connesso: placeholder. */}
            {server.status === "offline" && server.lastSeenAt && (
              <span className="ml-2 normal-case tracking-normal text-fg-faint">
                {t("monitor:card.lastSeen", { time: formatRelativeTime(server.lastSeenAt) })}
              </span>
            )}
            {server.status === "never_connected" && (
              <span className="ml-2 normal-case tracking-normal text-fg-faint">
                {t("monitor:card.neverConnected")}
              </span>
            )}
          </p>
        </div>
        {server.agentVersion && (
          <span className="shrink-0 font-mono text-[10px] text-fg-faint">
            {t("monitor:card.agentVersion", { version: server.agentVersion })}
          </span>
        )}
      </div>

      {/* CPU corrente + sparkline dallo storico recente. */}
      <div className="flex items-center gap-3">
        <div className="flex w-16 shrink-0 flex-col">
          <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
            {t("monitor:card.cpu")}
          </span>
          <span className="font-mono text-[15px] text-fg tabular-nums">
            {currentCpu === null ? "—" : `${Math.round(currentCpu)}%`}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <CpuSparkline values={server.recentCpu} />
        </div>
      </div>

      {/* Piede: conteggio check up/giù + progetti associati come badge. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* I glifi ↑/↓ non dicono nulla a uno screen reader: l'aria-label sul
            contenitore espone i conteggi in forma leggibile ("3 up / 1 down"),
            i figli visuali sono aria-hidden. */}
        <span
          aria-label={t("monitor:card.servicesUpDown", {
            up: server.checksUp,
            down: server.checksDown,
          })}
          className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase"
        >
          <span aria-hidden>{t("monitor:card.services")}</span>
          <span aria-hidden className={server.checksUp > 0 ? "text-ok" : "text-fg-faint"}>
            {server.checksUp}↑
          </span>
          <span aria-hidden className={server.checksDown > 0 ? "text-danger" : "text-fg-faint"}>
            {server.checksDown}↓
          </span>
        </span>
        {server.projects.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            {server.projects.map((project) => (
              <span
                key={project.id}
                className="rounded-sm border border-line bg-ink-800/60 px-2 py-0.5 font-mono text-[10px] tracking-[0.06em] text-fg-muted"
              >
                {project.name}
              </span>
            ))}
          </span>
        )}
      </div>
    </Link>
  );
}
