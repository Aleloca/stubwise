import { Link } from "@tanstack/react-router";
import { useCallback, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocTree } from "../../data/queries";
import type { DocPageRef, DocTreeNode } from "../../data/types";
import { formatDate } from "../../notifications/time";
import { Markdown, type TextDecorator } from "../../tasks-ui/Markdown";
import { Highlighted } from "../chat/ChatSearch";
import { fold, searchWords } from "../chat/search";
import { MinorMark, pageLink, useSpace } from "./parts";

// Le releases dello spazio (shape docs.md §5): scritte ogni notte dai commit
// nuovi. Campo «Search releases», interruttore «Significant only»; ogni voce
// è versione (600, cifre tabellari) · data · «Minor» in parola, il testo, e
// le pagine toccate come gettoni codice + titolo (solo quelle che chi guarda
// legge: una pagina eliminata o nascosta non c'è).

const leaves = (nodes: DocTreeNode[]): DocPageRef[] =>
  nodes.flatMap((n) => (n.page ? [n.page] : leaves(n.children)));

export function DocReleases() {
  const { t, i18n } = useTranslation();
  const { project, space } = useSpace();
  const tree = useDocTree(space.repositoryId);
  const [query, setQuery] = useState("");
  const [significant, setSignificant] = useState(false);
  const toggleId = useId();

  const pages = useMemo(
    () => new Map((tree.data ?? []).flatMap((c) => leaves(c.nodes)).map((p) => [p.id, p])),
    [tree.data],
  );
  const words = useMemo(() => searchWords(query), [query]);
  const highlight = useCallback<TextDecorator>(
    (text, key) => <Highlighted key={key} text={text} words={words} />,
    [words],
  );
  const needle = query.trim();
  const all = [...space.releases].sort((a, b) => b.date.localeCompare(a.date));
  // Una release corrisponde se ogni parola è nella versione, nel testo o nel
  // titolo di una pagina toccata.
  const haystack = (r: (typeof all)[number]) =>
    fold(`${r.version} ${r.text} ${r.pageIds.map((id) => pages.get(id)?.title ?? "").join(" ")}`);
  const shown = all.filter(
    (r) => (!significant || !r.minor) && words.every((w) => haystack(r).includes(w)),
  );

  return (
    <article className="event-enter flex flex-col">
      <header className="flex flex-col gap-1.5 pt-8">
        <h1 className="text-2xl font-semibold text-ink">{t("docs.releases.title")}</h1>
        <p className="text-sm text-ink-muted">{space.name}</p>
      </header>

      {all.length === 0 ? (
        <p className="pt-8 text-md text-ink-muted">{t("docs.releases.empty")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 pt-6 pb-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("docs.releases.search")}
              placeholder={t("docs.releases.search")}
              className="h-8 w-[280px] max-w-full rounded-md border border-rule-strong bg-transparent px-2.5 text-md text-ink outline-none placeholder:text-ink-faint focus-visible:border-ink/45"
            />
            <span className="flex items-center gap-2 text-sm text-ink">
              <button
                id={toggleId}
                type="button"
                role="switch"
                aria-checked={significant}
                onClick={() => setSignificant((v) => !v)}
                className="group relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-rule-strong bg-ink/8 transition-colors duration-[var(--duration-fast)] ease-out outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-checked:border-ink aria-checked:bg-ink"
              >
                <span className="ml-[2px] size-2.5 rounded-full bg-ink-muted transition-transform duration-[var(--duration-fast)] ease-out group-aria-checked:translate-x-3 group-aria-checked:bg-ground motion-reduce:transition-none" />
              </button>
              <label htmlFor={toggleId} className="cursor-pointer">
                {t("docs.releases.significant")}
              </label>
            </span>
          </div>
          <ul aria-label={t("docs.releases.title")} className="border-t border-rule">
            {shown.map((r) => {
              const touched = r.pageIds.flatMap((id) => pages.get(id) ?? []);
              return (
                <li
                  key={r.id}
                  data-release={r.version}
                  className="flex flex-col gap-2 border-b border-rule px-2 py-3.5"
                >
                  <div className="flex items-baseline gap-3">
                    <span className="num text-md font-semibold text-ink">{r.version}</span>
                    <span className="num text-xs text-ink-muted">
                      {formatDate(r.date, i18n.language)}
                    </span>
                    {r.minor && <MinorMark />}
                  </div>
                  {/* Il testo resta Markdown anche cercando: le parole trovate si evidenziano dentro. */}
                  <Markdown
                    source={r.text}
                    className="max-w-[72ch] text-md"
                    {...(words.length > 0 ? { decorate: highlight } : {})}
                  />
                  {touched.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5">
                      <span className="text-xs text-ink-muted">
                        {t("docs.releases.pagesTouched")}
                      </span>
                      {touched.map((p) => (
                        <Link
                          key={p.id}
                          {...pageLink(project.code, space.name, p.slug)}
                          className="inline-flex h-6 max-w-[320px] min-w-0 items-center gap-1.5 rounded-md border border-rule px-2 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:border-rule-strong hover:bg-ink/4"
                        >
                          <span className="num shrink-0 text-xs font-semibold text-ink-muted">
                            {p.code}
                          </span>
                          <span className="truncate">{p.title}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {shown.length === 0 && (
            <p role="status" className="px-2 py-4 text-md text-ink-muted">
              {needle
                ? t("docs.releases.noMatch", { query: query.trim() })
                : t("docs.releases.noMatchSignificant")}
            </p>
          )}
        </>
      )}
    </article>
  );
}
