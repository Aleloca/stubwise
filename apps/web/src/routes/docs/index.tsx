import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DocSpace } from "../../lib/docs-api";
import { formatRelativeTime } from "../../lib/format";
import { docSpacesQueryOptions, projectsQueryOptions, repositoriesQueryOptions } from "../../lib/queries";

/**
 * Hub della documentazione: ogni repository con doc è uno "spazio". Gli spazi
 * sono raggruppati per PROGETTO (Fase 2): un header di progetto (con link alla
 * landing di progetto cross-repo) e, sotto, le card dei suoi repo-spazi.
 *
 * Il raggruppamento è lato client (via meno invasiva, nessun nuovo endpoint):
 * l'hub globale `/api/docs/spaces` dà i repo-spazi, la lista repository (globale)
 * mappa repositoryId → projectId, la lista progetti dà i nomi/slug dei gruppi.
 * Le card repo continuano a linkare alla vista per-repo esistente.
 */

/** Un gruppo dell'hub: il progetto + i suoi repo-spazi documentati. */
interface ProjectGroup {
  projectId: string;
  name: string;
  slug: string;
  spaces: DocSpace[];
}

export function DocsPage() {
  const { t } = useTranslation();
  const { data: spaces } = useSuspenseQuery(docSpacesQueryOptions);
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: repositories } = useSuspenseQuery(repositoriesQueryOptions());

  // Raggruppamento: repositoryId → projectId (dalla lista repo), poi spazi per
  // progetto, nell'ordine della lista progetti (già ordinata lato server).
  const groups = useMemo<ProjectGroup[]>(() => {
    const projectIdByRepo = new Map(repositories.map((r) => [r.id, r.projectId]));
    const spacesByProject = new Map<string, DocSpace[]>();
    for (const space of spaces) {
      const projectId = projectIdByRepo.get(space.repositoryId);
      if (!projectId) continue;
      const list = spacesByProject.get(projectId);
      if (list) list.push(space);
      else spacesByProject.set(projectId, [space]);
    }
    return projects
      .map((project) => ({
        projectId: project.id,
        name: project.name,
        slug: project.slug,
        spaces: spacesByProject.get(project.id) ?? [],
      }))
      .filter((group) => group.spaces.length > 0);
  }, [spaces, projects, repositories]);

  return (
    <div className="page">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("docs:hub.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("docs:hub.subtitle")}</p>
      </header>

      {groups.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("docs:hub.empty")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">{t("docs:hub.emptyHint")}</p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-8">
          {groups.map((group) => (
            <section key={group.projectId} aria-label={group.name}>
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2">
                <h2 className="text-[15px] font-semibold text-fg">{group.name}</h2>
                <span className="font-mono text-[12px] text-fg-faint">{group.slug}</span>
                <Link
                  to="/docs/project/$projectId"
                  params={{ projectId: group.projectId }}
                  className="ml-auto font-mono text-[11px] tracking-[0.08em] text-signal-dim uppercase transition-colors hover:text-fg"
                >
                  {t("docs:hub.openProject")}
                </Link>
              </header>
              <ul className="mt-3 rounded-sm border border-line bg-ink-900">
                {group.spaces.map((space) => (
                  <li key={space.repositoryId} className="border-b border-line last:border-b-0">
                    <Link
                      to="/docs/$projectId"
                      params={{ projectId: space.repositoryId }}
                      className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 px-5 py-4 transition-colors hover:bg-ink-850"
                    >
                      <span className="text-[15px] font-medium text-fg">{space.name}</span>
                      <span className="font-mono text-[12px] text-fg-faint">{space.slug}</span>
                      <span className="font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase">
                        {t("docs:hub.pageCount", { count: space.pageCount })}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] whitespace-nowrap text-fg-faint">
                        {space.lastGenerationAt ? (
                          <>
                            {t("docs:hub.lastGenerated", {
                              date: formatRelativeTime(space.lastGenerationAt),
                            })}
                            {space.lastCommitSha
                              ? ` · ${t("docs:hub.atCommit", { commit: space.lastCommitSha.slice(0, 7) })}`
                              : ""}
                          </>
                        ) : space.pageCount > 0 ? (
                          t("docs:hub.neverGenerated")
                        ) : (
                          t("docs:hub.notGenerated")
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
