import { useTranslation } from "react-i18next";
import { useProject } from "../../data/queries";
import { ProjectStatusesSettings } from "./ProjectStatusesSettings";

/**
 * Le impostazioni di un progetto. In quest'area c'è solo «Statuses and
 * stalled tasks»; membri, moduli e integrazioni arriveranno più avanti e qui
 * restano un titolo e una frase che dice cosa ci starà.
 */
export function ProjectSettingsPage({ projectCode }: { projectCode: string }) {
  const { t } = useTranslation();
  const project = useProject(projectCode).data ?? undefined;
  return (
    <section className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[880px] flex-col pr-8">
        <header className="page-header flex shrink-0 flex-col gap-1.5 pb-5 [--page-header-pr:32px] [--page-header-pt:32px]">
          <h1 className="text-2xl font-semibold text-ink">{t("project.sections.settings")}</h1>
          {project && (
            <p className="max-w-[72ch] text-sm text-ink-muted">
              {t("settings.intro", { project: project.name })}
            </p>
          )}
        </header>
        {project && <ProjectStatusesSettings project={project} />}
        <section aria-labelledby="settings-other" className="border-t border-rule pt-5 pb-7">
          <h2 id="settings-other" className="text-xl font-semibold text-ink">
            {t("settings.other.title")}
          </h2>
          <p className="pt-2 text-md text-ink-muted">{t("settings.other.body")}</p>
        </section>
      </div>
    </section>
  );
}
