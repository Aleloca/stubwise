import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { serversQueryOptions } from "../lib/queries";
import { ServerCard } from "./server-card";

/**
 * Sezione "Server" del dettaglio progetto: i soli server associati al progetto
 * ({@link serversQueryOptions} filtra via `?projectId=`), resi con le stesse
 * {@link ServerCard} — e stessa griglia responsive — della sezione Monitor. Le
 * card linkano al dettaglio globale del server. L'associazione server↔progetto
 * si gestisce in Impostazioni → Server: lo stato vuoto ci rimanda con un Link.
 * Query live (`refetchInterval` 30s): stato e CPU si aggiornano da soli.
 */
export function ProjectServersSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: servers } = useSuspenseQuery(serversQueryOptions(projectId));

  if (servers.length === 0) {
    return (
      <div className="grid place-items-center rounded-sm border border-dashed border-line-strong py-12">
        <p className="font-mono text-[12px] tracking-[0.16em] text-fg-faint uppercase">
          {t("projects:detail.noServers")}
        </p>
        <p className="mt-2 max-w-md text-center text-sm text-fg-muted">
          {t("projects:detail.noServersHint")}{" "}
          <Link to="/settings/servers" className="text-signal underline-offset-2 hover:underline">
            {t("projects:detail.manageServers")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {servers.map((server) => (
        <ServerCard key={server.id} server={server} />
      ))}
    </div>
  );
}
