import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/**
 * Spazio di documentazione di un progetto (placeholder M7.1): l'albero a tre
 * zone, la pagina, la ricerca e la chat arrivano in M7.2–M7.5. Per ora un
 * segnaposto navigabile dall'hub, così la rotta esiste e il link dell'hub è
 * type-safe senza anticipare la UI dello spazio.
 */
export function DocsSpacePage() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/authed/docs/$projectId" });

  return (
    <div className="p-8">
      <Link to="/docs" className="font-mono text-[12px] text-fg-muted hover:text-fg">
        {t("docs:hub.title")}
      </Link>
      <p className="mt-4 font-mono text-[12px] text-fg-faint">{projectId}</p>
    </div>
  );
}
