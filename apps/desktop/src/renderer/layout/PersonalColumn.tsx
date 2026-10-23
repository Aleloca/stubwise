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

/** Colonna di una destinazione personale: il titolo e, se ci sono, le sottoviste. */
export function PersonalColumn({ destination }: { destination: Destination }) {
  const { t } = useTranslation();
  const views = SUBVIEWS[destination];
  return (
    <>
      <header className="shrink-0 border-b border-rule px-4 pt-4 pb-3">
        <h2 style={ONE_LINE} className="text-lg font-semibold">
          {t(`nav.${destination}`)}
        </h2>
      </header>
      {views && (
        <nav aria-label={t("column.views")} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
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
      )}
    </>
  );
}
