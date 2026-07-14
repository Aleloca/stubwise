import { useTranslation } from "react-i18next";
import type { CheckStatus, ServerCheck } from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";

const STATUS_CLASS: Record<CheckStatus, string> = {
  up: "text-ok",
  down: "text-danger",
  unknown: "text-fg-faint",
};

/**
 * Tabella dei check di servizio. Riga cliccabile: seleziona il check e ne mostra
 * lo storico latenza (il chiamante aggiunge `checkId` alla query metriche).
 *
 * SICUREZZA: per i check DB il DSN non esce mai dall'API (`target` è vuoto,
 * `hasDsn` true) → si mostra l'etichetta "DSN cifrato", MAI il target.
 */
export function ChecksTable({
  checks,
  selectedCheckId,
  onSelect,
}: {
  checks: ServerCheck[];
  selectedCheckId: string | null;
  onSelect: (checkId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("monitor:detail.checks.title")}
        </h2>
      </header>
      {checks.length === 0 ? (
        <p className="px-4 py-6 text-center font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
          {t("monitor:detail.checks.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-[12px]">
            <thead>
              <tr className="text-fg-faint">
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.name")}</th>
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.type")}</th>
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.target")}</th>
                <th className="px-4 py-2 font-normal">{t("monitor:detail.checks.status")}</th>
                <th className="px-4 py-2 text-right font-normal">{t("monitor:detail.checks.latency")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {checks.map((check) => {
                const selected = check.id === selectedCheckId;
                return (
                  <tr
                    key={check.id}
                    onClick={() => onSelect(check.id)}
                    aria-selected={selected}
                    className={`cursor-pointer transition-colors hover:bg-ink-850 ${
                      selected ? "bg-ink-850" : ""
                    } ${check.lastStatus === "down" ? "border-l-2 border-l-danger" : ""}`}
                  >
                    <td className="px-4 py-2 text-fg">
                      {check.name}
                      {check.lastError && (
                        <span className="mt-0.5 block max-w-xs truncate text-[10px] text-danger">
                          {check.lastError}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-fg-muted">{check.type}</td>
                    <td className="px-4 py-2 text-fg-muted">
                      {/* DB: mai il DSN, solo l'etichetta cifrata. */}
                      {check.hasDsn ? (
                        <span className="text-fg-faint italic">
                          {t("monitor:detail.checks.encryptedDsn")}
                        </span>
                      ) : (
                        <span className="truncate">{check.target || "—"}</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 ${STATUS_CLASS[check.lastStatus]}`}>
                      {t(`monitor:detail.checkStatus.${check.lastStatus}`)}
                      {check.lastStatus === "down" && check.downSince && (
                        <span className="ml-2 text-[10px] text-fg-faint">
                          {t("monitor:detail.checks.downSince", {
                            time: formatRelativeTime(check.downSince),
                          })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-fg-muted tabular-nums">
                      {check.lastLatencyMs === null ? "—" : `${check.lastLatencyMs} ms`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
