import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllServers } from "../../../data/queries";
import { ReadError } from "../../preferences/parts";
import { NewInstanceServerDialog } from "../../servers/NewServerDialog";
import { ServerList } from "../../servers/ServerList";
import { ListSkeleton } from "../../servers/ServersPage";
import { secondaryButton } from "../../tasks/controls";
import { IntegrationPage } from "../integrations/parts";

// Servers dell'Amministrazione (area 9b, shape admin-instance.md «Servers»):
// tutti i server dell'istanza, per chi ha `monitor.manage` (la voce non c'è
// senza, e l'indirizzo è «not found»). L'elenco è quello dell'8b, coi gruppi
// per salute, la colonna dei progetti (i soli che chi guarda vede, R-G5) e in
// fondo gli orfani (R-L7). Unica azione nuova: «New server», che nasce
// sempre senza progetto (decisione del maintainer del 30 ott 2026).
// Ogni riga apre `/admin/servers/$server`, il dettaglio dell'8b.

export function ServersAdminPage() {
  const { t } = useTranslation();
  const servers = useAllServers();
  const [creating, setCreating] = useState(false);

  // Chi vede la voce ha `monitor.manage`: il bottone non è mai spento.
  const newButton = (
    <button type="button" className={secondaryButton} onClick={() => setCreating(true)}>
      {t("admin.servers.new")}
    </button>
  );

  return (
    <IntegrationPage
      title={t("admin.servers.title")}
      intro={t("admin.servers.intro")}
      action={newButton}
      width={960}
    >
      <div className="mt-6">
        {servers.isPending ? (
          <ListSkeleton widths={[0.42, 0.3, 0.36, 0.26]} />
        ) : servers.isError ? (
          <ReadError
            message={t("admin.servers.loadError")}
            onRetry={() => void servers.refetch()}
          />
        ) : servers.data.length === 0 ? (
          <div className="flex flex-col items-start gap-3 border-t border-rule pt-5">
            <p className="text-md text-ink">{t("admin.servers.empty")}</p>
            {newButton}
          </div>
        ) : (
          <ServerList rows={servers.data} projectCode={null} />
        )}
      </div>
      {creating && <NewInstanceServerDialog onClose={() => setCreating(false)} />}
    </IntegrationPage>
  );
}
