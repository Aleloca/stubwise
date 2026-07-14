import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { serversQueryOptions } from "../../lib/queries";
import { ServerCard } from "../../components/server-card";

/**
 * Sezione Monitor: griglia di tutti i server monitorati, ognuno una
 * {@link ServerCard} (riusata dal tab Server di progetto). La query è live
 * (`refetchInterval` 30s): stato, heartbeat e CPU si aggiornano da soli.
 * Stato vuoto con rimando alle impostazioni per registrare il primo server.
 */
export function MonitorListPage() {
  const { t } = useTranslation();
  const { data: servers } = useSuspenseQuery(serversQueryOptions());

  return (
    <div className="page">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("monitor:list.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("monitor:list.subtitle")}</p>
      </header>

      {servers.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("monitor:list.empty")}
          </p>
          <p className="mt-2 max-w-md text-center text-sm text-fg-muted">
            {t("monitor:list.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}
    </div>
  );
}
