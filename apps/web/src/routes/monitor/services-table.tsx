import { useTranslation } from "react-i18next";
import type { DiscoveredService, ServiceSource } from "../../lib/api";
import { formatBytes } from "../../lib/format";

/** Colore del badge per sorgente del servizio. */
const SOURCE_BADGE: Record<ServiceSource, string> = {
  docker: "border-signal/40 text-signal",
  pm2: "border-ok/40 text-ok",
  pm2_fallback: "border-fg-faint/40 text-fg-muted",
};

/** Stato "sano" → verde; stati d'arresto/errore → rosso; ignoto → neutro. */
function stateClass(state: string): string {
  const s = state.toLowerCase();
  if (s === "running" || s === "online") return "text-ok";
  if (s === "exited" || s === "errored" || s === "stopped" || s === "dead") return "text-danger";
  return "text-fg-muted";
}

/**
 * Tabella dei servizi auto-scoperti sull'host (container Docker / processi PM2)
 * dall'ultimo campione. `cpuPct`/`memBytes` possono mancare (null) a seconda
 * della sorgente. Vuota → empty state.
 */
export function ServicesTable({ services }: { services: DiscoveredService[] }) {
  const { t } = useTranslation();

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("monitor:detail.services.title")}
        </h2>
      </header>
      {services.length === 0 ? (
        <p className="px-4 py-6 text-center font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
          {t("monitor:detail.services.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-[12px]">
            <thead>
              <tr className="text-fg-faint">
                <th className="px-4 py-2 font-normal">{t("monitor:detail.services.name")}</th>
                <th className="px-4 py-2 font-normal">{t("monitor:detail.services.state")}</th>
                <th className="px-4 py-2 text-right font-normal">{t("monitor:detail.services.cpu")}</th>
                <th className="px-4 py-2 text-right font-normal">{t("monitor:detail.services.ram")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {services.map((svc, i) => (
                <tr key={`${svc.source}:${svc.name}:${i}`} className="text-fg">
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className={`rounded-sm border px-1.5 py-0.5 text-[10px] tracking-[0.06em] ${SOURCE_BADGE[svc.source]}`}
                      >
                        {svc.source}
                      </span>
                      <span className="truncate">{svc.name}</span>
                    </span>
                  </td>
                  <td className={`px-4 py-2 ${stateClass(svc.state)}`}>
                    {svc.state}
                    {svc.restarts !== null && svc.restarts > 0 && (
                      <span className="ml-2 text-fg-faint">
                        {t("monitor:detail.services.restarts", { count: svc.restarts })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {svc.cpuPct === null ? "—" : `${Math.round(svc.cpuPct)}%`}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {svc.memBytes === null ? "—" : formatBytes(svc.memBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
