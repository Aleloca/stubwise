import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RepositoryWizard } from "../../components/repository-wizard";
import { SelectField } from "../../components/field";
import { postRepository, type RepositoryDraft } from "../../lib/api";
import { projectsQueryOptions, repositoryQueryOptions } from "../../lib/queries";

/**
 * Aggiunta STANDALONE di un repository (solo admin, guardia nella route): a
 * differenza del flusso in-progetto qui il progetto di appartenenza non è dato
 * dall'URL ma va scelto in un selettore. Selezionato il progetto, si monta il
 * `RepositoryWizard` (account git → repository → branch); il resto del flusso —
 * POST, cache del dettaglio, invalidazioni, atterraggio sul repo — è identico.
 */
export function NewRepositoryStandalonePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);

  const [projectId, setProjectId] = useState("");

  async function handleSubmit(draft: RepositoryDraft) {
    const repository = await postRepository(draft);
    queryClient.setQueryData(repositoryQueryOptions(repository.slug).queryKey, repository);
    // Il progetto ora ha un repo in più: invalida liste progetti e repository.
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: ["repositories"] });
    await navigate({ to: "/repositories/$slug", params: { slug: repository.slug } });
  }

  return (
    <div className="page">
      <Link
        to="/repositories"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("repositories:newStandalone.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("repositories:newStandalone.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("repositories:newStandalone.subtitle")}</p>
      </header>

      {projects.length === 0 ? (
        <div className="mt-6 max-w-2xl rounded-sm border border-dashed border-line-strong px-4 py-6">
          <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
            {t("repositories:newStandalone.noProjects")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            {t("repositories:newStandalone.noProjectsHintPrefix")}
            <Link to="/projects" className="text-signal underline hover:text-signal-bright">
              {t("repositories:newStandalone.noProjectsHintLink")}
            </Link>
            {t("repositories:newStandalone.noProjectsHintSuffix")}
          </p>
        </div>
      ) : (
        <div className="mt-6 max-w-2xl">
          <div className="rounded-sm border border-line bg-ink-950/40 p-4">
            <SelectField
              id="new-repo-project"
              label={t("repositories:newStandalone.projectLabel")}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              options={[
                { value: "", label: t("repositories:newStandalone.projectPlaceholder") },
                ...projects.map((project) => ({ value: project.id, label: project.name })),
              ]}
            />
          </div>

          {projectId === "" ? (
            <p className="mt-6 font-mono text-[12px] text-fg-faint">
              {t("repositories:newStandalone.projectHint")}
            </p>
          ) : (
            // key={projectId}: cambiando progetto il wizard si rimonta pulito,
            // così `RepositoryDraft.projectId` e lo stato interno restano coerenti.
            <div className="mt-6">
              <RepositoryWizard key={projectId} projectId={projectId} onSubmit={handleSubmit} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
