import type { CalendarSeriesItem } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../lib/format";
import { calendarSeriesQueryOptions } from "../lib/queries";
import { CollapsibleSection } from "./collapsible-section";
import { SeriesConfig } from "./calendar-detail-panel";

/**
 * «Serie ricorrenti» nella colonna sinistra (fix di review, fase 9 Task 2).
 *
 * Spostando la configurazione di una serie nel pannello di dettaglio (Task
 * 7), una serie le cui occorrenze cadono TUTTE fuori da [-30gg, +60gg] non
 * era più raggiungibile da nessuna vista: il dato restava (`GET /series` non
 * filtra per finestra), ma non c'era un punto d'accesso nella UI. Il caso
 * peggiore non era non poterla ACCENDERE: era non poterla SPEGNERE se è
 * accesa con `auto: true`.
 *
 * Richiudibile e chiusa di default (`CollapsibleSection`): i dati sono già
 * sulla pagina (il loader li prefetcha), ma il blocco non deve costare uno
 * spazio fisso in una colonna stretta per qualcosa che, nella grande
 * maggioranza delle sessioni, resta inerte.
 */
export function CalendarSeriesSidebar({ projects }: { projects: { id: string; name: string }[] }) {
  const { t } = useTranslation();
  const seriesQuery = useQuery(calendarSeriesQueryOptions());
  const items = seriesQuery.data?.items ?? [];

  return (
    <CollapsibleSection title={t("calendar:series.heading")} meta={items.length > 0 ? String(items.length) : undefined}>
      {seriesQuery.isPending ? (
        <div aria-hidden="true" className="h-16 rounded-sm border border-dashed border-line-strong" />
      ) : items.length === 0 ? (
        <p className="font-mono text-[11px] text-fg-faint">{t("calendar:series.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <SeriesSidebarRow key={`${item.accountId}-${item.recurringEventId}`} item={item} projects={projects} />
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}

function SeriesSidebarRow({ item, projects }: { item: CalendarSeriesItem; projects: { id: string; name: string }[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="rounded-sm border border-line/70">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full min-h-9 items-center justify-between gap-2 px-2 py-1.5 text-left transition-colors hover:bg-ink-850"
      >
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
          {item.title ?? t("mail:noSubject")}
        </span>
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${
            item.enabled ? "border-signal-dim/50 bg-ink-850 text-signal" : "border-line bg-ink-850 text-fg-faint"
          }`}
        >
          {item.enabled ? t("calendar:series.on") : t("calendar:series.off")}
        </span>
      </button>
      <p className="px-2 pb-1.5 font-mono text-[10px] text-fg-faint">
        {t("calendar:series.occurrenceCount", { count: item.occurrenceCount })}
        {item.nextOccurrenceAt !== null
          ? ` · ${t("calendar:series.next", { when: formatRelativeTime(item.nextOccurrenceAt) })}`
          : ` · ${t("calendar:series.noneUpcoming")}`}
      </p>
      {expanded && (
        <div className="border-t border-line/70 p-2">
          <SeriesConfig accountId={item.accountId} recurringEventId={item.recurringEventId} projects={projects} />
        </div>
      )}
    </li>
  );
}
