import type { DocPageKind } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type DocSearchResult, searchDocs } from "../lib/docs-api";
import { docsKeys } from "../lib/queries";

/**
 * Barra di ricerca dello spazio (M7.4): query debounced (250ms) verso
 * `searchDocs`; i risultati (titolo/kind/snippet) linkano alla pagina. Distinta
 * dalla chat (M7.5). Sotto i 2 caratteri non interroga (niente richieste per
 * ogni tasto). Stato no-results gestito esplicitamente.
 */

const KIND_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:search.kindTechnical",
  functional: "docs:search.kindFunctional",
  manual: "docs:search.kindManual",
};

/** Soglia minima di caratteri per interrogare (evita ricerche su 1 lettera). */
const MIN_QUERY_LENGTH = 2;

export function DocsSearch({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");

  // Debounce: il valore effettivamente interrogato si aggiorna 250ms dopo
  // l'ultima battitura, così non parte una richiesta per ogni tasto.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(handle);
  }, [input]);

  const enabled = debounced.length >= MIN_QUERY_LENGTH;
  const { data: results, isFetching } = useQuery({
    queryKey: [...docsKeys.space(projectId), "search", debounced],
    queryFn: () => searchDocs(projectId, debounced),
    enabled,
    staleTime: 30_000,
  });

  const showResults = enabled && results !== undefined;

  return (
    <section className="mb-4">
      <label
        htmlFor="docs-search"
        className="sr-only"
      >
        {t("docs:search.label")}
      </label>
      <input
        id="docs-search"
        type="search"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        placeholder={t("docs:search.placeholder")}
        aria-label={t("docs:search.label")}
        className="w-full rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[13px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
      />

      {showResults &&
        (results.length === 0 && !isFetching ? (
          <div className="mt-2 rounded-sm border border-dashed border-line-strong px-3 py-4 text-center">
            <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("docs:search.noResults")}
            </p>
            <p className="mt-1 text-[12px] text-fg-muted">{t("docs:search.noResultsHint")}</p>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col gap-0.5" aria-label={t("docs:search.label")}>
            {results.map((result) => (
              <SearchResultRow
                key={result.slug}
                projectId={projectId}
                result={result}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        ))}
    </section>
  );
}

function SearchResultRow({
  projectId,
  result,
  onNavigate,
}: {
  projectId: string;
  result: DocSearchResult;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <Link
        to="/docs/$projectId/$slug"
        params={{ projectId, slug: result.slug }}
        onClick={onNavigate}
        className="block rounded-sm px-2 py-1.5 transition-colors hover:bg-ink-850"
      >
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13px] text-fg">{result.title}</span>
          <span className="shrink-0 font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
            {t(KIND_LABEL_KEY[result.kind])}
          </span>
        </span>
        {result.snippet && (
          <span className="mt-0.5 line-clamp-2 block text-[12px] text-fg-muted">
            {result.snippet}
          </span>
        )}
      </Link>
    </li>
  );
}
