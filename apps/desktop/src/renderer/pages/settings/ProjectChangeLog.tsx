import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useChangeFilterChoices, useProjectChanges } from "../../data/queries";
import type { Project } from "../../data/types";
import {
  CLEARED,
  ChangeFilters,
  ChangeJournal,
  filterOf,
  journalState,
  type ChangeLogSearch,
} from "../admin/ChangeLogPage";
import { SettingsFrame } from "./SettingsFrame";

// Progetto → Settings → Change log (shape admin-audit.md): la parte del
// registro di quel progetto, per chi ne gestisce le impostazioni o i membri
// (la colonna e la rotta lo controllano già). Stessi filtri e stesso
// giornale dell'Amministrazione, senza Project e senza il codice a destra:
// è sempre lo stesso.

export function ProjectChangeLog({ project }: { project: Project }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ChangeLogSearch;
  const choices = useChangeFilterChoices(project.id);
  const changes = useProjectChanges(project.id, filterOf(search, choices.data, false));
  const set = (patch: Partial<ChangeLogSearch>) =>
    void navigate({
      to: ".",
      search: (prev: ChangeLogSearch) => ({ ...prev, ...patch }),
      replace: true,
    });
  const filtered = !!(search.actor || search.kind || search.period);
  return (
    <SettingsFrame
      title={t("settings.sections.changelog")}
      intro={t("changelog.projectIntro", { code: project.code })}
    >
      <ChangeFilters search={search} choices={choices.data} withProject={false} onChange={set} />
      <ChangeJournal
        state={journalState(choices, changes)}
        entries={changes.data ?? []}
        onRetry={() => void (choices.isError ? choices.refetch() : changes.refetch())}
        filtered={filtered}
        onClear={() => set(CLEARED)}
        empty={t("changelog.projectEmpty", { code: project.code })}
        showProject={false}
      />
    </SettingsFrame>
  );
}
