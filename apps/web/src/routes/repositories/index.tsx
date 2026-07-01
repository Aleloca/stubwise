import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { meQueryOptions } from "../../lib/auth";
import { projectsQueryOptions, repositoriesQueryOptions } from "../../lib/queries";

/**
 * Lista di TUTTI i repository collegati, raggruppati per progetto (gruppo). Ogni
 * riga linka al dettaglio del repository. L'aggiunta di un repository è
 * riservata agli admin (guardia anche sulla route standalone): il pulsante
 * porta al wizard con selettore di progetto.
 */
export function RepositoriesListPage() {
  const { t } = useTranslation();
  const { data: repositories } = useSuspenseQuery(repositoriesQueryOptions());
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  // Mappa projectId → progetto: risolve nome/slug del gruppo di appartenenza di
  // ogni repository senza cercare linearmente a ogni riga.
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  // Raggruppa i repository per progetto, preservando l'ordine dei progetti così
  // com'è nella lista dei gruppi; i repo di un progetto non più presente (raro)
  // finiscono comunque in coda sotto una chiave dedicata.
  const groups = useMemo(() => {
    const byProject = new Map<string, typeof repositories>();
    for (const repo of repositories) {
      const bucket = byProject.get(repo.projectId);
      if (bucket) bucket.push(repo);
      else byProject.set(repo.projectId, [repo]);
    }
    const ordered: { projectId: string; repos: typeof repositories }[] = [];
    for (const project of projects) {
      const repos = byProject.get(project.id);
      if (repos) {
        ordered.push({ projectId: project.id, repos });
        byProject.delete(project.id);
      }
    }
    for (const [projectId, repos] of byProject) {
      ordered.push({ projectId, repos });
    }
    return ordered;
  }, [repositories, projects]);

  return (
    <div className="page">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">{t("repositories:list.title")}</h1>
          <p className="mt-1 text-sm text-fg-muted">{t("repositories:list.subtitle")}</p>
        </div>
        {isAdmin && (
          <Link
            to="/repositories/new"
            className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("repositories:list.add")}
          </Link>
        )}
      </header>

      {repositories.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("repositories:list.empty")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">
            {isAdmin
              ? t("repositories:list.emptyHintAdmin")
              : t("repositories:list.emptyHintMember")}
          </p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {groups.map(({ projectId, repos }) => {
            const project = projectById.get(projectId);
            return (
              <section key={projectId}>
                <h2 className="mb-2 flex items-baseline gap-3">
                  {project ? (
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId }}
                      className="text-[15px] font-medium text-fg transition-colors hover:text-signal"
                    >
                      {project.name}
                    </Link>
                  ) : (
                    <span className="text-[15px] font-medium text-fg-muted">
                      {t("repositories:list.unknownProject")}
                    </span>
                  )}
                  {project && (
                    <span className="font-mono text-[12px] text-fg-faint">{project.slug}</span>
                  )}
                </h2>
                <ul className="rounded-sm border border-line bg-ink-900">
                  {repos.map((repo) => (
                    <li key={repo.id} className="border-b border-line last:border-b-0">
                      <Link
                        to="/repositories/$slug"
                        params={{ slug: repo.slug }}
                        className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-5 py-4 transition-colors hover:bg-ink-850"
                      >
                        <span className="text-[15px] font-medium text-fg">{repo.name}</span>
                        <span className="font-mono text-[12px] text-fg-faint">{repo.slug}</span>
                        <span className="font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase">
                          {t("repositories:list.branch")}: {repo.defaultBranch}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-fg-muted">
                          {repo.repoUrl}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
