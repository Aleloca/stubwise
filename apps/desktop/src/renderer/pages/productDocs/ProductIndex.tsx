import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { flattenTree } from "../../domain/productDocs/tree";
import { formatDate } from "../../notifications/time";
import { PlusIcon } from "../task/parts";
import { secondaryButton } from "../tasks/controls";
import { DocCode, DocsGroup, rowLinkClass } from "../docs/parts";
import { ReadOnlyLine } from "./ReadOnlyLine";
import {
  indexFreshKey,
  productPageLink,
  takeFresh,
  useCreateAndOpen,
  usePersonName,
  useProductSpaceContext,
} from "./parts";

// L'indice dello spazio Prodotto (shape product-space.md §3.4, §3.6): h1
// «Product», la meta, «New page» per chi scrive, RECENTLY UPDATED e ALL
// PAGES (l'albero rientrato, per chi arriva col cassetto chiuso). Vuoto:
// le strade per chi scrive, una frase per chi legge.

/** Al più 4 livelli di rientro: oltre, la profondità resta nella lettura del nodo. */
const MAX_INDENT = 4;

export function ProductIndex() {
  const { t, i18n } = useTranslation();
  const { project, space, reveal } = useProductSpaceContext();
  const nameOf = usePersonName();
  const create = useCreateAndOpen(project, reveal);
  const edit = space.permissions.edit;
  const latest = space.recent[0];
  const all = flattenTree(space.tree);
  const heading = useRef<HTMLHeadingElement>(null);
  // Dopo l'eliminazione di una radice dalla barra, sotto i 1200: il fuoco qui.
  useEffect(() => {
    if (takeFresh(indexFreshKey(project.code))) heading.current?.focus();
  }, [project.code]);

  return (
    <article className="event-enter mx-auto flex w-full max-w-[720px] flex-col">
      <header className="flex items-start gap-4 pt-8">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold text-ink outline-none">
            {t("productDocs.space.title")}
          </h1>
          {/* Vuoto, la meta tace: lo dice già «No product pages yet» qui sotto. */}
          {latest && (
            <p className="num text-sm text-ink-muted">
              {t("productDocs.space.meta", {
                count: space.pageCount,
                date: formatDate(latest.updatedAt, i18n.language),
                name: nameOf(latest.updatedById),
              })}
            </p>
          )}
        </div>
        {edit && space.pageCount > 0 && (
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => void create.run(null)}
            className={`${secondaryButton} disabled:opacity-60`}
          >
            <PlusIcon />
            {t("productDocs.space.newPage")}
          </button>
        )}
      </header>
      {/* Uno spazio vuoto non ha niente da leggere né da chiedere: niente riga. */}
      {!edit && space.pageCount > 0 && (
        <div className="mt-3">
          <ReadOnlyLine projectId={project.id} projectCode={project.code} scope="index" />
        </div>
      )}

      {space.pageCount === 0 ? (
        <EmptySpace edit={edit} pending={create.isPending} onStart={() => void create.run(null)} />
      ) : (
        <>
          <DocsGroup title={t("productDocs.space.recent")}>
            <ul aria-label={t("productDocs.space.recent")} className="border-t border-rule">
              {space.recent.map((page) => (
                <li key={page.id}>
                  <Link {...productPageLink(project.code, page.code)} className={rowLinkClass}>
                    <DocCode code={page.code} />
                    <span className="min-w-0 flex-1 truncate text-md text-ink" title={page.title}>
                      {page.title}
                    </span>
                    <span className="num shrink-0 text-xs text-ink-faint">
                      {nameOf(page.updatedById)} · {formatDate(page.updatedAt, i18n.language)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </DocsGroup>
          <DocsGroup title={t("productDocs.space.allPages")} count={space.pageCount}>
            <ul aria-label={t("productDocs.space.allPages")} className="border-t border-rule">
              {all.map(({ page, depth }) => (
                <li key={page.id}>
                  <Link
                    {...productPageLink(project.code, page.code)}
                    style={{ paddingLeft: 8 + Math.min(depth, MAX_INDENT) * 16 }}
                    className="flex min-h-8 min-w-0 items-center gap-3 border-b border-rule py-1 pr-2 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                  >
                    <DocCode code={page.code} />
                    <span className="min-w-0 flex-1 truncate text-md text-ink" title={page.title}>
                      {page.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </DocsGroup>
        </>
      )}
    </article>
  );
}

/**
 * Lo spazio vuoto ([PS 15]): chi scrive ha le strade (righe da 44 px, non
 * card; il 11b ne aggiunge una in testa, «Write the first version with
 * Claude»); chi legge una frase, senza bottoni né «Who?»: non c'è niente da
 * chiedere, lo spazio è vuoto per tutti.
 */
function EmptySpace({
  edit,
  pending,
  onStart,
}: {
  edit: boolean;
  pending: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2 pt-10">
      <h2 className="text-xl font-semibold text-ink">{t("productDocs.space.emptyTitle")}</h2>
      <p className="max-w-[62ch] text-md text-pretty text-ink-muted">
        {edit ? t("productDocs.space.emptyWrite") : t("productDocs.space.emptyRead")}
      </p>
      {edit && (
        <ul aria-label={t("productDocs.space.ways")} className="mt-4 border-t border-rule">
          <li>
            <button
              type="button"
              disabled={pending}
              onClick={onStart}
              className={`${rowLinkClass} w-full text-md font-medium text-ink disabled:opacity-60`}
            >
              <PlusIcon />
              {t("productDocs.space.startBlank")}
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}
