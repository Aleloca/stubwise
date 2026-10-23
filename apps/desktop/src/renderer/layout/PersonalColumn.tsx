import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { APP_ROUTES } from "../data/routes";
import { ONE_LINE, columnItemClass } from "./ProjectColumn";

export type Destination = (typeof APP_ROUTES)[number];

/**
 * Le sottoviste note di una destinazione. Restano sulla stessa route (`?view=`):
 * le aree non sono ancora progettate, l'area di lavoro mostra il segnaposto.
 * La prima è quella di default, senza parametro.
 */
const SUBVIEWS: Partial<Record<Destination, readonly string[]>> = {
  home: ["assigned", "delegated", "following"],
  chat: ["channels", "direct"],
};

/**
 * Colonna di una destinazione personale: solo le sottoviste, se ci sono. Il
 * nome della destinazione è l'h1 dell'area di lavoro: qui non si ripete
 * (la navigazione lo porta nell'etichetta accessibile, «Home views»).
 */
export function PersonalColumn({ destination }: { destination: Destination }) {
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
