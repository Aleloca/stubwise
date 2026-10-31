import { Link } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { useCanSeeAiTab } from "../../data/queries";
import type { Project } from "../../data/types";
import { UsagePanel } from "../admin/ai/UsagePanel";
import { SettingsFrame } from "./SettingsFrame";

// Progetto → Settings → Usage (shape project-settings.md «Usage»): «quanto
// è costato?». La `UsagePanel` del 9b nello scope del progetto, fino a
// 1040 px. La voce la vede solo chi ha `project.usage.view` (la colonna e
// la rotta lo leggono da `access`); qui non si scrive niente, quindi nessun
// «View only». Il link al totale dell'istanza solo per chi vede quella
// scheda.

export function UsageSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const seesInstanceUsage = useCanSeeAiTab("usage");
  const code = project.code;
  return (
    <SettingsFrame
      title={t("settings.sections.usage")}
      intro={t("settings.usage.intro", { code })}
      width={1040}
    >
      <UsagePanel
        scope={{ projectId: project.id }}
        empty={t("settings.usage.empty", { code })}
        loadError={t("settings.usage.loadError", { code })}
        afterTotals={
          seesInstanceUsage ? (
            <Trans
              i18nKey="settings.usage.onlyProjectLinked"
              values={{ code }}
              components={{
                link: (
                  <Link
                    to="/admin/$section"
                    params={{ section: "ai" }}
                    search={{ tab: "usage" } as never}
                    className="font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
                  />
                ),
              }}
            />
          ) : (
            t("settings.usage.onlyProject", { code })
          )
        }
      />
    </SettingsFrame>
  );
}
