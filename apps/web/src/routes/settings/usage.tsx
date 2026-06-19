import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AiUsageByDay,
  AiUsageByModel,
  AiUsageByProject,
  AiUsageByProvider,
} from "../../lib/api";
import { formatCostUsd, formatTokens } from "../../lib/format";
import {
  aiUsageCostsQueryOptions,
  USAGE_RANGE_DAYS,
  type UsageRangeDays,
} from "../../lib/queries";

/**
 * Sotto-pagina "Usage & costs" (solo admin): dashboard dei consumi AI nel
 * periodo selezionato (7/30/90 giorni). Totali, serie per giorno (barre CSS,
 * nessuna libreria chart) e ripartizioni per modello, progetto e provider.
 * I dati arrivano dall'aggregazione server-side di agent_runs; i costi NULL
 * contano 0. Usa useQuery (non suspense) così il cambio di range non sospende
 * tutta la pagina ma aggiorna in-place la sezione.
 */
export function SettingsUsagePage() {
  const { t } = useTranslation();
  const [days, setDays] = useState<UsageRangeDays>(30);
  const { data, isPending, isError, error } = useQuery(aiUsageCostsQueryOptions(days));

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("usage:title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("usage:subtitle")}</p>
        </div>
        <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
          <span className="text-fg-faint">{t("usage:range")}</span>
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value) as UsageRangeDays)}
            aria-label={t("usage:rangeLabel")}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          >
            {USAGE_RANGE_DAYS.map((value) => (
              <option key={value} value={value}>
                {t("usage:rangeDays", { count: value })}
              </option>
            ))}
          </select>
        </label>
      </header>

      {isError && (
        <p role="alert" className="px-4 py-6 font-mono text-[12px] text-danger">
          {error.message}
        </p>
      )}

      {isPending && !isError && (
        <p className="px-4 py-6 font-mono text-[12px] text-fg-faint">{t("usage:loading")}</p>
      )}

      {data && (
        <div className="flex flex-col gap-6 px-4 py-4">
          <Totals
            costUsd={data.totals.costUsd}
            inputTokens={data.totals.inputTokens}
            outputTokens={data.totals.outputTokens}
            cacheReadTokens={data.totals.cacheReadTokens}
            jobs={data.totals.jobs}
          />

          {data.totals.jobs === 0 ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("usage:empty")}</p>
          ) : (
            <>
              <ByDayChart rows={data.byDay} />
              <ByModelTable rows={data.byModel} />
              <ByProjectTable rows={data.byProject} />
              <ByProviderTable rows={data.byProvider} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Totals(props: {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  jobs: number;
}) {
  const { t } = useTranslation();
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3" data-testid="usage-totals">
      <Metric label={t("usage:totalCost")} value={formatCostUsd(props.costUsd)} />
      <Metric label={t("usage:totalInput")} value={formatTokens(props.inputTokens)} />
      <Metric label={t("usage:totalOutput")} value={formatTokens(props.outputTokens)} />
      <Metric label={t("usage:totalCache")} value={formatTokens(props.cacheReadTokens)} />
      <Metric label={t("usage:totalJobs")} value={formatTokens(props.jobs)} />
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">{label}</dt>
      <dd className="font-mono text-base text-signal tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Serie per giorno come barre CSS proporzionali al costo (con fallback ai
 * token quando tutti i costi sono 0): niente libreria di grafici, solo
 * larghezze percentuali. Ogni barra mostra giorno, costo e job.
 */
function ByDayChart({ rows }: { rows: AiUsageByDay[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const useCost = rows.some((r) => r.costUsd > 0);
  const max = Math.max(
    1,
    ...rows.map((r) => (useCost ? r.costUsd : r.inputTokens + r.outputTokens)),
  );

  return (
    <div>
      <h3 className={subTitleClass}>{t("usage:byDay")}</h3>
      <ul className="flex flex-col gap-1.5" data-testid="usage-by-day">
        {rows.map((row) => {
          const magnitude = useCost ? row.costUsd : row.inputTokens + row.outputTokens;
          const pct = Math.round((magnitude / max) * 100);
          return (
            <li key={row.day} className="flex items-center gap-3 font-mono text-[12px]">
              <span className="w-24 shrink-0 text-fg-faint tabular-nums">{row.day}</span>
              <span className="relative h-4 grow overflow-hidden rounded-sm bg-ink-950">
                <span
                  className="absolute inset-y-0 left-0 bg-signal-dim"
                  style={{ width: `${pct}%` }}
                  aria-hidden
                />
              </span>
              <span className="w-20 shrink-0 text-right text-signal tabular-nums">
                {formatCostUsd(row.costUsd)}
              </span>
              <span className="w-12 shrink-0 text-right text-fg-faint tabular-nums">
                {formatTokens(row.jobs)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ByModelTable({ rows }: { rows: AiUsageByModel[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <Table
      title={t("usage:byModel")}
      testId="usage-by-model"
      head={[
        { key: "model", label: t("usage:colLabel"), align: "left" },
        { key: "in", label: t("usage:tokensIn"), align: "right" },
        { key: "out", label: t("usage:tokensOut"), align: "right" },
        { key: "cache", label: t("usage:cache"), align: "right" },
        { key: "cost", label: t("usage:cost"), align: "right" },
      ]}
      rows={rows.map((row) => ({
        id: row.model,
        cells: [
          { key: "model", value: row.model, tone: "muted" },
          { key: "in", value: formatTokens(row.inputTokens), align: "right", tone: "muted" },
          { key: "out", value: formatTokens(row.outputTokens), align: "right", tone: "muted" },
          { key: "cache", value: formatTokens(row.cacheReadTokens), align: "right", tone: "faint" },
          { key: "cost", value: formatCostUsd(row.costUsd), align: "right", tone: "signal" },
        ],
      }))}
    />
  );
}

function ByProjectTable({ rows }: { rows: AiUsageByProject[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <Table
      title={t("usage:byProject")}
      testId="usage-by-project"
      head={[
        { key: "project", label: t("usage:colLabel"), align: "left" },
        { key: "in", label: t("usage:tokensIn"), align: "right" },
        { key: "out", label: t("usage:tokensOut"), align: "right" },
        { key: "cache", label: t("usage:cache"), align: "right" },
        { key: "cost", label: t("usage:cost"), align: "right" },
      ]}
      rows={rows.map((row) => ({
        id: row.projectId,
        cells: [
          { key: "project", value: row.projectName, tone: "muted" },
          { key: "in", value: formatTokens(row.inputTokens), align: "right", tone: "muted" },
          { key: "out", value: formatTokens(row.outputTokens), align: "right", tone: "muted" },
          { key: "cache", value: formatTokens(row.cacheReadTokens), align: "right", tone: "faint" },
          { key: "cost", value: formatCostUsd(row.costUsd), align: "right", tone: "signal" },
        ],
      }))}
    />
  );
}

function ByProviderTable({ rows }: { rows: AiUsageByProvider[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <Table
      title={t("usage:byProvider")}
      testId="usage-by-provider"
      head={[
        { key: "provider", label: t("usage:colLabel"), align: "left" },
        { key: "in", label: t("usage:tokensIn"), align: "right" },
        { key: "out", label: t("usage:tokensOut"), align: "right" },
        { key: "cache", label: t("usage:cache"), align: "right" },
        { key: "cost", label: t("usage:cost"), align: "right" },
      ]}
      rows={rows.map((row) => ({
        id: row.providerId ?? "__default__",
        cells: [
          { key: "provider", value: row.providerLabel ?? t("usage:defaultProvider"), tone: "muted" },
          { key: "in", value: formatTokens(row.inputTokens), align: "right", tone: "muted" },
          { key: "out", value: formatTokens(row.outputTokens), align: "right", tone: "muted" },
          { key: "cache", value: formatTokens(row.cacheReadTokens), align: "right", tone: "faint" },
          { key: "cost", value: formatCostUsd(row.costUsd), align: "right", tone: "signal" },
        ],
      }))}
    />
  );
}

const subTitleClass =
  "mb-2 font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";

type Align = "left" | "right";
type Tone = "muted" | "faint" | "signal";

interface HeadCell {
  key: string;
  label: string;
  align: Align;
}

interface BodyCell {
  /** Chiave stabile della cella, allineata alla colonna (head[i].key). */
  key: string;
  value: string;
  align?: Align;
  tone?: Tone;
}

interface BodyRow {
  id: string;
  cells: BodyCell[];
}

const TONE_CLASS: Record<Tone, string> = {
  muted: "text-fg-muted",
  faint: "text-fg-faint",
  signal: "text-signal",
};

/** Tabella generica control-room: intestazione + righe, allineamento per cella. */
function Table({
  title,
  testId,
  head,
  rows,
}: {
  title: string;
  testId: string;
  head: HeadCell[];
  rows: BodyRow[];
}) {
  return (
    <div>
      <h3 className={subTitleClass}>{title}</h3>
      <div className="overflow-x-auto rounded-sm border border-line">
        <table className="w-full border-collapse font-mono text-[12px]" data-testid={testId}>
          <thead>
            <tr className="border-b border-line text-fg-faint">
              {head.map((cell) => (
                <th
                  key={cell.key}
                  scope="col"
                  className={`px-3 py-2 font-medium tracking-[0.08em] uppercase ${
                    cell.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {cell.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line/60 last:border-b-0">
                {row.cells.map((cell) => (
                  <td
                    key={cell.key}
                    className={`px-3 py-1.5 tabular-nums ${
                      cell.align === "right" ? "text-right" : ""
                    } ${TONE_CLASS[cell.tone ?? "muted"]}`}
                  >
                    {cell.value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
