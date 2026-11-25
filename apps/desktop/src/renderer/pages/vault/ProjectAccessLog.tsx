import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAccessLog, useProject } from "../../data/queries";
import { DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { quietButton } from "../tasks/controls";
import { AccessLogList } from "./AccessLogList";
import { CREDENTIAL_PANEL_DOCKED_QUERY } from "./CredentialPanel";

// Il registro degli accessi di TUTTO il progetto (shape `vault.md` §3
// «Access log», dal «⋯» della sezione): il pannello di destra su `?log=1`,
// per chi gestisce le credenziali del progetto (agli altri il livello dati
// non dà righe, e la voce del menu non c'è).

const SECTION = /^\/p\/([^/]+)\/credentials\/?$/;

export function ProjectAccessLogHost() {
  const search = useSearch({ strict: false }) as { log?: string };
  const code = useRouterState({
    select: (s) => SECTION.exec(s.location.pathname)?.[1] ?? null,
  });
  if (search.log !== "1" || !code) return null;
  return <ProjectAccessLogPanel code={code} />;
}

function ProjectAccessLogPanel({ code }: { code: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const docked = useMediaQuery(CREDENTIAL_PANEL_DOCKED_QUERY);
  const project = useProject(code).data;
  const log = useAccessLog(project?.id);
  const close = useCallback(
    () =>
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, log: undefined })) as never,
      }),
    [navigate],
  );
  return (
    <DetailPanel
      mode={docked ? "docked" : "overlay"}
      label={t("vault.sectionMenu.panel", { code })}
      onClose={close}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <header className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-ink">
            {t("vault.sectionMenu.log")}
          </h2>
          <button type="button" className={quietButton} onClick={close}>
            {t("vault.detail.close")}
          </button>
        </header>
        <AccessLogList entries={log.data} showService />
      </div>
    </DetailPanel>
  );
}
