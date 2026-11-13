import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useRepositorySettings } from "../../../data/queries";
import type { Project } from "../../../data/types";
import { AiSkeleton } from "../../admin/ai/parts";
import { quietButton, secondaryButton } from "../../tasks/controls";
import { RepositoryReleases } from "../RepositorySettings";
import { SettingsFrame } from "../SettingsFrame";
import { ViewOnlyLine } from "../ViewOnly";

// La sezione «Repositories» RIDOTTA della build app (area 8, F1, decisione
// di 46): l'elenco in sola lettura e, aperto un repository, SOLO il blocco
// «Releases» (PR dei colleghi, pipeline, ramo di rilascio). Il resto della
// pagina dell'area 9 (dettagli, account git, file d'ambiente, webhook,
// «nuovo repository») non si mostra finché l'area 9 non lo porta.

export function RepositoriesReleasesOnly({
  project,
  repositoryId,
  open,
}: {
  project: Project;
  repositoryId: string | undefined;
  /** `undefined` torna all'elenco. */
  open: (repositoryId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const settings = useRepositorySettings(project.id);
  const data = settings.data;
  const lineId = useId();
  const headingId = useId();
  const repo = repositoryId ? data?.repositories.find((r) => r.id === repositoryId) : undefined;

  if (repositoryId) {
    return (
      <SettingsFrame title={repo?.name ?? t("settings.sections.repositories")}>
        <button
          type="button"
          className={`${quietButton} self-start`}
          onClick={() => open(undefined)}
        >
          {t("settings.repos.back")}
        </button>
        {data && !repo ? (
          <p className="text-md text-ink-muted">
            {t("settings.repos.notFound", { code: project.code })}
          </p>
        ) : (
          <section aria-labelledby={headingId} className="mt-6">
            <h2 id={headingId} className="heading-group border-b border-rule pb-2">
              {t("settings.repos.releases")}
            </h2>
            <RepositoryReleases project={project} repositoryId={repositoryId} />
          </section>
        )}
      </SettingsFrame>
    );
  }

  return (
    <SettingsFrame
      title={t("settings.sections.repositories")}
      intro={t("settings.repos.intro", { code: project.code })}
    >
      {data && !data.canManage && (
        <ViewOnlyLine id={lineId} action="manageRepos" projectId={project.id} code={project.code} />
      )}
      {settings.isPending ? (
        <AiSkeleton rows={3} height={60} />
      ) : settings.isError || !data ? (
        <div role="alert" className="flex items-center gap-3 border-t border-rule py-3">
          <p className="text-md text-ink">
            {t("settings.repos.loadError", { code: project.code })}
          </p>
          <button type="button" className={secondaryButton} onClick={() => void settings.refetch()}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      ) : (
        <ul
          aria-label={t("settings.repos.list", { code: project.code })}
          className="border-t border-rule"
        >
          {data.repositories.map((r) => (
            <li key={r.id} className="flex min-h-12 items-center gap-3 border-b border-rule py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-md text-ink">{r.name}</span>
                <span className="truncate text-sm text-ink-muted">{r.fullName}</span>
              </span>
              <button
                type="button"
                className={secondaryButton}
                aria-label={`${t("settings.repos.open")} ${r.name}`}
                onClick={() => open(r.id)}
              >
                {t("settings.repos.open")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsFrame>
  );
}
