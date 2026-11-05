import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useProductPage, useProductPresence } from "../../data/queries";
import type { ProductPageView } from "../../data/types";
import { formatDate } from "../../notifications/time";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { copyText } from "../../tasks-ui/exportFile";
import { DocCode, ReadingSkeleton } from "../docs/parts";
import { ReadOnlyLine } from "./ReadOnlyLine";
import { TitleField } from "./TitleField";
import { BlockEditor, type BlockEditorHandle } from "./editor/BlockEditor";
import { useEditorSession } from "./editor/useEditorSession";
import {
  ProductNotFound,
  inSpace,
  productPageHref,
  takeFresh,
  usePersonName,
  useProductSpaceContext,
} from "./parts";

// Una pagina di prodotto (shape product-space.md §3.4): la riga «ACQ-D5 ·
// Product» (il codice copia il link), l'h1, la meta, la riga di sola
// lettura per chi non scrive, il corpo. Una pagina eliminata da un altro,
// un codice inventato o una pagina che chi guarda non legge dicono la stessa
// cosa ([PS 20]). Per chi scrive il titolo è un campo della stessa
// tipografia e il corpo è l'editor a blocchi (Task 8, product-editor.md):
// la pagina letta e la pagina scritta sono la stessa pagina.

export function ProductPageRoute({ code }: { code: string }) {
  const { t } = useTranslation();
  const { project } = useProductSpaceContext();
  const page = useProductPage(code);
  if (page.isError) {
    return (
      <div className="pt-6">
        <PageError message={t("docs.page.loadError")} onRetry={() => void page.refetch()} />
      </div>
    );
  }
  if (page.isPending) return <ReadingSkeleton />;
  if (!inSpace(page.data, project)) return <ProductNotFound code={project.code} />;
  return <PageBody key={page.data.id} page={page.data} />;
}

function PageBody({ page }: { page: ProductPageView }) {
  const { t, i18n } = useTranslation();
  const { project, setEditorStatus } = useProductSpaceContext();
  const toast = useToast();
  const nameOf = usePersonName();
  const heading = useRef<HTMLHeadingElement>(null);
  const editor = useRef<BlockEditorHandle>(null);
  const session = useEditorSession(page);
  const editable = page.permissions.edit;
  // L'iscrizione alla pagina: una pagina eliminata da un altro mentre è
  // aperta (`gone`) ricarica la lettura, che dice «non trovata».
  useProductPresence(page.id);

  // Lo stato del salvataggio va nella barra dello spazio (una sola barra).
  const retry = useRef(session.retry);
  retry.current = session.retry;
  useEffect(() => {
    if (!editable) return;
    setEditorStatus({ state: session.state, skipped: session.skipped, retry: () => retry.current() });
  }, [editable, session.state, session.skipped, setEditorStatus]);
  useEffect(() => () => setEditorStatus(null), [setEditorStatus]);

  // Una pagina appena creata: il fuoco va al suo titolo (per chi scrive col
  // testo selezionato, [PE 2]), mai sul body.
  useEffect(() => {
    if (!takeFresh(page.code)) return;
    const el = heading.current;
    if (!el) return;
    el.focus();
    if (editable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    }
  }, [page.code]);

  const copyLink = () => {
    copyText(productPageHref(project.code, page.code)).then(
      () => toast.show(t("docs.page.linkCopied", { code: page.code })),
      () => toast.error(t("docs.page.copyFailed")),
    );
  };

  return (
    <article className="event-enter mx-auto flex w-full max-w-[720px] flex-col">
      <header className="flex flex-col gap-1.5 pt-8">
        <p className="flex items-center gap-1.5 text-xs text-ink-muted">
          <button
            type="button"
            onClick={copyLink}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
                e.preventDefault();
                copyLink();
              }
            }}
            aria-keyshortcuts="Meta+C"
            aria-label={t("docs.page.copyLink", { code: page.code })}
            title={t("docs.page.copyLink", { code: page.code })}
            className="-mx-1 rounded-sm px-1 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
          >
            <DocCode code={page.code} />
          </button>
          <span aria-hidden="true">·</span>
          <span>{t("docs.space.product")}</span>
        </p>
        {editable ? (
          <TitleField ref={heading} page={page} onEnter={() => editor.current?.focusFirst()} />
        ) : (
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-[28px] leading-9 font-semibold text-balance text-ink outline-none [overflow-wrap:anywhere]"
          >
            {page.title}
          </h1>
        )}
        <p className="num flex flex-wrap items-baseline gap-x-1.5 text-sm text-ink-muted">
          <span>
            {t("productDocs.space.updated", {
              date: formatDate(page.updatedAt, i18n.language),
              name: nameOf(page.updatedById),
            })}
          </span>
          {/* A 1024 la meta lascia cadere «Created by …» ([PS 10]). */}
          <span aria-hidden="true" className="max-[1199px]:hidden">
            ·
          </span>
          <span className="max-[1199px]:hidden">
            {t("productDocs.space.created", { name: nameOf(page.createdById) })}
          </span>
        </p>
        {!page.permissions.edit && (
          <div className="pt-1">
            <ReadOnlyLine projectId={project.id} projectCode={project.code} scope="page" />
          </div>
        )}
      </header>
      <div className="mt-6">
        <BlockEditor page={page} session={session} editable={editable} handle={editor} />
      </div>
    </article>
  );
}
