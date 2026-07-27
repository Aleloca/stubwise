import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocTreeNode } from "../lib/docs-api";
import { formatDate, formatRelativeTime } from "../lib/format";
import { docPageQueryOptions } from "../lib/queries";
import { Markdown } from "./markdown";

/**
 * Vista changelog di uno spazio: le entry `releases` come TIMELINE verticale,
 * fuori dall'albero della sidebar (una release non è una pagina di manuale: è un
 * evento datato). Ogni voce porta data, titolo, significatività e commit; il
 * corpo markdown si espande on-demand (query per slug, il tree non lo contiene).
 *
 * I filtri sono locali e non toccano l'URL: "solo significative" nasconde le
 * release minori (rumore da refactor interni), la ricerca filtra per titolo.
 */

/**
 * Commit short dallo slug `release-YYYYMMDD-HHmm-<sha>`: le release sono pagine
 * persistenti senza generazione, quindi `commitSha` è sempre null — il commit
 * vive solo nello slug. Null se lo slug non ha la forma attesa (release vecchie).
 */
export function releaseCommitFromSlug(slug: string): string | null {
  const match = /^release-\d{8}-\d{4}-([0-9a-f]+)$/.exec(slug);
  return match ? match[1]! : null;
}

/** Una voce della timeline: intestazione sempre visibile, corpo on-demand. */
function ReleaseEntry({ projectId, release }: { projectId: string; release: DocTreeNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const commit = releaseCommitFromSlug(release.slug);
  // Il corpo arriva solo all'apertura: la timeline resta leggera anche con
  // centinaia di release.
  const { data: page, isPending } = useQuery({
    ...docPageQueryOptions(projectId, release.slug),
    enabled: open,
  });

  return (
    <li className="relative pl-6">
      {/* Nodo sulla guida verticale della timeline. */}
      <span
        aria-hidden
        className={`absolute top-2 left-0 size-2 rounded-full ring-4 ring-ink-950 ${
          release.significant === false ? "bg-ink-700" : "bg-signal"
        }`}
      />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <time
          dateTime={release.createdAt}
          title={formatRelativeTime(release.createdAt)}
          className="font-mono text-[11px] tracking-[0.08em] text-fg-faint"
        >
          {formatDate(release.createdAt)}
        </time>
        {commit && (
          <span className="font-mono text-[11px] tracking-[0.04em] text-fg-faint">{commit}</span>
        )}
        {release.significant === false && (
          <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
            {t("docs:releases.minorBadge")}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="mt-1 flex w-full items-start gap-2 text-left"
      >
        <span aria-hidden className="mt-1 text-[10px] leading-none text-fg-faint">
          {open ? "▼" : "▶"}
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-medium text-fg transition-colors hover:text-signal">
          {release.title}
        </span>
      </button>

      {open && (
        <div className="mt-3 ml-4 border-l border-line pl-4">
          {isPending && !page ? (
            <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("docs:releases.loading")}
            </p>
          ) : page ? (
            <>
              <Markdown source={page.body} />
              {page.links && page.links.length > 0 && (
                <div className="mt-4">
                  <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
                    {t("docs:releases.impacted")}
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {page.links.map((link) => (
                      <li key={link.slug}>
                        <Link
                          to="/docs/$projectId/$slug"
                          params={{ projectId, slug: link.slug }}
                          className="text-[13px] text-signal transition-colors hover:underline"
                        >
                          {link.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-fg-muted">{t("docs:releases.bodyUnavailable")}</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Timeline delle release di uno spazio. `releases` arriva dall'albero già in
 * cache (nodi `kind === "releases"`): l'ordinamento è per `position` crescente
 * perché la position è il timestamp NEGATO (più recente = più piccola).
 */
export function DocsReleases({
  projectId,
  releases,
  compact,
}: {
  projectId: string;
  releases: DocTreeNode[];
  /** Variante senza intestazione/filtri, per incastonare la timeline altrove. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [onlySignificant, setOnlySignificant] = useState(false);
  const [query, setQuery] = useState("");

  const ordered = useMemo(
    () => [...releases].sort((a, b) => a.position - b.position),
    [releases],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ordered.filter((release) => {
      // `significant === null` = release precedente alla colonna: la trattiamo
      // come significativa, meglio mostrarla che nasconderla.
      if (onlySignificant && release.significant === false) return false;
      if (needle && !release.title.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [ordered, onlySignificant, query]);

  const list =
    visible.length === 0 ? (
      <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
        {t(releases.length === 0 ? "docs:releases.empty" : "docs:releases.noMatch")}
      </p>
    ) : (
      <ul className="flex flex-col gap-6 border-l border-line pl-1">
        {visible.map((release) => (
          <ReleaseEntry key={release.id} projectId={projectId} release={release} />
        ))}
      </ul>
    );

  if (compact) return list;

  return (
    <section className="mx-auto max-w-3xl p-8">
      <header className="border-b border-line pb-4">
        <p className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
          {t("docs:releases.eyebrow")}
        </p>
        <h1 className="mt-1 text-xl font-semibold">{t("docs:releases.heading")}</h1>
        <p className="mt-2 max-w-prose text-sm text-fg-muted">{t("docs:releases.subtitle")}</p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("docs:releases.searchPlaceholder")}
            aria-label={t("docs:releases.searchPlaceholder")}
            className="min-w-0 flex-1 rounded-sm border border-line bg-ink-900 px-2 py-1.5 text-[13px] text-fg placeholder:text-fg-faint focus:border-signal/40 focus:outline-none"
          />
          <label className="flex shrink-0 items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
            <input
              type="checkbox"
              checked={onlySignificant}
              onChange={(event) => setOnlySignificant(event.target.checked)}
              className="size-3.5 accent-signal"
            />
            {t("docs:releases.onlySignificant")}
          </label>
          <span className="shrink-0 font-mono text-[11px] tracking-[0.08em] text-fg-faint">
            {t("docs:releases.count", { count: visible.length })}
          </span>
        </div>
      </header>
      <div className="mt-6">{list}</div>
    </section>
  );
}
