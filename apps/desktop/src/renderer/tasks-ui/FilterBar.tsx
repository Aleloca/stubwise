import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useDepartments,
  useMilestones,
  usePeople,
  useProjects,
  useProjectStatuses,
} from "../data/queries";
import type {
  FilterCriteria,
  PeriodField,
  Person,
  RelativePeriod,
  StatusFamily,
  TaskSize,
} from "../data/types";
import { useViewer } from "../data/viewer";
import { canUseStatusIds } from "../domain/filters";
import {
  CheckItem,
  Chevron,
  Menu,
  MenuGroup,
  MenuNote,
  RadioItem,
  itemClass,
} from "./Menu";
import { Avatar } from "./PersonChip";
import { FamilySign } from "./StatusLabel";
import { formatDue } from "./TaskRow";

type Criterion =
  | "project"
  | "status"
  | "assignee"
  | "department"
  | "size"
  | "milestone"
  | "stalled"
  | "period";

const ALL: Criterion[] = [
  "project",
  "status",
  "assignee",
  "department",
  "size",
  "milestone",
  "stalled",
  "period",
];
/** Sempre in vista anche vuoti: i due criteri che si usano di più. */
const ALWAYS: Criterion[] = ["status", "assignee"];

const FAMILIES: StatusFamily[] = ["todo", "active", "closed"];
const SIZES: TaskSize[] = ["XS", "S", "M", "L", "XL"];
const PERIOD_FIELDS: PeriodField[] = ["created", "closed", "plannedWeek", "due"];
const PRESETS: RelativePeriod[] = [
  "last7",
  "last30",
  "thisWeek",
  "nextWeek",
  "thisMonth",
  "lastMonth",
];

/** Le chiavi dei criteri che un chip governa (per toglierlo). */
const KEYS: Record<Criterion, (keyof FilterCriteria)[]> = {
  project: ["projectIds"],
  status: ["families", "statusIds"],
  assignee: ["assigneeIds"],
  department: ["departmentIds"],
  size: ["sizes"],
  milestone: ["milestoneIds"],
  stalled: ["stalled"],
  period: ["period"],
};

function isSet(c: Criterion, v: FilterCriteria): boolean {
  return KEYS[c].some((k) => {
    const x = v[k];
    return Array.isArray(x) ? x.length > 0 : x !== undefined;
  });
}

/** Toglie le chiavi vuote: un elenco vuoto non filtra, quindi non si scrive. */
function clean(v: FilterCriteria): FilterCriteria {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || (Array.isArray(x) && x.length === 0)) continue;
    if (k === "text" && typeof x === "string" && x === "") continue;
    out[k] = x;
  }
  return out as FilterCriteria;
}

function toggle<T>(list: T[] | undefined, item: T): T[] {
  const l = list ?? [];
  return l.includes(item) ? l.filter((x) => x !== item) : [...l, item];
}

// --- chip ----------------------------------------------------------------------

function Cross() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

/**
 * Un criterio: «Status» quando è vuoto, «Status: In progress +1» quando è
 * impostato (contorno più forte e fondo d'inchiostro al 6%), con la × per
 * toglierlo. Il menu si apre sotto.
 */
function Chip({
  name,
  summary,
  open,
  onOpenChange,
  onRemove,
  children,
}: {
  name: string;
  summary: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const button = useRef<HTMLButtonElement>(null);
  const active = summary !== null && summary !== undefined;
  return (
    <div className="relative">
      <span
        className={`flex h-7 items-stretch rounded-md border text-sm transition-colors duration-[var(--duration-fast)] ease-out ${active ? "border-rule-strong bg-ink/6 text-ink" : "border-rule text-ink-muted hover:border-rule-strong hover:text-ink"}`}
      >
        <button
          ref={button}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-2.5"
        >
          <span className={active ? "text-ink-muted" : undefined}>
            {name}
            {active && ":"}
          </span>
          {active && <span className="max-w-48 truncate font-medium">{summary}</span>}
          <Chevron />
        </button>
        {active && onRemove && (
          <button
            type="button"
            aria-label={t("taskUi.filters.remove", { criterion: name })}
            title={t("taskUi.filters.remove", { criterion: name })}
            onClick={onRemove}
            className="grid w-7 place-items-center rounded-r-md border-l border-rule text-ink-muted hover:bg-ink/6 hover:text-ink"
          >
            <Cross />
          </button>
        )}
      </span>
      {open && (
        <Menu
          label={name}
          onClose={(restore) => {
            onOpenChange(false);
            if (restore) button.current?.focus();
          }}
        >
          {children}
        </Menu>
      )}
    </div>
  );
}

/** «In progress» o «In progress +2»: il primo valore, poi quanti altri. */
function useSummary() {
  const { t } = useTranslation();
  return (names: (string | undefined)[]): string | null => {
    const list = names.filter((n): n is string => !!n);
    if (list.length === 0) return null;
    return list.length === 1
      ? list[0]!
      : t("taskUi.filters.more", { first: list[0], count: list.length - 1 });
  };
}

// --- criteri ---------------------------------------------------------------------

interface CriterionProps {
  value: FilterCriteria;
  update: (patch: Partial<FilterCriteria>) => void;
  /** Il progetto unico (bloccato o scelto), se c'è. */
  singleProjectId: string | undefined;
}

/** Gli stati precisi del progetto unico: montato solo quando servono, per non leggerli invano. */
function ExactStatuses({ value, update, singleProjectId }: CriterionProps & { singleProjectId: string }) {
  const { t } = useTranslation();
  const statuses = useProjectStatuses(singleProjectId).data;
  const code = useProjects().data?.find((p) => p.id === singleProjectId)?.code ?? "";
  return (
    <MenuGroup label={t("taskUi.filters.statusesIn", { code })}>
      {statuses ? (
        statuses.map((s) => (
          <CheckItem
            key={s.id}
            checked={value.statusIds?.includes(s.id) ?? false}
            onToggle={() => update({ statusIds: toggle(value.statusIds, s.id) })}
          >
            <FamilySign family={s.family} />
            <span className="truncate">{s.name}</span>
          </CheckItem>
        ))
      ) : (
        <MenuNote>{t("taskUi.filters.loading")}</MenuNote>
      )}
    </MenuGroup>
  );
}

function ExactStatusNames({ ids, projectId }: { ids: string[]; projectId: string }) {
  const statuses = useProjectStatuses(projectId).data;
  return <>{ids.map((id) => statuses?.find((s) => s.id === id)?.name).filter(Boolean).join(", ")}</>;
}

function useStatusSummary(value: FilterCriteria, singleProjectId: string | undefined): ReactNode {
  const { t } = useTranslation();
  const summary = useSummary();
  const families = summary((value.families ?? []).map((f) => t(`taskUi.families.${f}`)));
  const statusIds = value.statusIds ?? [];
  if (statusIds.length > 0 && singleProjectId) {
    return (
      <>
        {families && `${families}, `}
        <ExactStatusNames ids={statusIds} projectId={singleProjectId} />
      </>
    );
  }
  return families;
}

function StatusMenu({ value, update, singleProjectId }: CriterionProps) {
  const { t } = useTranslation();
  return (
    <>
      <MenuGroup label={t("taskUi.filters.statusFamilies")}>
        {FAMILIES.map((f) => (
          <CheckItem
            key={f}
            checked={value.families?.includes(f) ?? false}
            onToggle={() => update({ families: toggle(value.families, f) })}
          >
            <FamilySign family={f} />
            {t(`taskUi.families.${f}`)}
          </CheckItem>
        ))}
      </MenuGroup>
      {singleProjectId ? (
        <ExactStatuses value={value} update={update} singleProjectId={singleProjectId} />
      ) : (
        <MenuGroup>
          <MenuNote>{t("taskUi.filters.statusesNeedOneProject")}</MenuNote>
        </MenuGroup>
      )}
    </>
  );
}

/** Le persone da offrire: i membri del progetto unico (o tutti), chi guarda per primo, Claude in fondo. */
function useAssigneeOptions(singleProjectId: string | undefined): Person[] | undefined {
  const people = usePeople().data;
  const projects = useProjects().data;
  const me = useViewer().viewer.personId;
  if (!people) return undefined;
  const members = singleProjectId
    ? new Set(projects?.find((p) => p.id === singleProjectId)?.memberIds ?? [])
    : null;
  const rank = (p: Person) => (p.id === me ? 0 : p.isClaude ? 2 : 1);
  return people
    .filter((p) => !members || members.has(p.id) || p.id === me)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// --- barra ---------------------------------------------------------------------

function SearchSign() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
    >
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </svg>
  );
}

function PlusSign() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/**
 * La barra dei filtri di un insieme di task: un chip per criterio, ognuno col
 * suo menu. «Status» e «Assignee» sono sempre in vista; gli altri compaiono
 * quando hanno un valore o quando si aggiungono da «+ Filter». A destra la
 * ricerca per codice o titolo e «Clear filters».
 *
 * Con `lockedProjectId` (la pagina Tasks di un progetto) il criterio
 * progetto non c'è e quel progetto vale come scelto: gli stati precisi sono
 * offerti. Gli stati sono per progetto, quindi si offrono solo con un
 * progetto solo (`canUseStatusIds`); se i progetti diventano più d'uno, gli
 * stati precisi già scelti si tolgono. `value` e `onChange` non contengono
 * mai il progetto bloccato.
 */
export function FilterBar({
  value,
  onChange,
  lockedProjectId,
  compact = false,
}: {
  value: FilterCriteria;
  onChange: (criteria: FilterCriteria) => void;
  lockedProjectId?: string;
  /** In una colonna stretta (la vasca di Planning): la ricerca in testa, a tutta larghezza. */
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const summary = useSummary();
  const [open, setOpen] = useState<Criterion | "add" | null>(null);
  const [added, setAdded] = useState<Criterion[]>([]);
  // Il campo del periodo scelto prima di scegliere quando.
  const [periodField, setPeriodField] = useState<PeriodField>("created");
  const addButton = useRef<HTMLButtonElement>(null);

  const effective: FilterCriteria = lockedProjectId
    ? { ...value, projectIds: [lockedProjectId] }
    : value;
  const singleProjectId = canUseStatusIds(effective) ? effective.projectIds![0] : undefined;

  const projects = useProjects().data;
  const departments = useDepartments().data;
  const people = useAssigneeOptions(singleProjectId);
  const allPeople = usePeople().data;
  const milestones = useMilestones(singleProjectId).data;
  const me = useViewer().viewer.personId;
  const statusSummary = useStatusSummary(value, singleProjectId);

  function update(patch: Partial<FilterCriteria>) {
    const next = clean({ ...value, ...patch });
    const withLock = lockedProjectId ? { ...next, projectIds: [lockedProjectId] } : next;
    if (!canUseStatusIds(withLock)) delete next.statusIds;
    onChange(next);
  }

  function remove(c: Criterion) {
    const patch: Partial<FilterCriteria> = {};
    for (const k of KEYS[c]) patch[k] = undefined;
    update(patch);
    setAdded((a) => a.filter((x) => x !== c));
    setOpen(null);
  }

  const available = ALL.filter((c) => !(c === "project" && lockedProjectId));
  const shown = available.filter(
    (c) => ALWAYS.includes(c) || isSet(c, value) || added.includes(c),
  );
  const hidden = available.filter((c) => !shown.includes(c));
  const anySet = available.some((c) => isSet(c, value)) || !!value.text;

  const name = (c: Criterion) => t(`taskUi.filters.criteria.${c}`);
  const personName = (id: string) =>
    id === "none" ? t("taskUi.unassigned") : allPeople?.find((p) => p.id === id)?.name;

  const periodSummary = (): string | null => {
    const p = value.period;
    if (!p) return null;
    const field = t(`taskUi.filters.fields.${p.field}`);
    const when =
      p.kind === "relative"
        ? t(`taskUi.filters.presets.${p.preset}`)
        : t("taskUi.filters.periodAbsolute", {
            from: formatDue(p.from, i18n.language),
            to: formatDue(p.to, i18n.language),
          });
    return `${field} · ${when}`;
  };

  const summaries: Record<Criterion, ReactNode> = {
    project: summary(
      (value.projectIds ?? []).map((id) => projects?.find((p) => p.id === id)?.code),
    ),
    status: statusSummary,
    assignee: summary((value.assigneeIds ?? []).map(personName)),
    department: summary(
      (value.departmentIds ?? []).map((id) => departments?.find((d) => d.id === id)?.name),
    ),
    size: summary(
      (value.sizes ?? []).map((s) => (s === "none" ? t("taskUi.filters.noEstimate") : s)),
    ),
    milestone: summary(
      (value.milestoneIds ?? []).map((id) => milestones?.find((m) => m.id === id)?.name),
    ),
    stalled:
      value.stalled === undefined
        ? null
        : t(value.stalled ? "taskUi.filters.stalledOnly" : "taskUi.filters.notStalled"),
    period: periodSummary(),
  };

  const props: CriterionProps = { value, update, singleProjectId };

  const menus: Record<Criterion, () => ReactNode> = {
    project: () => (
      <MenuGroup>
        {(projects ?? []).map((p) => (
          <CheckItem
            key={p.id}
            checked={value.projectIds?.includes(p.id) ?? false}
            onToggle={() => update({ projectIds: toggle(value.projectIds, p.id) })}
          >
            <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em]">
              {p.code}
            </span>
            <span className="truncate">{p.name}</span>
          </CheckItem>
        ))}
      </MenuGroup>
    ),
    status: () => <StatusMenu {...props} />,
    assignee: () => (
      <MenuGroup>
        <CheckItem
          checked={value.assigneeIds?.includes("none") ?? false}
          onToggle={() => update({ assigneeIds: toggle(value.assigneeIds, "none") })}
        >
          <Avatar person={null} />
          {t("taskUi.unassigned")}
        </CheckItem>
        {(people ?? []).map((p) => (
          <CheckItem
            key={p.id}
            checked={value.assigneeIds?.includes(p.id) ?? false}
            onToggle={() => update({ assigneeIds: toggle(value.assigneeIds, p.id) })}
          >
            <Avatar person={p} />
            <span className="truncate">
              {p.id === me ? t("taskUi.filters.you", { name: p.name }) : p.name}
            </span>
          </CheckItem>
        ))}
      </MenuGroup>
    ),
    department: () => (
      <MenuGroup>
        {(departments ?? []).map((d) => (
          <CheckItem
            key={d.id}
            checked={value.departmentIds?.includes(d.id) ?? false}
            onToggle={() => update({ departmentIds: toggle(value.departmentIds, d.id) })}
          >
            <span
              aria-hidden="true"
              className="h-3 w-[3px] shrink-0 rounded-[1px]"
              style={{ background: `var(${d.colorToken})` }}
            />
            {d.name}
          </CheckItem>
        ))}
      </MenuGroup>
    ),
    size: () => (
      <MenuGroup>
        {[...SIZES, "none" as const].map((s) => (
          <CheckItem
            key={s}
            checked={value.sizes?.includes(s) ?? false}
            onToggle={() => update({ sizes: toggle(value.sizes, s) })}
          >
            {s === "none" ? t("taskUi.filters.noEstimate") : s}
          </CheckItem>
        ))}
      </MenuGroup>
    ),
    milestone: () => (
      <MenuGroup>
        {milestones && milestones.length === 0 && (
          <MenuNote>{t("taskUi.filters.noMilestones")}</MenuNote>
        )}
        {(milestones ?? []).map((m) => (
          <CheckItem
            key={m.id}
            checked={value.milestoneIds?.includes(m.id) ?? false}
            onToggle={() => update({ milestoneIds: toggle(value.milestoneIds, m.id) })}
          >
            {!singleProjectId && (
              <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em]">
                {projects?.find((p) => p.id === m.projectId)?.code}
              </span>
            )}
            <span className="truncate">{m.name}</span>
          </CheckItem>
        ))}
      </MenuGroup>
    ),
    stalled: () => (
      <MenuGroup>
        <RadioItem checked={value.stalled === true} onSelect={() => update({ stalled: true })}>
          {t("taskUi.filters.stalledOnly")}
        </RadioItem>
        <RadioItem checked={value.stalled === false} onSelect={() => update({ stalled: false })}>
          {t("taskUi.filters.notStalled")}
        </RadioItem>
      </MenuGroup>
    ),
    period: () => {
      const field = value.period?.field ?? periodField;
      const preset = value.period?.kind === "relative" ? value.period.preset : undefined;
      return (
        <>
          <MenuGroup label={t("taskUi.filters.periodField")}>
            {PERIOD_FIELDS.map((f) => (
              <RadioItem
                key={f}
                checked={field === f}
                onSelect={() => {
                  setPeriodField(f);
                  if (value.period) update({ period: { ...value.period, field: f } });
                }}
              >
                {t(`taskUi.filters.fields.${f}`)}
              </RadioItem>
            ))}
          </MenuGroup>
          <MenuGroup label={t("taskUi.filters.periodRange")}>
            {PRESETS.map((p) => (
              <RadioItem
                key={p}
                checked={preset === p}
                onSelect={() => update({ period: { field, kind: "relative", preset: p } })}
              >
                {t(`taskUi.filters.presets.${p}`)}
              </RadioItem>
            ))}
          </MenuGroup>
        </>
      );
    },
  };

  return (
    <div
      role="group"
      aria-label={t("taskUi.filters.label")}
      className="flex flex-wrap items-center gap-2"
    >
      {shown.map((c) => (
        <Chip
          key={c}
          name={name(c)}
          summary={summaries[c]}
          open={open === c}
          onOpenChange={(o) => setOpen(o ? c : null)}
          onRemove={() => remove(c)}
        >
          {menus[c]()}
        </Chip>
      ))}
      {hidden.length > 0 && (
        <div className="relative">
          <button
            ref={addButton}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open === "add"}
            aria-label={t("taskUi.filters.addLabel")}
            onClick={() => setOpen(open === "add" ? null : "add")}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/6"
          >
            <PlusSign />
            {t("taskUi.filters.add")}
          </button>
          {open === "add" && (
            <Menu
              label={t("taskUi.filters.addLabel")}
              onClose={(restore) => {
                setOpen(null);
                if (restore) addButton.current?.focus();
              }}
            >
              {hidden.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() => {
                    setAdded((a) => [...a, c]);
                    setOpen(c);
                  }}
                  className={itemClass}
                >
                  {name(c)}
                </button>
              ))}
            </Menu>
          )}
        </div>
      )}
      <div className={`flex items-center gap-2 ${compact ? "order-first w-full" : "ml-auto"}`}>
        {anySet && (
          <button
            type="button"
            onClick={() => {
              onChange({});
              setAdded([]);
            }}
            className="h-7 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
          >
            {t("taskUi.filters.clear")}
          </button>
        )}
        <span className={`relative ${compact ? "order-first min-w-0 flex-1" : ""}`}>
          <SearchSign />
          <input
            type="search"
            value={value.text ?? ""}
            onChange={(e) => update({ text: e.target.value || undefined })}
            aria-label={t("taskUi.filters.search")}
            placeholder={t("taskUi.filters.searchPlaceholder")}
            className={`h-7 ${compact ? "w-full" : "w-48"} rounded-md border border-rule bg-transparent pr-2 pl-8 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-ink-faint hover:border-rule-strong focus:border-rule-strong`}
          />
        </span>
      </div>
    </div>
  );
}
