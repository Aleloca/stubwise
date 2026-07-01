import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DocsChat } from "../../components/docs-chat";
import { formatRelativeTime } from "../../lib/format";
import { projectDocSpacesQueryOptions, projectQueryOptions } from "../../lib/queries";

/**
 * Landing della documentazione di PROGETTO (`/docs/project/$projectId`, Fase 2).
 * Segmento `project/` distinto dal `/docs/$projectId` per-repo (dove il param è
 * un repositoryId): qui il param è un vero projectId.
 *
 * Mostra l'elenco dei repo-spazi del progetto (link alle viste per-repo
 * esistenti) e una chat cross-repo (`DocsChat` con `scope="project"`): le
 * citazioni indicano il repository d'origine e linkano alla pagina nel repo
 * giusto. Layout a due zone su desktop (spazi a sinistra, chat a destra),
 * impilato su mobile.
 */
export function ProjectDocsLanding() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/authed/docs/project/$projectId" });
  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
  const { data: spaces } = useSuspenseQuery(projectDocSpacesQueryOptions(projectId));

  // Chat sempre montata (è il fulcro della landing): aperta di default su
  // desktop, gestita internamente dal componente.
  const [chatOpen, setChatOpen] = useState(true);

  return (
    <div className="relative flex h-full min-h-0 flex-col lg:flex-row">
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-8">
          <header className="border-b border-line pb-4">
            <p className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
              {t("docs:project.eyebrow")}
            </p>
            <h1 className="mt-1 text-xl font-semibold">{project.name}</h1>
            <p className="mt-1 text-sm text-fg-muted">{t("docs:project.subtitle")}</p>
          </header>

          <section className="mt-6" aria-label={t("docs:project.spacesHeading")}>
            <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
              {t("docs:project.spacesHeading")}
            </h2>
            {spaces.length === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">{t("docs:project.spacesEmpty")}</p>
            ) : (
              <ul className="mt-3 rounded-sm border border-line bg-ink-900">
                {spaces.map((space) => (
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
            )}
          </section>
        </div>
      </section>

      {/* Chat cross-repo di progetto: stesso componente della chat per-repo,
          parametrizzato su scope="project" (endpoint di progetto + citazioni
          col repository). */}
      <DocsChat projectId={projectId} scope="project" open={chatOpen} onOpenChange={setChatOpen} />
    </div>
  );
}
