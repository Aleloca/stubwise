import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../lib/format";
import { docSpacesQueryOptions } from "../../lib/queries";

/**
 * Hub della documentazione: ogni progetto con doc è uno "spazio". Lista i
 * progetti (nome/slug), il conteggio pagine e la data/commit dell'ultima
 * generazione; ogni riga linka allo spazio del progetto. Mirror strutturale
 * della lista progetti (stesse classi/altitudine), senza nuovo design system.
 */
export function DocsPage() {
  const { t } = useTranslation();
  const { data: spaces } = useSuspenseQuery(docSpacesQueryOptions);

  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("docs:hub.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("docs:hub.subtitle")}</p>
      </header>

      {spaces.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-24">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("docs:hub.empty")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">{t("docs:hub.emptyHint")}</p>
        </div>
      ) : (
        <ul className="mt-6 rounded-sm border border-line bg-ink-900">
          {spaces.map((space) => (
            <li key={space.projectId} className="border-b border-line last:border-b-0">
              <Link
                to="/docs/$projectId"
                params={{ projectId: space.projectId }}
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
    </div>
  );
}
