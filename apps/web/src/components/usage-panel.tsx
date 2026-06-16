import { useTranslation } from "react-i18next";
import type { TicketUsage } from "../lib/api";
import { formatCostUsd, formatTokens } from "../lib/format";

/**
 * Pannello "Consumi AI" del dettaglio ticket: token totali (input+output) e
 * costo totale in USD, più una tabella per modello (token in/out · cache ·
 * costo). Si renderizza solo quando ci sono consumi: il chiamante lo monta
 * sotto condizione (`usage.byModel.length > 0`), ma per sicurezza il
 * componente stesso non rende nulla con byModel vuoto — un CLI senza usage
 * deve degradare a "niente pannello", mai a un riquadro vuoto.
 */
export function UsagePanel({ usage }: { usage: TicketUsage }) {
  const { t } = useTranslation();
  if (usage.byModel.length === 0) return null;

  return (
    <section>
      <h2 className={sectionTitleClass}>{t("tickets:usage.title")}</h2>

      <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-2">
        <Total label={t("tickets:usage.totalTokens")} value={formatTokens(usage.totalTokens)} />
        <Total
          label={t("tickets:usage.totalCost")}
          value={usage.totalCostUsd !== null ? formatCostUsd(usage.totalCostUsd) : "—"}
        />
      </dl>

      <div className="overflow-x-auto rounded-sm border border-line">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-line text-fg-faint">
              <Th className="text-left">{t("tickets:usage.model")}</Th>
              <Th className="text-right">{t("tickets:usage.tokensIn")}</Th>
              <Th className="text-right">{t("tickets:usage.tokensOut")}</Th>
              <Th className="text-right">{t("tickets:usage.cache")}</Th>
              <Th className="text-right">{t("tickets:usage.cost")}</Th>
            </tr>
          </thead>
          <tbody>
            {usage.byModel.map((row) => (
              <tr key={row.model} className="border-b border-line/60 last:border-b-0">
                <td className="px-3 py-1.5 text-fg-muted">{row.model}</td>
                <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">
                  {formatTokens(row.inputTokens)}
                </td>
                <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">
                  {formatTokens(row.outputTokens)}
                </td>
                <td className="px-3 py-1.5 text-right text-fg-faint tabular-nums">
                  {formatTokens(row.cacheReadTokens)}
                </td>
                <td className="px-3 py-1.5 text-right text-signal tabular-nums">
                  {row.costUsd !== null ? formatCostUsd(row.costUsd) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const sectionTitleClass =
  "mb-3 font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">{label}</dt>
      <dd className="font-mono text-base text-signal tabular-nums">{value}</dd>
    </div>
  );
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <th
      className={`px-3 py-2 font-medium tracking-[0.08em] uppercase ${className ?? ""}`.trim()}
      scope="col"
    >
      {children}
    </th>
  );
}
