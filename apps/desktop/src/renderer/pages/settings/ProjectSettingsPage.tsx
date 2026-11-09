import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useProject } from "../../data/queries";
import type { ProjectSettingsSection } from "../../data/routes";
import type { Project } from "../../data/types";
import { AiSettings } from "./AiSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { AutomationSettings } from "./AutomationSettings";
import { GeneralSettings } from "./GeneralSettings";
import { IntegrationSettings } from "./IntegrationSettings";
import { MembersSettings } from "./MembersSettings";
import { ProjectChangeLog } from "./ProjectChangeLog";
import { PluginSettings } from "./PluginSettings";
import { ProjectStatusesSettings } from "./ProjectStatusesSettings";
import { RepositoriesSection } from "./repositories/RepositoryList";
import { SettingsFrame } from "./SettingsFrame";
import { UsageSettings } from "./UsageSettings";

/**
 * Una sezione delle impostazioni di un progetto (area 9a, [RM 4]): ogni
 * sezione è una pagina, raggiunta dalle voci rientrate sotto «Settings» nella
 * colonna del progetto. La route ha già controllato progetto e sezione
 * (`projectSettingsAccess`). Ogni sezione si rimonta (chiave): il suo h1
 * prende il fuoco, e la bozza di un'altra sezione non resta.
 */
export function ProjectSettingsPage({
  projectCode,
  section,
}: {
  projectCode: string;
  section: ProjectSettingsSection;
}) {
  const project = useProject(projectCode).data;
  if (!project) return null;
  return (
    <Fragment key={section}>
      <Section project={project} section={section} />
    </Fragment>
  );
}

function Section({ project, section }: { project: Project; section: ProjectSettingsSection }) {
  const { t } = useTranslation();
  switch (section) {
    case "general":
      return <GeneralSettings project={project} />;
    case "ai":
      return <AiSettings project={project} />;
    case "automations":
      return <AutomationSettings project={project} />;
    case "usage":
      return <UsageSettings project={project} />;
    case "members":
      return <MembersSettings project={project} />;
    case "changelog":
      return <ProjectChangeLog project={project} />;
    case "repositories":
      // Con o senza il modulo Releases (area 9c, Task 8): le parti dell'8a
      // stanno nella pagina di un repository, solo col modulo.
      return <RepositoriesSection project={project} />;
    case "statuses":
      return (
        <SettingsFrame
          title={t("settings.sections.statuses")}
          intro={t("settings.intro", { project: project.name })}
        >
          <ProjectStatusesSettings project={project} />
        </SettingsFrame>
      );
    case "integration":
      return <IntegrationSettings project={project} />;
    case "plugins":
      return <PluginSettings project={project} />;
    case "archive":
      return <ArchiveSettings project={project} />;
  }
}
