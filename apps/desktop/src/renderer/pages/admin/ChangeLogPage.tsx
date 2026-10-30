import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TODAY, daysFromToday } from "../../data/dates";
import {
  useChangeFilterChoices,
  useChanges,
  type ChangeEntryView,
  type ChangeFilter,
  type ChangeFilterChoices,
} from "../../data/queries";
import { CHANGELOG_PERIODS, INSTANCE_ONLY, type ChangelogPeriod } from "../../data/routes";
import { inputClass } from "../../tasks-ui/Dialog";
import { Chip } from "../../tasks-ui/FilterBar";
import { MenuGroup, MenuNote, RadioItem } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { formatDate } from "../../notifications/time";
import { secondaryButton } from "../tasks/controls";
import { ChangeEntry } from "./ChangeEntry";

// Il registro delle modifiche in Amministrazione (shape admin-audit.md,
// `/admin/changelog`): h1, la riga in prosa (che dice cosa si vede, se chi
// guarda non ha `changelog.view`), la barra dei filtri — Person, Project,
// Type, Period, nell'indirizzo — e il giornale per giorni, più recenti in
// alto [AU 5]. Le scelte dei filtri vengono dal livello dati (R-G5: solo
// persone e progetti visibili, solo i gruppi che si leggono). Il registro di
// un progetto (`ProjectChangeLog`) riusa barra e giornale, senza Project.

/** I filtri come stanno nell'indirizzo. */
export interface ChangeLogSearch {
  actor?: string;
  project?: string;
  kind?: string;
  period?: string;
  since?: string;
  until?: string;
}

const PERIOD_DAYS: Record<Exclude<ChangelogPeriod, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const PERIOD_LABEL: Record<ChangelogPeriod, string> = {
  "7d": "last7",
  "30d": "last30",
  "90d": "last90",
  custom: "custom",
};

/**
 * Il filtro del livello dati dall'indirizzo. Un valore che non sta fra le
 * scelte (una persona o un progetto che chi guarda non vede, un gruppo che
 * non legge) si ignora: come se non esistesse (R-G5).
 */
export function filterOf(
  search: ChangeLogSearch,
  choices: ChangeFilterChoices | undefined,
  withProject: boolean,
): ChangeFilter {
  const filter: ChangeFilter = {};
  if (search.actor && choices?.people.some((p) => p.personId === search.actor))
    filter.personId = search.actor;
  if (withProject && search.project) {
    if (search.project === INSTANCE_ONLY) filter.projectId = null;
    else {
      const p = choices?.projects.find((x) => x.code === search.project);
      if (p) filter.projectId = p.projectId;
    }
  }
  if (search.kind && choices?.groups.includes(search.kind)) filter.group = search.kind;
  const period = search.period as ChangelogPeriod | undefined;
  if (period && period !== "custom" && period in PERIOD_DAYS) filter.withinDays = PERIOD_DAYS[period];
  if (period === "custom") {
    if (search.since) filter.from = `${search.since}T00:00:00Z`;
    if (search.until) filter.to = `${search.until}T23:59:59Z`;
  }
  return filter;
}

/** Lo stato del giornale: le scelte dei filtri e le voci, tutte e due lette. */
export function journalState(
  choices: { isError: boolean; data?: unknown },
  changes: { isError: boolean; isPending: boolean },
): "loading" | "error" | "ready" {
  if (choices.isError || changes.isError) return "error";
  if (!choices.data || changes.isPending) return "loading";
  return "ready";
}

const hasFilters = (s: ChangeLogSearch) =>
  !!(s.actor || s.project || s.kind || s.period || s.since || s.until);

export function ChangeLogPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ChangeLogSearch;
  const choices = useChangeFilterChoices();
  const set = (patch: Partial<ChangeLogSearch>) =>
    void navigate({
      to: ".",
      search: (prev: ChangeLogSearch) => ({ ...prev, ...patch }),
      replace: true,
    });
  const changes = useChanges(filterOf(search, choices.data, true));
  const groupWords = useListWords(choices.data?.groups ?? []);
  // Chi non ha `changelog.view` legge solo ciò che gestisce: la riga lo dice.
  const intro =
    !choices.data || choices.data.everything
      ? t("changelog.intro")
      : t("changelog.introPartial", { groups: groupWords });

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[880px]">
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">
          {t("admin.sections.changelog")}
        </h1>
        <p className="mt-2 max-w-[72ch] text-md text-pretty text-ink-muted">{intro}</p>
        <ChangeFilters
          search={search}
          choices={choices.data}
          withProject
          onChange={set}
        />
        <ChangeJournal
          state={journalState(choices, changes)}
          entries={changes.data ?? []}
          onRetry={() => void (choices.isError ? choices.refetch() : changes.refetch())}
          filtered={hasFilters(search)}
          onClear={() => set(CLEARED)}
          empty={t("changelog.nothing")}
          showProject
        />
      </div>
    </section>
  );
}

export const CLEARED: Partial<ChangeLogSearch> = {
  actor: undefined,
  project: undefined,
  kind: undefined,
  period: undefined,
  since: undefined,
  until: undefined,
};

/** «people and invites», «persone e inviti»: i gruppi in parole, nella lingua. */
function useListWords(groups: readonly string[]): string {
  const { t, i18n } = useTranslation();
  return new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
    groups.map((g) => t(`changelog.groupWords.${g}`, { defaultValue: g })),
  );
}

/** Un campo di ricerca in testa a un menu: prende il fuoco dopo il menu (che lo dà alla prima voce). */
function MenuSearch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  useEffect(() => input?.focus(), [input]);
  return (
    <input
      ref={setInput}
      type="search"
      value={value}
      aria-label={label}
      placeholder={label}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputClass} mb-1 h-7 py-0 text-sm`}
    />
  );
}

const folded = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** La barra dei filtri del registro: Person, (Project), Type, Period; «Clear filters» se ce n'è uno. */
export function ChangeFilters({
  search,
  choices,
  withProject,
  onChange,
}: {
  search: ChangeLogSearch;
  choices: ChangeFilterChoices | undefined;
  withProject: boolean;
  onChange: (patch: Partial<ChangeLogSearch>) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<null | "person" | "project" | "type" | "period">(null);
  const [find, setFind] = useState("");
  const toggle = (which: NonNullable<typeof open>) => (o: boolean) => {
    setOpen(o ? which : null);
    setFind("");
  };
  const people = choices?.people ?? [];
  const projects = choices?.projects ?? [];
  const groups = choices?.groups ?? [];
  const actor = people.find((p) => p.personId === search.actor);
  const project =
    search.project === INSTANCE_ONLY
      ? t("changelog.filters.instanceOnly")
      : (projects.find((p) => p.code === search.project)?.code ?? null);
  const kind = search.kind && groups.includes(search.kind) ? search.kind : null;
  const period = (CHANGELOG_PERIODS as readonly string[]).includes(search.period ?? "")
    ? (search.period as ChangelogPeriod)
    : null;
  const needle = folded(find.trim());
  const shownPeople = people.filter((p) => folded(p.name).includes(needle));
  const shownProjects = projects.filter((p) =>
    folded(`${p.code} ${p.name}`).includes(needle),
  );
  const close = () => setOpen(null);
  const periodSummary =
    period === "custom" && (search.since || search.until)
      ? t("changelog.filters.customRange", {
          from: search.since ? formatDate(`${search.since}T00:00:00Z`, i18n.language) : "…",
          to: search.until ? formatDate(`${search.until}T00:00:00Z`, i18n.language) : "…",
        })
      : period
        ? t(`changelog.filters.${PERIOD_LABEL[period]}`)
        : null;

  return (
    <div
      role="group"
      aria-label={t("changelog.filters.label")}
      className="mt-5 flex flex-wrap items-center gap-2"
    >
      <Chip
        name={t("changelog.filters.person")}
        summary={actor?.name ?? null}
        open={open === "person"}
        onOpenChange={toggle("person")}
        onRemove={() => onChange({ actor: undefined })}
      >
        <MenuSearch value={find} onChange={setFind} label={t("changelog.filters.findPerson")} />
        {shownPeople.length === 0 && <MenuNote>{t("changelog.filters.noPeople")}</MenuNote>}
        {shownPeople.map((p) => (
          <RadioItem
            key={p.personId}
            checked={p.personId === search.actor}
            onSelect={() => {
              onChange({ actor: p.personId });
              close();
            }}
          >
            {p.name}
          </RadioItem>
        ))}
      </Chip>
      {withProject && (
        <Chip
          name={t("changelog.filters.project")}
          summary={project}
          open={open === "project"}
          onOpenChange={toggle("project")}
          onRemove={() => onChange({ project: undefined })}
        >
          <MenuSearch value={find} onChange={setFind} label={t("changelog.filters.findProject")} />
          {!needle && (
            <RadioItem
              checked={search.project === INSTANCE_ONLY}
              onSelect={() => {
                onChange({ project: INSTANCE_ONLY });
                close();
              }}
            >
              {t("changelog.filters.instanceOnly")}
            </RadioItem>
          )}
          {shownProjects.length === 0 && (
            <MenuNote>{t("changelog.filters.noProjects")}</MenuNote>
          )}
          {shownProjects.map((p) => (
            <RadioItem
              key={p.projectId}
              checked={p.code === search.project}
              onSelect={() => {
                onChange({ project: p.code });
                close();
              }}
            >
              <span className="num w-9 shrink-0 font-semibold">{p.code}</span>
              <span className="min-w-0 truncate text-ink-muted">{p.name}</span>
            </RadioItem>
          ))}
        </Chip>
      )}
      <Chip
        name={t("changelog.filters.type")}
        summary={kind ? t(`changelog.groups.${kind}`, { defaultValue: kind }) : null}
        open={open === "type"}
        onOpenChange={toggle("type")}
        onRemove={() => onChange({ kind: undefined })}
      >
        {groups.map((g) => (
          <RadioItem
            key={g}
            checked={g === kind}
            onSelect={() => {
              onChange({ kind: g });
              close();
            }}
          >
            {t(`changelog.groups.${g}`, { defaultValue: g })}
          </RadioItem>
        ))}
      </Chip>
      <Chip
        name={t("changelog.filters.period")}
        summary={periodSummary}
        open={open === "period"}
        onOpenChange={toggle("period")}
        onRemove={() => onChange({ period: undefined, since: undefined, until: undefined })}
      >
        <MenuGroup>
          {CHANGELOG_PERIODS.map((p) => (
            <RadioItem
              key={p}
              checked={p === period}
              onSelect={() => {
                onChange(
                  p === "custom"
                    ? { period: p, since: search.since ?? daysFromToday(-30), until: search.until ?? TODAY }
                    : { period: p, since: undefined, until: undefined },
                );
                close();
              }}
            >
              {t(`changelog.filters.${PERIOD_LABEL[p]}`)}
            </RadioItem>
          ))}
        </MenuGroup>
      </Chip>
      {period === "custom" && (
        <span className="flex items-center gap-2 text-sm text-ink-muted">
          <label className="flex items-center gap-1.5">
            {t("changelog.filters.from")}
            <input
              type="date"
              value={search.since ?? ""}
              max={search.until ?? undefined}
              onChange={(e) => onChange({ since: e.target.value || undefined })}
              className={`${inputClass} num h-7 w-auto py-0 text-sm`}
            />
          </label>
          <label className="flex items-center gap-1.5">
            {t("changelog.filters.to")}
            <input
              type="date"
              value={search.until ?? ""}
              min={search.since ?? undefined}
              onChange={(e) => onChange({ until: e.target.value || undefined })}
              className={`${inputClass} num h-7 w-auto py-0 text-sm`}
            />
          </label>
        </span>
      )}
      {hasFilters(search) && (
        <button
          type="button"
          onClick={() => onChange(CLEARED)}
          className="h-7 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          {t("changelog.filters.clear")}
        </button>
      )}
    </div>
  );
}

/** «TODAY», «YESTERDAY», «OCT 27»: il titolo di un giorno (il maiuscolo lo fa `heading-group`). */
function useDayLabel() {
  const { t, i18n } = useTranslation();
  return (day: string) => {
    if (day === TODAY) return t("changelog.days.today");
    if (day === daysFromToday(-1)) return t("changelog.days.yesterday");
    return formatDate(`${day}T00:00:00Z`, i18n.language);
  };
}

/** Lo scheletro: tre giorni, quattro voci ciascuno (shape §5). */
function JournalSkeleton() {
  const { t } = useTranslation();
  const widths = ["64%", "48%", "72%", "56%"];
  return (
    <div aria-busy="true" className="skeleton-breathe mt-3 border-t border-rule">
      <span role="status" className="sr-only">
        {t("changelog.loading")}
      </span>
      {[0, 1, 2].map((d) => (
        <div key={d} className="pt-4">
          <span className="block h-2.5 w-16 rounded-sm bg-ink/8" />
          {widths.map((w, i) => (
            <div key={i} className="grid grid-cols-[48px_minmax(0,1fr)] gap-x-3 py-3.5">
              <span className="h-2.5 w-9 rounded-sm bg-ink/8" />
              <span className="h-2.5 rounded-sm bg-ink/8" style={{ width: w }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Il giornale: le voci per giorno, i titoli dei giorni agganciati in alto mentre si scorre. */
export function ChangeJournal({
  state,
  entries,
  onRetry,
  filtered,
  onClear,
  empty,
  showProject,
}: {
  state: "loading" | "error" | "ready";
  entries: ChangeEntryView[];
  onRetry: () => void;
  filtered: boolean;
  onClear: () => void;
  /** La frase del registro vuoto senza filtri. */
  empty: string;
  showProject: boolean;
}) {
  const { t } = useTranslation();
  const dayLabel = useDayLabel();
  if (state === "loading") return <JournalSkeleton />;
  if (state === "error")
    return (
      <div className="mt-3 border-t border-rule">
        <PageError message={t("changelog.error")} onRetry={onRetry} />
      </div>
    );
  if (entries.length === 0)
    return (
      <div className="mt-3 flex flex-col items-start gap-3 border-t border-rule py-8">
        <p className="text-md text-ink">{filtered ? t("changelog.noMatch") : empty}</p>
        {filtered && (
          <button type="button" className={secondaryButton} onClick={onClear}>
            {t("changelog.filters.clear")}
          </button>
        )}
      </div>
    );
  const days: { day: string; entries: ChangeEntryView[] }[] = [];
  for (const e of entries) {
    const day = e.at.slice(0, 10);
    const last = days.at(-1);
    if (last?.day === day) last.entries.push(e);
    else days.push({ day, entries: [e] });
  }
  return (
    <div className="mt-3 border-t border-rule">
      {days.map(({ day, entries: list }) => (
        <DaySection key={day} label={dayLabel(day)} day={day}>
          {list.map((e) => (
            <li key={e.id} className="border-b border-rule last:border-b-0">
              <ChangeEntry entry={e} showProject={showProject} />
            </li>
          ))}
        </DaySection>
      ))}
    </div>
  );
}

function DaySection({ label, day, children }: { label: string; day: string; children: ReactNode }) {
  const { t } = useTranslation();
  const id = `changelog-day-${day}`;
  return (
    <section aria-labelledby={id} className="border-b border-rule last:border-b-0">
      <h2
        id={id}
        className="heading-group sticky top-0 z-[1] bg-ground pt-4 pb-1.5"
        aria-label={t("changelog.days.label", { day: label })}
      >
        {label}
      </h2>
      <ul>{children}</ul>
    </section>
  );
}
