import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  usePeople,
  usePinnedFilters,
  useSavedFilters,
  useSetFilterPinned,
  useTasks,
} from "../../data/queries";
import type { SavedFilter } from "../../data/types";
import { useViewer } from "../../data/viewer";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";

const byName = (a: SavedFilter, b: SavedFilter) => a.name.localeCompare(b.name);

/** Le colonne a destra del nome, a larghezza fissa (come l'elenco delle task). */
const COLS = "grid grid-cols-[minmax(0,1fr)_160px_88px_72px_40px] items-center gap-x-4";

/** Quante task del filtro vede chi guarda: la sua lettura, non quella dell'autore. */
function FilterCount({ filter }: { filter: SavedFilter }) {
  const { t } = useTranslation();
  const { data, isError } = useTasks(filter.criteria);
  if (isError) return <span className="text-sm text-ink-faint">—</span>;
  if (!data) return <span aria-hidden="true" className="ml-auto block h-2.5 w-6 rounded-sm bg-ink/8" />;
  return (
    <span className="num text-sm text-ink-muted">
      <span aria-hidden="true">{data.length}</span>
      <span className="sr-only">{t("tasks.count", { count: data.length })}</span>
    </span>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5.5 2.5h5l-.75 4 2.25 2.25v1h-8v-1L6.25 6.5z" />
      <path d="M8 9.75v3.75" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function FilterRow({
  filter,
  pinned,
  author,
  onPin,
}: {
  filter: SavedFilter;
  pinned: boolean | undefined;
  /** Nella sezione «Mine» l'autore è chi guarda: al suo posto la visibilità. */
  author: string | null;
  onPin: () => void;
}) {
  const { t } = useTranslation();
  const pinLabel = t("filter.pinLabel", { name: filter.name });
  return (
    <li className={`${COLS} relative h-11 border-b border-rule pr-3 pl-4 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4`}>
      <Link
        to="/filters/$id"
        params={{ id: filter.id }}
        title={filter.name}
        className="min-w-0 truncate text-md font-medium text-ink outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
      >
        {filter.name}
      </Link>
      <span className="min-w-0 truncate text-sm text-ink-muted">
        {author ?? t(`filter.visibility.${filter.visibility}`)}
      </span>
      <span className="text-sm text-ink-muted">{t(`tasks.views.${filter.view}`)}</span>
      <span className="text-right">
        <FilterCount filter={filter} />
      </span>
      <button
        type="button"
        aria-pressed={pinned ?? false}
        aria-label={pinLabel}
        title={pinned ? t("filter.unpin") : t("filter.pin")}
        disabled={pinned === undefined}
        onClick={onPin}
        className={`relative z-10 grid size-8 place-items-center rounded-md transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink ${pinned ? "text-ink" : "text-ink-faint"}`}
      >
        <PinIcon filled={!!pinned} />
      </button>
    </li>
  );
}

function FilterGroup({
  label,
  secondColumn,
  filters,
  empty,
  emptyHow,
  pinnedIds,
  authorOf,
  onPin,
}: {
  label: string;
  /** L'intestazione della seconda colonna (autore, o visibilità nei miei). */
  secondColumn: string;
  filters: SavedFilter[];
  empty: string;
  /** Come se ne crea uno, sotto la frase del vuoto. */
  emptyHow?: string;
  pinnedIds: string[] | undefined;
  authorOf: (filter: SavedFilter) => string | null;
  onPin: (filter: SavedFilter, pinned: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={label} className="flex flex-col">
      <h2 className="heading-group flex items-center gap-2 px-4 pt-6 pb-2">
        {label}
        <span className="num text-ink-faint">{filters.length}</span>
      </h2>
      {filters.length === 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-rule px-4 py-3">
          <p className="text-md text-ink">{empty}</p>
          {emptyHow && <p className="text-sm text-ink-muted">{emptyHow}</p>}
        </div>
      ) : (
        <>
          <div
            aria-hidden="true"
            className={`${COLS} h-7 border-y border-rule pr-3 pl-4 text-xs font-medium text-ink-faint`}
          >
            <span>{t("filter.columns.name")}</span>
            <span>{secondColumn}</span>
            <span>{t("filter.columns.view")}</span>
            <span className="text-right">{t("filter.columns.tasks")}</span>
            <span />
          </div>
          <ul>
            {filters.map((f) => {
              const pinned = pinnedIds?.includes(f.id);
              return (
                <FilterRow
                  key={f.id}
                  filter={f}
                  pinned={pinned}
                  author={authorOf(f)}
                  onPin={() => onPin(f, !pinned)}
                />
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function ListSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe px-0 pt-6">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className="ml-4 block h-2.5 w-16 rounded-sm bg-ink/8" />
      <div className="mt-3 border-t border-rule">
        {[58, 40, 66, 48, 52].map((w, i) => (
          <div key={i} className={`${COLS} h-11 border-b border-rule pr-3 pl-4`}>
            <span className="block h-2.5 rounded-sm bg-ink/8" style={{ width: `${w}%` }} />
            <span className="block h-2.5 w-24 rounded-sm bg-ink/8" />
            <span className="block h-2.5 w-12 rounded-sm bg-ink/8" />
            <span className="ml-auto block h-2.5 w-6 rounded-sm bg-ink/8" />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Tutti i filtri che chi guarda può aprire: «Mine» (i suoi, privati e
 * pubblici) e «Public» (i pubblici degli altri), per nome. Ogni riga: nome,
 * autore (o visibilità, nei miei), vista, quante task ci trova **chi guarda**
 * e il pin della colonna della Home. Un filtro si crea da una pagina di task
 * («Save as filter»): qui il vuoto lo dice.
 */
export function AllFiltersPage() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const filters = useSavedFilters();
  const pinned = usePinnedFilters();
  const people = usePeople().data;
  const setPinned = useSetFilterPinned();
  const me = viewer.personId;

  const onPin = (filter: SavedFilter, pin: boolean) =>
    setPinned.mutate(
      { filterId: filter.id, pinned: pin },
      {
        onError: () =>
          toast.error(t(pin ? "filter.pinFailed" : "filter.unpinFailed", { name: filter.name })),
      },
    );

  let body;
  if (filters.isError) {
    body = <PageError message={t("filter.listError")} onRetry={() => void filters.refetch()} />;
  } else if (!filters.data) {
    body = <ListSkeleton />;
  } else {
    const mine = filters.data.filter((f) => f.ownerId === me).sort(byName);
    const others = filters.data
      .filter((f) => f.ownerId !== me && f.visibility === "public")
      .sort(byName);
    body = (
      <>
        <FilterGroup
          label={t("filter.mine")}
          secondColumn={t("filter.columns.visibility")}
          filters={mine}
          empty={t("filter.mineEmpty")}
          emptyHow={t("filter.mineEmptyHow")}
          pinnedIds={pinned.data}
          authorOf={() => null}
          onPin={onPin}
        />
        <FilterGroup
          label={t("filter.public")}
          secondColumn={t("filter.columns.author")}
          filters={others}
          empty={t("filter.publicEmpty")}
          pinnedIds={pinned.data}
          authorOf={(f) => people?.find((p) => p.id === f.ownerId)?.name ?? "…"}
          onPin={onPin}
        />
      </>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="page-header flex shrink-0 flex-col gap-1 pb-2 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <h1 className="text-2xl font-semibold text-ink">{t("filter.allTitle")}</h1>
        <p className="max-w-[65ch] text-sm text-ink-muted">{t("filter.allIntro")}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-8">{body}</div>
    </section>
  );
}
