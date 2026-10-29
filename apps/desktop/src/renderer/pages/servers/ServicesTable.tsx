import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServerService } from "../../data/types";
import { fold } from "../../domain/textSearch";
import { bytes } from "./format";
import { SortGlyph, TroubleGlyph } from "./glyphs";
import { Part, shortInput } from "./Part";

// I servizi che l'agente vede (shape servers.md §3, «Services»): una
// tabella intera, ordinabile per colonna, con l'intestazione agganciata
// sotto l'indice. Da 20 righe un filtro. Nessuna azione sui servizi:
// Stubwise non riavvia né rilascia. 200 righe (RF 5): tutte, scorrono con
// la pagina. Sotto 1100 px utili la colonna Image sparisce e resta nel
// `title` del nome.

type Column = "name" | "source" | "state" | "cpu" | "memory" | "restarts" | "image";
const COLUMNS: readonly Column[] = [
  "name",
  "source",
  "state",
  "cpu",
  "memory",
  "restarts",
  "image",
];
const NUMERIC = new Set<Column>(["cpu", "memory", "restarts"]);
const FILTER_FROM = 20;

/** Uno stato che non è «in esecuzione» (docker `running`, pm2 `online`) va segnalato. */
const isRunning = (s: ServerService) => s.state === "running" || s.state === "online";

function valueOf(s: ServerService, c: Column): string | number {
  switch (c) {
    case "name":
      return s.name;
    case "source":
      return s.source;
    case "state":
      return s.state;
    case "cpu":
      return s.cpuPct ?? -1;
    case "memory":
      return s.memBytes ?? -1;
    case "restarts":
      return s.restarts ?? -1;
    case "image":
      return s.image ?? "";
  }
}

export function ServicesTable({ services }: { services: ServerService[] }) {
  const { t, i18n } = useTranslation();
  const filterId = useId();
  const [sort, setSort] = useState<{ column: Column; dir: "ascending" | "descending" }>({
    column: "name",
    dir: "ascending",
  });
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const needle = fold(q.trim());
    const shown = needle
      ? services.filter((s) =>
          [s.name, s.image ?? "", s.state].some((x) => fold(x).includes(needle)),
        )
      : services;
    const sign = sort.dir === "ascending" ? 1 : -1;
    return [...shown].sort((a, b) => {
      const va = valueOf(a, sort.column);
      const vb = valueOf(b, sort.column);
      const diff =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return sign * diff || a.name.localeCompare(b.name);
    });
  }, [services, q, sort]);
  const nf = (n: number, digits = 1) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: digits }).format(n);
  const toggle = (column: Column) =>
    setSort((s) =>
      s.column === column
        ? { column, dir: s.dir === "ascending" ? "descending" : "ascending" }
        : { column, dir: NUMERIC.has(column) ? "descending" : "ascending" },
    );

  return (
    <Part
      id="services"
      title={t("servers.index.services")}
      action={
        services.length >= FILTER_FROM ? (
          <span className="flex items-center gap-2">
            <label htmlFor={filterId} className="sr-only">
              {t("servers.services.filter")}
            </label>
            <input
              id={filterId}
              type="search"
              value={q}
              placeholder={t("servers.services.filter")}
              onChange={(e) => setQ(e.target.value)}
              className={`${shortInput} h-8 w-56`}
            />
          </span>
        ) : undefined
      }
    >
      {services.length === 0 ? (
        <p className="border-t border-rule py-3 pl-3 text-md text-ink-muted">
          {t("servers.services.empty")}
        </p>
      ) : (
        <table
          aria-label={t("servers.index.services")}
          className="w-full table-fixed border-collapse text-sm"
        >
          <colgroup>
            <col />
            <col className="w-20" />
            <col className="w-32" />
            <col className="w-16" />
            <col className="w-24" />
            <col className="w-20" />
            <col className="hidden w-[28%] @min-[1100px]:table-column" />
          </colgroup>
          <thead className="sticky top-8 z-[1] bg-ground">
            <tr className="border-y border-rule">
              {COLUMNS.map((c) => (
                <th
                  key={c}
                  scope="col"
                  aria-sort={sort.column === c ? sort.dir : "none"}
                  className={`h-8 px-2 font-medium text-ink-muted ${NUMERIC.has(c) ? "text-right" : "text-left"} ${c === "image" ? "hidden @min-[1100px]:table-cell" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(c)}
                    className="inline-flex items-center gap-1 rounded-sm hover:text-ink"
                  >
                    {t(`servers.services.columns.${c}`)}
                    {sort.column === c && <SortGlyph up={sort.dir === "ascending"} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="py-3 pl-2 text-md text-ink-muted">
                  {t("servers.services.noMatch", { q: q.trim() })}
                </td>
              </tr>
            ) : (
              rows.map((s) => (
                <tr
                  key={`${s.source}:${s.name}`}
                  data-service={s.name}
                  className="h-9 border-b border-rule"
                >
                  <td
                    className="truncate px-2 font-medium text-ink"
                    title={s.image ? `${s.name} · ${s.image}` : s.name}
                  >
                    {s.name}
                  </td>
                  <td className="px-2 text-ink-muted">
                    {t(`servers.services.source.${s.source}`)}
                  </td>
                  <td className="px-2">
                    <span className="flex items-center gap-1">
                      {!isRunning(s) && <TroubleGlyph />}
                      <span className={isRunning(s) ? "text-ink-muted" : "text-ink"}>
                        {s.state}
                      </span>
                    </span>
                  </td>
                  <td className="num px-2 text-right text-ink-muted">
                    {s.cpuPct === null ? "—" : `${nf(s.cpuPct)}%`}
                  </td>
                  <td className="num px-2 text-right text-ink-muted">
                    {s.memBytes === null ? "—" : bytes(s.memBytes, i18n.language)}
                  </td>
                  <td className="num px-2 text-right text-ink-muted">{s.restarts ?? "—"}</td>
                  <td
                    className="hidden truncate px-2 text-xs text-ink-muted @min-[1100px]:table-cell"
                    title={s.image}
                  >
                    {s.image ?? ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </Part>
  );
}
