import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useDeleteManualPage,
  useDocPage,
  useRecordDocView,
  useSessionPersonId,
} from "../../data/queries";
import type { DocPageView as DocPage } from "../../data/types";
import { formatDate } from "../../notifications/time";
import { Dialog } from "../../tasks-ui/Dialog";
import { itemClass } from "../../tasks-ui/Menu";
import { Markdown } from "../../tasks-ui/Markdown";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { copyText } from "../../tasks-ui/exportFile";
import { CloseIcon, MoreIcon, dangerButton, ghostButton } from "../task/parts";
import { MenuButton, secondaryButton } from "../tasks/controls";
import {
  DocCode,
  DocNotFound,
  ReadingSkeleton,
  backLinkClass,
  pageHref,
  pageLink,
  spaceLink,
  useSpace,
} from "./parts";

// Una pagina dei Docs (shape docs.md §3, §5): sopra l'h1 il codice (clic
// copia il link) e la categoria; sotto, la riga meta; l'avviso di pagina
// vecchia; il corpo Markdown coi titoli da h2; i collegamenti. Le manuali,
// con `docs.edit`, hanno «Edit» e «⋯ → Delete».

/** Gli avvisi di pagina vecchia chiusi in questa sessione, per persona e pagina. */
const dismissedStale = new Set<string>();

/** Quanti commit della pagina vecchia si vedono prima di «Show N more». */
const STALE_CAP = 5;

export function DocPageRoute({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const { project, space } = useSpace();
  const page = useDocPage(space.repositoryId, slug);
  if (page.isError) {
    return (
      <div className="pt-6">
        <PageError message={t("docs.page.loadError")} onRetry={() => void page.refetch()} />
      </div>
    );
  }
  if (page.isPending) return <ReadingSkeleton />;
  if (!page.data) {
    return (
      <DocNotFound
        back={
          <Link {...spaceLink(project.code, space.name)} className={backLinkClass}>
            {t("docs.page.backToIndex")}
          </Link>
        }
      />
    );
  }
  return <DocPageBody key={page.data.id} page={page.data} />;
}

function DocPageBody({ page }: { page: DocPage }) {
  const { t, i18n } = useTranslation();
  const { project, space } = useSpace();
  const toast = useToast();
  const recordView = useRecordDocView();
  const recorded = useRef(false);
  const [deleting, setDeleting] = useState(false);

  // Una visita per pagina aperta: non a ogni ricarica (la visita stessa
  // ricarica l'area Docs). Il ref regge anche al doppio effetto di StrictMode.
  const { mutate: record } = recordView;
  useEffect(() => {
    if (recorded.current) return;
    recorded.current = true;
    record(page.id);
  }, [page.id, record]);

  const copyLink = () => {
    copyText(pageHref(project.code, space.name, page.slug)).then(
      () => toast.show(t("docs.page.linkCopied", { code: page.code })),
      () => toast.error(t("docs.page.copyFailed")),
    );
  };

  const manual = page.kind === "manual";
  return (
    // Una sola misura per tutta la pagina (meta, filetto, testo, pagine
    // collegate): 72ch, centrata nella larghezza che resta accanto all’albero.
    <article className="event-enter mx-auto flex w-full max-w-[72ch] flex-col">
      <header className="flex items-start gap-4 pt-8">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <button
              type="button"
              onClick={copyLink}
              // ⌘C col fuoco sul codice copia il link, come il clic (A 11).
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
            <span>{t(`docs.kind.${page.kind}`)}</span>
          </p>
          <h1 className="text-2xl font-semibold text-balance text-ink">{page.title}</h1>
          <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm text-ink-muted">
            {manual ? (
              <span>{t("docs.page.manual")}</span>
            ) : (
              <>
                {page.documentsPath && (
                  <>
                    <span>
                      {t("docs.page.documents")}{" "}
                      <code className="font-code rounded-[4px] bg-ink/8 px-1 py-px text-[0.92em] text-ink">
                        {page.documentsPath}
                      </code>
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                {page.generatedAtCommit && (
                  <>
                    <span title={page.generatedAtCommit}>
                      {t("docs.page.generatedAt")}{" "}
                      <span className="num text-ink">{page.generatedAtCommit.slice(0, 7)}</span>
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
              </>
            )}
            {manual && <span aria-hidden="true">·</span>}
            <span className="num">
              {t("docs.page.updated", { date: formatDate(page.updatedAt, i18n.language) })}
            </span>
          </p>
        </div>
        {page.permissions.edit && (
          <div className="flex shrink-0 items-center gap-1 pt-6">
            <Link
              to="/p/$code/docs/$repo/$slug/edit"
              params={{ code: project.code, repo: space.name, slug: page.slug }}
              className={secondaryButton}
            >
              {t("docs.page.edit")}
            </Link>
            {page.permissions.delete && (
              <MenuButton
                menuLabel={t("docs.page.more")}
                ariaLabel={t("docs.page.more")}
                title={t("docs.page.more")}
                align="right"
                className={`${ghostButton} h-8 w-8 justify-center px-0 aria-expanded:bg-ink/8`}
                label={<MoreIcon />}
              >
                {(close) => (
                  <button
                    type="button"
                    role="menuitem"
                    className={`${itemClass} text-critical`}
                    onClick={() => {
                      close();
                      setDeleting(true);
                    }}
                  >
                    {t("docs.page.delete")}
                  </button>
                )}
              </MenuButton>
            )}
          </div>
        )}
      </header>

      {page.staleCommits.length > 0 && <StaleNote page={page} />}

      <div className="mt-6">
        <Markdown
          source={page.body}
          documentHeadings
          codeLabel={t("docs.page.codeBlock")}
          tableLabel={t("docs.page.table")}
        />
      </div>

      <LinkedPages page={page} />

      {deleting && <DeleteDialog page={page} onClose={() => setDeleting(false)} />}
    </article>
  );
}

/**
 * L'avviso di pagina vecchia (§5): informazione, non errore — un filetto
 * sinistro `warning` di 2 px, il segno e il testo (mai il solo colore).
 * Chiuso dice quanti commit; aperto li elenca (5, poi «Show N more»). Si
 * chiude per la sessione, non per sempre.
 */
function StaleNote({ page }: { page: DocPage }) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const key = `${me}:${page.id}`;
  const [hidden, setHidden] = useState(() => dismissedStale.has(key));
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  if (hidden) return null;
  const commits = page.staleCommits;
  const shown = all ? commits : commits.slice(0, STALE_CAP);
  const label = t("docs.page.stale", { count: commits.length });
  return (
    <div
      role="note"
      aria-label={label}
      className="mt-5 flex flex-col border-l-2 border-warning py-1.5 pr-1.5 pl-3"
    >
      <div className="flex items-center gap-2">
        <svg
          viewBox="0 0 16 16"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          className="shrink-0 text-warning"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75V8l2 1.5" />
        </svg>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-sm text-ink"
        >
          <span className="min-w-0 flex-1">{label}</span>
          <svg
            viewBox="0 0 16 16"
            width={12}
            height={12}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            className={`shrink-0 text-ink-faint transition-transform duration-[var(--duration-fast)] ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          >
            <path d="m6 4 4 4-4 4" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            dismissedStale.add(key);
            setHidden(true);
          }}
          aria-label={t("docs.page.hideStale")}
          title={t("docs.page.hideStale")}
          className={`${ghostButton} h-6 w-6 justify-center px-0`}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      {open && (
        <ul className="mt-1.5 flex flex-col border-t border-rule">
          {shown.map((c) => (
            <li
              key={c.sha}
              className="flex min-w-0 items-baseline gap-3 border-b border-rule py-1.5 text-sm last:border-b-0"
            >
              <span className="num shrink-0 text-xs font-semibold text-ink-muted">
                {c.sha.slice(0, 7)}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink" title={c.message}>
                {c.message}
              </span>
              <span className="num shrink-0 text-xs text-ink-faint">
                {formatDate(c.at, i18n.language)}
              </span>
            </li>
          ))}
          {!all && commits.length > STALE_CAP && (
            <li className="pt-1">
              <button type="button" onClick={() => setAll(true)} className={`${ghostButton} -ml-2`}>
                {t("docs.page.showMore", { count: commits.length - STALE_CAP })}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

const LINK_TYPES = ["implements", "implemented_by", "related"] as const;

/** «Linked pages»: Implements / Implemented by / Related (solo le pagine che chi guarda vede). */
function LinkedPages({ page }: { page: DocPage }) {
  const { t } = useTranslation();
  const { project, space } = useSpace();
  if (page.resolvedLinks.length === 0) return null;
  return (
    <section
      aria-label={t("docs.groups.linked")}
      className="mt-10 flex flex-col border-t border-rule pt-5"
    >
      <h2 className="heading-group pb-2">{t("docs.groups.linked")}</h2>
      {LINK_TYPES.map((type) => {
        const links = page.resolvedLinks.filter((l) => l.type === type);
        if (links.length === 0) return null;
        return (
          <div key={type} className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-1">
            <span className="pt-1.5 text-sm text-ink-muted">{t(`docs.page.links.${type}`)}</span>
            <ul className="flex flex-col">
              {links.map(({ page: target }) => (
                <li key={target.id}>
                  <Link
                    {...pageLink(project.code, space.name, target.slug)}
                    className="flex min-h-8 min-w-0 items-center gap-2 rounded-md px-1 text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
                  >
                    <DocCode code={target.code} />
                    <span className="min-w-0 truncate" title={target.title}>
                      {target.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function DeleteDialog({ page, onClose }: { page: DocPage; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { project, space } = useSpace();
  const remove = useDeleteManualPage();
  return (
    <Dialog
      title={t("docs.page.deleteTitle", { title: page.title })}
      description={t("docs.page.deleteBody")}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" onClick={onClose} className={secondaryButton}>
            {t("docs.form.cancel")}
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(page.id, {
                onSuccess: () => {
                  toast.show(t("docs.page.deleted", { title: page.title }));
                  onClose();
                  void navigate({ ...spaceLink(project.code, space.name), replace: true });
                },
                onError: () => toast.error(t("docs.page.deleteFailed", { title: page.title })),
              })
            }
            className={`${dangerButton} h-8 px-3`}
          >
            {t("docs.page.delete")}
          </button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
