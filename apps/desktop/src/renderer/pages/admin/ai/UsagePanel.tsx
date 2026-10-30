import { useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../../data/dates";
import {
  OTHER_PROJECTS_KEY,
  useUsage,
  type UsageDimension,
  type UsageRange,
  type UsageRow,
  type UsageView,
} from "../../../data/queries";
import { Segmented, selectClass, smallInput } from "../../automations/builder/controls";
import { ChevronGlyph } from "../../preferences/glyphs";
import { ReadError } from "../../preferences/parts";
import { niceCeil } from "../../servers/MetricsCharts";
import { smallSecondary } from "../../task/parts";
import { AiSkeleton, usd } from "./parts";

// Usage (shape admin-ai.md «Usage», area 9b Task 9): quanto è costato Claude
// in un periodo, in una schermata. Periodo nell'indirizzo (`range`, e
// `from`/`to` per l'intervallo libero), cinque totali, la serie per giorno
// (colonne in inchiostro, leggibile senza colore: al passaggio, da tastiera
// e in tabella), la tabella per dimensione con la seconda dimensione
// (`group`/`then`) che si apre in posto. R-G5 lo fa il livello dati: la
// pagina legge la riga «other» e le dà il suo nome, senza ricalcolare chi
// vede cosa.

const PERIODS = ["7d", "30d", "90d", "month", "custom"] as const;
type Period = (typeof PERIODS)[number];
const DIMENSIONS: readonly UsageDimension[] = ["day", "model", "project", "provider", "operation"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

interface UsageSearch {
  range?: string;
  from?: string;
  to?: string;
  group?: string;
  then?: string;
}

/** Il periodo e le dimensioni dall'indirizzo; un valore che non si riconosce torna al suo default. */
function readSearch(search: UsageSearch, today: string) {
  const period: Period = (PERIODS as readonly string[]).includes(search.range ?? "")
    ? (search.range as Period)
    : "30d";
  const from = DAY_RE.test(search.from ?? "") ? search.from! : addDays(today, -29);
  const to = DAY_RE.test(search.to ?? "") ? search.to! : today;
  const group = DIMENSIONS.includes(search.group as UsageDimension)
    ? (search.group as UsageDimension)
    : "project";
  const then =
    DIMENSIONS.includes(search.then as UsageDimension) && search.then !== group
      ? (search.then as UsageDimension)
      : undefined;
  return { period, from, to, group, then };
}

function rangeOf(period: Period, from: string, to: string): UsageRange {
  if (period === "month") return { month: true };
  if (period === "custom") return from <= to ? { from, to } : { from: to, to: from };
  return { days: Number(period.slice(0, -1)) as 7 | 30 | 90 };
}

/** Le cifre della scheda: dollari con due decimali, interi raggruppati, date brevi. */
function useFormat() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const cents = new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = new Intl.NumberFormat(lang);
  const date = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", timeZone: "UTC" });
  return {
    money: (n: number) => `$${cents.format(n)}`,
    count: (n: number) => whole.format(n),
    day: (day: string) => date.format(new Date(`${day}T00:00:00Z`)),
  };
}

export function UsagePanel() {
  const { t } = useTranslation();
  const today = now().slice(0, 10);
  const search = useSearch({ strict: false }) as UsageSearch;
  const navigate = useNavigate();
  const { period, from, to, group, then } = readSearch(search, today);
  const usage = useUsage({ range: rangeOf(period, from, to), groupBy: group, thenBy: then });

  const setSearch = (next: UsageSearch) =>
    void navigate({
      to: "/admin/$section",
      params: { section: "ai" },
      search: ((prev: Record<string, unknown>) => ({ ...prev, ...next })) as never,
    });

  return (
    <div data-testid="usage-panel" className="@container">
      <p className="max-w-[62ch] text-md text-pretty text-ink-muted">{t("admin.ai.usageIntro")}</p>
      <PeriodPicker
        period={period}
        from={from}
        to={to}
        today={today}
        onPeriod={(p) =>
          setSearch(
            p === "custom"
              ? { range: p, from, to }
              : { range: p, from: undefined, to: undefined },
          )
        }
        onDates={(dates) => setSearch(dates)}
      />
      {usage.isPending ? (
        <UsageSkeleton />
      ) : usage.isError ? (
        <ReadError message={t("admin.ai.usage.loadError")} onRetry={() => void usage.refetch()} />
      ) : (
        <UsageBody
          view={usage.data}
          group={group}
          then={then}
          onGroup={(g) => setSearch({ group: g, then: g === then ? undefined : then })}
          onThen={(d) => setSearch({ then: d })}
        />
      )}
    </div>
  );
}

function PeriodPicker({
  period,
  from,
  to,
  today,
  onPeriod,
  onDates,
}: {
  period: Period;
  from: string;
  to: string;
  today: string;
  onPeriod: (p: Period) => void;
  onDates: (d: { from?: string; to?: string }) => void;
}) {
  const { t } = useTranslation();
  const fromId = useId();
  const toId = useId();
  const date = `${smallInput} num h-7 w-auto py-0 text-sm`;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <Segmented<Period>
        label={t("admin.ai.usage.periodLabel")}
        value={period}
        options={PERIODS.map((p) => ({ value: p, label: t(`admin.ai.usage.periods.${p}`) }))}
        onChange={onPeriod}
      />
      {period === "custom" && (
        <span className="flex items-center gap-3 text-sm text-ink-muted">
          <span className="flex items-center gap-1.5">
            <label htmlFor={fromId}>{t("admin.ai.usage.from")}</label>
            <input
              id={fromId}
              type="date"
              value={from}
              max={to}
              onChange={(e) => DAY_RE.test(e.target.value) && onDates({ from: e.target.value })}
              className={date}
            />
          </span>
          <span className="flex items-center gap-1.5">
            <label htmlFor={toId}>{t("admin.ai.usage.to")}</label>
            <input
              id={toId}
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => DAY_RE.test(e.target.value) && onDates({ to: e.target.value })}
              className={date}
            />
          </span>
        </span>
      )}
    </div>
  );
}

const TOTALS = ["cost", "runs", "inputTokens", "outputTokens", "cacheReadTokens"] as const;

function UsageBody({
  view,
  group,
  then,
  onGroup,
  onThen,
}: {
  view: UsageView;
  group: UsageDimension;
  then: UsageDimension | undefined;
  onGroup: (g: UsageDimension) => void;
  onThen: (d: UsageDimension | undefined) => void;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const value: Record<(typeof TOTALS)[number], string> = {
    cost: f.money(view.totals.costUsd),
    runs: f.count(view.totals.runs),
    inputTokens: f.count(view.totals.inputTokens),
    outputTokens: f.count(view.totals.outputTokens),
    cacheReadTokens: f.count(view.totals.cacheReadTokens),
  };
  const empty = view.totals.runs === 0;
  return (
    <>
      {/* I cinque totali: in fila a tutta larghezza, 3 + 2 quando lo spazio è poco. */}
      <ul
        aria-label={t("admin.ai.usage.totalsLabel")}
        className="mt-6 grid grid-cols-3 gap-x-6 gap-y-4 border-t border-rule pt-5 @min-[820px]:grid-cols-5"
      >
        {TOTALS.map((k) => (
          <li key={k} className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-ink-muted">{t(`admin.ai.usage.totals.${k}`)}</span>
            <span data-total className="num truncate text-xl font-semibold text-ink">
              {value[k]}
            </span>
          </li>
        ))}
      </ul>
      {empty ? (
        <p className="mt-6 text-md text-ink-muted">{t("admin.ai.usage.empty")}</p>
      ) : (
        <>
          <PerDay days={view.byDay} />
          <DimensionTable view={view} group={group} then={then} onGroup={onGroup} onThen={onThen} />
        </>
      )}
    </>
  );
}

/**
 * Ogni quante colonne un'etichetta di data: ogni giorno su una settimana,
 * poi ogni settimana; oltre le otto settimane ogni due (o più), perché a
 * 1024 le date settimanali di 90 giorni si toccano.
 */
function labelStep(n: number): number {
  if (n <= 8) return 1;
  return 7 * Math.max(1, Math.ceil(n / 7 / 8));
}

/**
 * La serie per giorno (skill dataviz): un istogramma a colonne, una sola
 * serie in inchiostro, asse y in $ con tre tacche, date ogni settimana.
 * Passaggio o fuoco (←/→, Home/End) su una colonna → «Oct 28 · $14.20 ·
 * 46 runs»; «Show as table» apre la stessa serie in tabella.
 */
function PerDay({ days }: { days: UsageView["byDay"] }) {
  const { t } = useTranslation();
  const f = useFormat();
  const [cursor, setCursor] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const tableId = useId();
  const max = niceCeil(Math.max(...days.map((d) => d.costUsd)));
  const ticks = [max, max / 2, 0];
  const step = labelStep(days.length);
  const n = days.length;
  const point = cursor === null ? null : days[cursor];

  function onKeyDown(e: KeyboardEvent) {
    const at = cursor ?? n;
    const next =
      e.key === "ArrowLeft"
        ? Math.max(0, at - 1)
        : e.key === "ArrowRight"
          ? Math.min(n - 1, cursor === null ? n - 1 : at + 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : e.key === "Escape"
                ? null
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setCursor(next);
  }

  // La nota resta dentro il grafico anche sulle colonne ai bordi.
  const edge = cursor === null ? 0 : (cursor + 0.5) / n;
  const shift = edge < 0.15 ? "0%" : edge > 0.85 ? "-100%" : "-50%";

  return (
    <section aria-labelledby={titleId} className="mt-8">
      <h2 id={titleId} className="text-md font-semibold text-ink">
        {t("admin.ai.usage.perDay")}
      </h2>
      <div
        role="group"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setCursor(null)}
        className="mt-3 rounded-sm"
      >
        <div className="flex">
          {/* Asse y: tre tacche in dollari. */}
          <div aria-hidden="true" className="relative h-40 w-12 shrink-0">
            {ticks.map((v) => (
              <span
                key={v}
                style={{ bottom: `${(v / max) * 100}%` }}
                className="num absolute right-2 translate-y-1/2 text-xs text-ink-muted"
              >
                {usd(v)}
              </span>
            ))}
          </div>
          <div className="relative h-40 min-w-0 flex-1" onMouseLeave={() => setCursor(null)}>
            {ticks.map((v) => (
              <span
                key={v}
                aria-hidden="true"
                style={{ bottom: `${(v / max) * 100}%` }}
                className={`absolute inset-x-0 border-t ${v === 0 ? "border-rule-strong" : "border-rule"}`}
              />
            ))}
            <div className="absolute inset-0 flex items-stretch gap-px">
              {days.map((d, i) => (
                <div
                  key={d.day}
                  data-day={d.day}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex min-w-0 flex-1 items-end rounded-t-[2px] ${cursor === i ? "bg-ink/6" : ""}`}
                >
                  <span
                    style={{ height: `${(d.costUsd / max) * 100}%` }}
                    className={`block w-full rounded-t-[2px] transition-colors duration-[var(--duration-fast)] ease-out ${
                      cursor === i ? "bg-ink" : "bg-ink/55"
                    }`}
                  />
                </div>
              ))}
            </div>
            {/* La nota della colonna: sempre nel DOM, così anche la tastiera la fa leggere. */}
            <p
              aria-live="polite"
              style={{ left: `${edge * 100}%`, transform: `translate(${shift}, -100%)` }}
              className={`num pointer-events-none absolute -top-1 rounded-md border border-rule bg-surface px-2 py-1 text-sm whitespace-nowrap text-ink shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)] ${point ? "" : "invisible"}`}
            >
              {point
                ? t("admin.ai.usage.point", {
                    day: f.day(point.day),
                    cost: f.money(point.costUsd),
                    runs: t("admin.ai.usage.runs", { count: point.runs }),
                  })
                : ""}
            </p>
          </div>
        </div>
        {/* Asse x: le date, ancorate all'ultimo giorno; ai bordi non escono dal grafico. */}
        <div aria-hidden="true" className="relative ml-12 h-5">
          {days.map((d, i) => {
            if ((n - 1 - i) % step !== 0) return null;
            const at = (i + 0.5) / n;
            const right = at > 0.96;
            return (
              <span
                key={d.day}
                style={right ? { right: 0 } : { left: `${at * 100}%` }}
                className={`num absolute top-1 text-xs whitespace-nowrap text-ink-muted ${
                  right || at < 0.04 ? "" : "-translate-x-1/2"
                }`}
              >
                {f.day(d.day)}
              </span>
            );
          })}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          aria-expanded={table}
          aria-controls={tableId}
          onClick={() => setTable((v) => !v)}
          className={smallSecondary}
        >
          {table ? t("admin.ai.usage.hideTable") : t("admin.ai.usage.showTable")}
        </button>
        <p id={hintId} className="text-xs text-ink-muted">
          {t("admin.ai.usage.perDayHint")}
        </p>
      </div>
      {table && (
        <div id={tableId} className="mt-3 max-h-[min(480px,60vh)] max-w-[420px] overflow-y-auto">
          <table aria-labelledby={titleId} className="w-full text-sm">
            <thead className="sticky top-0 bg-ground">
              <tr className="border-b border-rule text-left text-xs text-ink-muted">
                <th scope="col" className="py-1.5 font-medium">
                  {t("admin.ai.usage.columns.day")}
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  {t("admin.ai.usage.columns.cost")}
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  {t("admin.ai.usage.columns.runs")}
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-b border-rule">
                  <td className="num py-1.5 text-ink">{f.day(d.day)}</td>
                  <td className="num py-1.5 text-right text-ink">{f.money(d.costUsd)}</td>
                  <td className="num py-1.5 text-right text-ink">{f.count(d.runs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * La tabella per dimensione: «Group by [Project ▾] then by [— ▾]», colonne
 * Name · Cost · Tokens · Runs nell'ordine del livello dati (per costo,
 * «Other projects» in fondo). Con la seconda dimensione ogni riga si apre in
 * posto sui figli, rientrati di 16 px. Stretta, la colonna Tokens se ne va
 * (resta nel `title` della riga).
 */
function DimensionTable({
  view,
  group,
  then,
  onGroup,
  onThen,
}: {
  view: UsageView;
  group: UsageDimension;
  then: UsageDimension | undefined;
  onGroup: (g: UsageDimension) => void;
  onThen: (d: UsageDimension | undefined) => void;
}) {
  const { t } = useTranslation();
  const groupId = useId();
  const thenId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [shape, setShape] = useState(`${group}/${then ?? ""}`);
  // Un'altra dimensione: le righe aperte erano di un'altra tabella.
  if (shape !== `${group}/${then ?? ""}`) {
    setShape(`${group}/${then ?? ""}`);
    setOpen(new Set());
  }
  const dim = (d: UsageDimension) => t(`admin.ai.usage.dimensionsLower.${d}`);
  const label = then
    ? t("admin.ai.usage.tableLabelThen", { group: dim(group), then: dim(then) })
    : t("admin.ai.usage.tableLabel", { group: dim(group) });
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <label htmlFor={groupId}>{t("admin.ai.usage.groupBy")}</label>
        <select
          id={groupId}
          value={group}
          onChange={(e) => onGroup(e.target.value as UsageDimension)}
          className={`${selectClass} h-7 text-sm`}
        >
          {DIMENSIONS.map((d) => (
            <option key={d} value={d}>
              {t(`admin.ai.usage.dimensions.${d}`)}
            </option>
          ))}
        </select>
        <label htmlFor={thenId}>{t("admin.ai.usage.thenBy")}</label>
        <select
          id={thenId}
          value={then ?? ""}
          onChange={(e) => onThen((e.target.value || undefined) as UsageDimension | undefined)}
          className={`${selectClass} h-7 text-sm`}
        >
          <option value="">{t("admin.ai.usage.noThen")}</option>
          {DIMENSIONS.filter((d) => d !== group).map((d) => (
            <option key={d} value={d}>
              {t(`admin.ai.usage.dimensions.${d}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 max-h-[min(760px,70vh)] overflow-y-auto">
        <table aria-label={label} className="w-full table-fixed text-md">
          <thead className="sticky top-0 z-[1] bg-ground">
            <tr className="border-b border-rule text-left text-xs text-ink-muted">
              <th scope="col" className="py-2 font-medium">
                {t("admin.ai.usage.columns.name")}
              </th>
              <th scope="col" className="w-28 py-2 text-right font-medium">
                {t("admin.ai.usage.columns.cost")}
              </th>
              <th scope="col" className="hidden w-32 py-2 text-right font-medium @min-[820px]:table-cell">
                {t("admin.ai.usage.columns.tokens")}
              </th>
              <th scope="col" className="w-24 py-2 text-right font-medium">
                {t("admin.ai.usage.columns.runs")}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => {
              const key = String(row.key);
              const expanded = open.has(key);
              return (
                <Fragment key={key}>
                  <UsageTableRow
                    row={row}
                    dim={group}
                    name={
                      then ? (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => toggle(key)}
                          className="-ml-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left hover:text-ink"
                        >
                          <ChevronGlyph open={expanded} />
                          <RowName row={row} dim={group} />
                        </button>
                      ) : (
                        <RowName row={row} dim={group} />
                      )
                    }
                  />
                  {then &&
                    expanded &&
                    row.children.map((child) => (
                      <UsageTableRow
                        key={`${key}/${String(child.key)}`}
                        row={child}
                        dim={then}
                        child
                        name={<RowName row={child} dim={then} />}
                      />
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UsageTableRow({
  row,
  dim,
  name,
  child = false,
}: {
  row: UsageRow;
  dim: UsageDimension;
  name: ReactNode;
  child?: boolean;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const other = dim === "project" && row.key === OTHER_PROJECTS_KEY;
  const tone = other ? "text-ink-muted" : "text-ink";
  return (
    <tr
      title={t("admin.ai.usage.tokensTitle", { tokens: f.count(row.tokens) })}
      className={`border-b border-rule align-top ${child ? "text-sm" : ""}`}
    >
      <th scope="row" className={`min-w-0 py-2 text-left font-normal ${tone} ${child ? "pl-[34px]" : ""}`}>
        {name}
        {other && (
          <span className="mt-0.5 block text-xs text-ink-muted">
            {t("admin.ai.usage.otherProjectsHint")}
          </span>
        )}
      </th>
      <td className={`num py-2 text-right ${tone}`}>{f.money(row.costUsd)}</td>
      <td className={`num hidden py-2 text-right @min-[820px]:table-cell ${tone}`}>
        {f.count(row.tokens)}
      </td>
      <td className={`num py-2 text-right ${tone}`}>{f.count(row.runs)}</td>
    </tr>
  );
}

/** Il nome di una riga nella sua dimensione: le parole sono della pagina, i dati del livello dati. */
function RowName({ row, dim }: { row: UsageRow; dim: UsageDimension }) {
  const { t } = useTranslation();
  const f = useFormat();
  let text: string;
  if (dim === "project")
    text =
      row.key === null
        ? t("admin.ai.usage.noProject")
        : row.key === OTHER_PROJECTS_KEY
          ? t("admin.ai.usage.otherProjects")
          : row.code
            ? `${row.code} · ${row.label}`
            : row.label;
  else if (dim === "operation") text = t(`usage.operations.${row.key}`, { defaultValue: row.label });
  else if (dim === "day") text = row.key ? f.day(row.key) : row.label;
  else text = row.label;
  return <span className="block min-w-0 truncate">{text}</span>;
}

function UsageSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <div className="mt-6 grid grid-cols-3 gap-x-6 gap-y-4 border-t border-rule pt-5 @min-[820px]:grid-cols-5">
        {TOTALS.map((k) => (
          <div key={k} className="flex flex-col gap-2">
            <span className={`h-2.5 w-16 ${bar}`} />
            <span className={`h-5 w-20 ${bar}`} />
          </div>
        ))}
      </div>
      <div className={`mt-8 ml-12 h-40 ${bar}`} />
      <div className="mt-10">
        <AiSkeleton rows={6} height={36} />
      </div>
    </div>
  );
}
