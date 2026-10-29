import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useProjectServers } from "../../data/queries";
import { can, useViewer } from "../../data/viewer";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { secondaryButton } from "../tasks/controls";
import { NewServerDialog } from "./NewServerDialog";
import { ServerList } from "./ServerList";

// La sezione Servers di un progetto (`#/p/ACQ/servers`, shape servers.md §3):
// dove gira il progetto e come sta, prima la salute in parole. I server
// entrano nel progetto attraverso gli ambienti (R-L2). «New server» solo a
// chi gestisce il monitoraggio (`monitor.manage`, d'istanza): bottone
// secondario, la pagina non ha un primario.

/** Due righe d'elenco finte, con la forma vera (codice, nome, salute; sotto gli ambienti). */
function ListSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe border-t border-rule">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {[0.42, 0.3].map((w) => (
        <div key={w} className="flex h-14 flex-col justify-center gap-2 border-b border-rule px-3">
          <span className="flex items-center gap-3">
            <span className="h-2.5 w-12 rounded-sm bg-ink/8" />
            <span className="h-2.5 rounded-sm bg-ink/8" style={{ width: `${w * 100}%` }} />
            <span className="ml-auto h-2.5 w-24 rounded-sm bg-ink/8" />
          </span>
          <span className="ml-15 h-2 w-48 rounded-sm bg-ink/6" />
        </div>
      ))}
    </div>
  );
}

export function ServersPage({ projectCode }: { projectCode: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const project = useProject(projectCode).data ?? undefined;
  const servers = useProjectServers(project?.id);
  const [creating, setCreating] = useState(false);
  const canCreate = can(viewer, "monitor.manage");
  const newButton = canCreate ? (
    <button
      type="button"
      data-new-server
      className={secondaryButton}
      onClick={() => setCreating(true)}
    >
      {t("servers.newServer")}
    </button>
  ) : null;

  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[1120px] flex-col gap-8 pr-8">
        <header className="page-header flex shrink-0 items-start gap-4 [--page-header-pr:32px] [--page-header-pt:32px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-2xl font-semibold text-ink">{t("servers.title")}</h1>
            <p className="max-w-[72ch] text-md text-ink-muted">
              {t("servers.subtitle", { code: projectCode })}
            </p>
          </div>
          {newButton && <span className="shrink-0 pt-1">{newButton}</span>}
        </header>
        {servers.isError ? (
          <PageError
            message={t("servers.errors.list", { code: projectCode })}
            onRetry={() => void servers.refetch()}
          />
        ) : !servers.data ? (
          <ListSkeleton />
        ) : servers.data.length === 0 ? (
          <PageEmpty
            title={t("servers.empty.title", { code: projectCode })}
            body={
              canCreate
                ? t("servers.empty.body")
                : `${t("servers.empty.body")} ${t("servers.empty.noPermission")}`
            }
            action={newButton}
          />
        ) : (
          <ServerList rows={servers.data} projectCode={projectCode} />
        )}
      </div>
      {creating && project && (
        <NewServerDialog project={project} onClose={() => setCreating(false)} />
      )}
    </section>
  );
}
