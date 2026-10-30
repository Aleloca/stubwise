import { useTranslation } from "react-i18next";
import { useProject } from "../../data/queries";
import type { ProjectSettingsSection } from "../../data/routes";
import { MembersSettings } from "./MembersSettings";
import { ProjectStatusesSettings } from "./ProjectStatusesSettings";
import { RepositorySettings } from "./RepositorySettings";
import { SettingsFrame } from "./SettingsFrame";

/**
 * Una sezione delle impostazioni di un progetto (area 9a, [RM 4]): ogni
 * sezione è una pagina, raggiunta dalle voci rientrate sotto «Settings» nella
 * colonna del progetto. La route ha già controllato progetto e modulo.
 */
export function ProjectSettingsPage({
  projectCode,
  section,
}: {
  projectCode: string;
  section: ProjectSettingsSection;
}) {
  const { t } = useTranslation();
  const project = useProject(projectCode).data;
  if (!project) return null;
  switch (section) {
    case "members":
      return <MembersSettings project={project} />;
    case "repositories":
      return (
        <SettingsFrame
          title={t("settings.sections.repositories")}
          intro={t("settings.repositories.intro")}
        >
          <RepositorySettings project={project} />
        </SettingsFrame>
      );
    case "statuses":
      return (
        <SettingsFrame
          title={t("settings.sections.statuses")}
          intro={t("settings.intro", { project: project.name })}
        >
          <ProjectStatusesSettings project={project} />
        </SettingsFrame>
      );
  }
}
