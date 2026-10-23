import { Link, useLinkProps, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { usePinnedFilters, useSavedFilters } from "../data/queries";
import { APP_ROUTES } from "../data/routes";
import { can, useViewer } from "../data/viewer";
import { ONE_LINE, columnItemClass } from "./ProjectColumn";

export type Destination = (typeof APP_ROUTES)[number];

/**
 * Le sottoviste note delle altre destinazioni. Restano sulla stessa route
 * (`?view=`): le aree non sono ancora progettate, l'area di lavoro mostra il
 * segnaposto. La prima è quella di default, senza parametro. La Home ha la
 * sua colonna (`HomeColumn`).
 */
const SUBVIEWS: Partial<Record<Destination, readonly string[]>> = {
  chat: ["channels", "direct"],
};

/**
 * Colonna di una destinazione personale: solo le sottoviste, se ci sono. Il
 * nome della destinazione è l'h1 dell'area di lavoro: qui non si ripete
 * (la navigazione lo porta nell'etichetta accessibile, «Home views»).
 */
export function PersonalColumn({ destination }: { destination: Destination }) {
  if (destination === "home") return <HomeColumn />;
  return <GenericColumn destination={destination} />;
}

/**
 * La colonna della Home: Home e La mia settimana (`?view=week`), i filtri che
 * la persona ha fissato (nell'ordine in cui li ha fissati), «All filters» e,
 * solo a chi ha `planning.others` in almeno un progetto, «Planning»,
 * trasversale ai progetti. Home resta corrente anche con `?task=` aperto: qui
 * conta solo la vista (`view`), non la ricerca che apre i pannelli.
 */
/**
 * Home e La mia settimana sono la STESSA route: il Link le direbbe entrambe
 * correnti. Qui lo stato "corrente" lo decide la sola vista: si prendono le
 * props del Link e `aria-current` si riscrive dopo.
 */
function ViewLink({
  view,
  isCurrent,
  children,
}: {
  view?: "week";
  isCurrent: boolean;
  children: string;
}) {
  const props = useLinkProps({ to: "/home", search: view ? { view } : {} });
  return (
    <a
      {...props}
      aria-current={isCurrent ? "page" : undefined}
      style={{ whiteSpace: "nowrap" }}
      className={columnItemClass}
    >
      <span style={ONE_LINE} className="min-w-0">
        {children}
      </span>
    </a>
  );
}

function HomeColumn() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const view = useRouterState({ select: (s) => (s.location.search as { view?: string }).view });
  // La colonna c'è anche sulle pagine dei filtri: lì né Home né La mia settimana sono correnti.
  const onHome = useRouterState({ select: (s) => s.location.pathname === "/home" });
  const filters = useSavedFilters();
  const pinned = usePinnedFilters();
  const pinnedFilters = (pinned.data ?? []).flatMap((id) => {
    const f = filters.data?.find((x) => x.id === id);
    return f ? [f] : [];
  });
  return (
    <nav
      aria-label={t("column.viewsOf", { name: t("nav.home") })}
      className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-2"
    >
      <ul className="flex flex-col gap-px">
        <li>
          <ViewLink isCurrent={onHome && view !== "week"}>{t("column.subviews.home.home")}</ViewLink>
        </li>
        <li>
          <ViewLink view="week" isCurrent={onHome && view === "week"}>
            {t("column.subviews.home.week")}
          </ViewLink>
        </li>
        {pinnedFilters.map((f) => (
          <li key={f.id}>
            <Link
              to="/filters/$id"
              params={{ id: f.id }}
              style={{ whiteSpace: "nowrap" }}
              className={columnItemClass}
            >
              <span style={ONE_LINE} className="min-w-0">
                {f.name}
              </span>
            </Link>
          </li>
        ))}
        <li>
          <Link
            to="/filters"
            activeOptions={{ exact: true }}
            style={{ whiteSpace: "nowrap" }}
            className={columnItemClass}
          >
            <span style={ONE_LINE} className="min-w-0">
              {t("column.allFilters")}
            </span>
          </Link>
        </li>
        {can(viewer, "planning.others") && (
          <li>
            <Link
              to="/planning"
              style={{ whiteSpace: "nowrap" }}
              className={columnItemClass}
            >
              <span style={ONE_LINE} className="min-w-0">
                {t("column.planning")}
              </span>
            </Link>
          </li>
        )}
      </ul>
    </nav>
  );
}

function GenericColumn({ destination }: { destination: Destination }) {
  const { t } = useTranslation();
  const views = SUBVIEWS[destination];
  const label = t("column.viewsOf", { name: t(`nav.${destination}`) });
  if (!views) {
    // Stato neutro: la colonna resta larga uguale e dice, in tono minore, che
    // le viste non ci sono ancora (niente titolo: il nome è già l'h1).
    return (
      <nav aria-label={label} data-no-views className="min-h-0 flex-1 px-4 pt-4 pb-2">
        <p className="text-sm text-ink-muted">{t("column.noViews")}</p>
      </nav>
    );
  }
  return (
    <nav aria-label={label} className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-2">
      <ul className="flex flex-col gap-px">
        {views.map((view, i) => (
          <li key={view}>
            <Link
              to={`/${destination}`}
              search={i === 0 ? {} : { view }}
              activeOptions={{ exact: true, includeSearch: true }}
              style={{ whiteSpace: "nowrap" }}
              className={columnItemClass}
            >
              <span style={ONE_LINE} className="min-w-0">
                {t(`column.subviews.${destination}.${view}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
