import type { DocPageKind, ProjectBrief } from "@stubwise/shared";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { DocHighlights, DocTreeNode } from "../lib/docs-api";
import { formatDate } from "../lib/format";

/**
 * Overview di uno spazio di documentazione: la schermata che si apre entrando in
 * `/docs/:repoId` senza aver scelto una pagina. Sostituisce il vecchio
 * "SELECT A PAGE" (che non diceva nulla a chi non conosce il prodotto) con tre
 * risposte: di cosa parla questo repo, da dove si comincia, cosa è cambiato.
 *
 * Componente PURO: i dati (albero, highlights, brief, nome repo) arrivano dal
 * wrapper di rotta, così resta testabile senza mock di rete.
 */

/** Categorie navigabili dell'albero, nell'ordine della sidebar. */
const CATEGORY_ORDER: DocPageKind[] = ["technical", "functional", "product", "manual"];

const CATEGORY_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:space.groupTechnical",
  functional: "docs:space.groupFunctional",
  product: "docs:space.groupProduct",
  manual: "docs:space.groupManual",
  releases: "docs:space.groupReleases",
};

/** Prima pagina di una categoria nell'ordine della sidebar (position, poi titolo). */
function firstPageOfKind(tree: DocTreeNode[], kind: DocPageKind): DocTreeNode | undefined {
  return tree
    .filter((node) => node.kind === kind)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))[0];
}

/** Riquadro con intestazione mono, il contenitore ricorrente della pagina. */
function Panel({
  title,
  label,
  children,
}: {
  title: string;
  /** Nome accessibile della region (default: `title`). */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label ?? title} className="mt-10">
      <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Voce di lista con titolo e meta a destra (pagina, release, punto d'ingresso). */
function EntryLink({
  to,
  params,
  title,
  meta,
}: {
  to: string;
  params: Record<string, string>;
  title: string;
  meta?: string;
}) {
  return (
    <Link
      // I path sono letterali del router: il cast tiene il componente generico
      // senza duplicare una union di rotte.
      to={to as never}
      params={params as never}
      className="group flex items-baseline justify-between gap-3 rounded-sm border border-line px-3 py-2 transition-colors hover:border-ink-700 hover:bg-ink-900"
    >
      <span className="min-w-0 truncate text-[13px] text-fg-muted group-hover:text-fg">
        {title}
      </span>
      {meta && <span className="shrink-0 font-mono text-[11px] text-fg-faint">{meta}</span>}
    </Link>
  );
}

export function DocsRepoOverview({
  projectId,
  repoName,
  tree,
  highlights,
  brief,
}: {
  projectId: string;
  repoName: string | undefined;
  tree: DocTreeNode[];
  highlights: DocHighlights | undefined;
  /** Brief della generazione corrente; null quando il repo non ne ha uno. */
  brief: ProjectBrief | null;
}) {
  const { t } = useTranslation();
  const counts = highlights?.countsByKind;
  const categories = CATEGORY_ORDER.map((kind) => ({
    kind,
    count: counts?.[kind] ?? 0,
    first: firstPageOfKind(tree, kind),
  })).filter((category) => category.count > 0 && category.first);

  const firstTechnical = firstPageOfKind(tree, "technical");
  const firstProduct = firstPageOfKind(tree, "product");
  const latestRelease = highlights?.latestReleases[0];

  return (
    <div className="mx-auto max-w-3xl p-8">
      <header className="border-b border-line pb-6">
        <p className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
          {t("docs:overview.eyebrow")}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{repoName ?? t("docs:space.back")}</h1>
        {brief?.identity ? (
          <p className="mt-3 max-w-prose text-sm leading-relaxed text-fg-muted">
            {brief.identity}
          </p>
        ) : (
          <p className="mt-3 max-w-prose text-sm text-fg-muted">{t("docs:overview.noBrief")}</p>
        )}
      </header>

      {/* Punti d'ingresso: il percorso consigliato per chi arriva a freddo. */}
      <Panel title={t("docs:overview.startHere")} label={t("docs:overview.startHere")}>
        <div className="grid gap-2 sm:grid-cols-2">
          {brief && (
            <EntryLink
              to="/docs/$projectId/brief"
              params={{ projectId }}
              title={t("docs:brief.link")}
              meta={t("docs:overview.briefMeta")}
            />
          )}
          {firstTechnical && (
            <EntryLink
              to="/docs/$projectId/$slug"
              params={{ projectId, slug: firstTechnical.slug }}
              title={firstTechnical.title}
              meta={t("docs:space.groupTechnical")}
            />
          )}
          {firstProduct && (
            <EntryLink
              to="/docs/$projectId/$slug"
              params={{ projectId, slug: firstProduct.slug }}
              title={firstProduct.title}
              meta={t("docs:space.groupProduct")}
            />
          )}
          {latestRelease && (
            <EntryLink
              to="/docs/$projectId/releases"
              params={{ projectId }}
              title={latestRelease.title}
              meta={formatDate(latestRelease.createdAt)}
            />
          )}
        </div>
      </Panel>

      {/* Categorie: quante pagine ci sono e dove portano. */}
      {categories.length > 0 && (
        <Panel title={t("docs:overview.categories")}>
          <div className="grid gap-2 sm:grid-cols-2">
            {categories.map(({ kind, count, first }) => (
              <Link
                key={kind}
                to="/docs/$projectId/$slug"
                params={{ projectId, slug: first!.slug }}
                className="group flex items-baseline justify-between gap-3 rounded-sm border border-line px-3 py-3 transition-colors hover:border-ink-700 hover:bg-ink-900"
              >
                <span className="font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase group-hover:text-fg">
                  {t(CATEGORY_LABEL_KEY[kind])}
                </span>
                <span className="font-mono text-[13px] text-fg-faint group-hover:text-signal">
                  {count}
                </span>
              </Link>
            ))}
          </div>
        </Panel>
      )}

      {/* Novità: cosa è cambiato e cosa leggono gli altri. */}
      {highlights && (
        <Panel title={t("docs:overview.whatsNew")} label={t("docs:overview.whatsNew")}>
          <div className="grid gap-6 sm:grid-cols-2">
            {highlights.latestReleases.length > 0 && (
              <div>
                <p className="font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
                  {t("docs:releases.link")}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {highlights.latestReleases.slice(0, 3).map((release) => (
                    <li key={release.slug} className="flex items-baseline justify-between gap-3">
                      <Link
                        to="/docs/$projectId/releases"
                        params={{ projectId }}
                        className="min-w-0 truncate text-[13px] text-fg-muted transition-colors hover:text-signal"
                      >
                        {release.title}
                      </Link>
                      <time
                        dateTime={release.createdAt}
                        className="shrink-0 font-mono text-[11px] text-fg-faint"
                      >
                        {formatDate(release.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-col gap-6">
              {highlights.recentlyUpdated.length > 0 && (
                <div>
                  <p className="font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
                    {t("docs:overview.recentlyUpdated")}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {highlights.recentlyUpdated.slice(0, 4).map((page) => (
                      <li key={page.slug}>
                        <Link
                          to="/docs/$projectId/$slug"
                          params={{ projectId, slug: page.slug }}
                          className="block truncate text-[13px] text-fg-muted transition-colors hover:text-signal"
                        >
                          {page.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {highlights.topViewed.length > 0 && (
                <div>
                  <p className="font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
                    {t("docs:overview.topViewed")}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {highlights.topViewed.slice(0, 4).map((page) => (
                      <li key={page.slug} className="flex items-baseline justify-between gap-3">
                        <Link
                          to="/docs/$projectId/$slug"
                          params={{ projectId, slug: page.slug }}
                          className="min-w-0 truncate text-[13px] text-fg-muted transition-colors hover:text-signal"
                        >
                          {page.title}
                        </Link>
                        <span className="shrink-0 font-mono text-[11px] text-fg-faint">
                          {page.viewCount}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
