import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DocsChat } from "../../components/docs-chat";
import { DocsCommandPalette } from "../../components/docs-command-palette";
import { DocsManualForm } from "../../components/docs-manual-form";
import { DocsSidebar } from "../../components/docs-sidebar";
import { Drawer } from "../../components/drawer";
import { Markdown } from "../../components/markdown";
import { ApiError } from "../../lib/api";
import { type DocPage, type DocPageLink, deleteManualPage } from "../../lib/docs-api";
import { docPageQueryOptions, docsKeys, docTreeQueryOptions } from "../../lib/queries";
import { useCloseOnRouteChange } from "../../lib/use-close-on-route-change";
import { useMediaQuery } from "../../lib/use-media-query";

/**
 * Spazio di documentazione di un progetto: layout a tre zone (M7.2).
 * - sinistra: `DocsTree` (albero a tre gruppi della generazione corrente +
 *   manuali);
 * - centro: `<Outlet />` — la pagina selezionata (`$slug`) o un placeholder
 *   "seleziona una pagina" sull'indice dello spazio;
 * - destra: il drawer chat RAG (`DocsChat`, M7.5), apribile dal pulsante in
 *   basso a destra.
 *
 * Tutte le sotto-feature dello spazio sono ora montate: trigger generazione +
 * stato (`DocsGenerationPanel`, M7.4), ricerca via command palette Cmd/K
 * (`DocsCommandPalette`), editing pagine manuali (`DocsManualForm`, M7.3) e chat
 * in streaming (`DocsChat`, M7.5).
 */
export function DocsSpaceLayout() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/authed/docs/$projectId" });
  const { data: tree } = useSuspenseQuery(docTreeQueryOptions(projectId));

  // Su `lg+` la sidebar è un aside fisso; sotto, vive in un drawer. Pilotata in
  // JS per montare UNA SOLA `DocsSidebar` alla volta (evita id/link duplicati).
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  // Drawer albero (solo mobile): si chiude su selezione (`onNavigate`) e su
  // navigazione a una pagina doc (`useCloseOnRouteChange`).
  const [treeOpen, setTreeOpen] = useState(false);
  const closeTree = useCallback(() => setTreeOpen(false), []);
  useCloseOnRouteChange(closeTree);

  // Chat: stato unico condiviso dal FAB e dal bottone "Chat" della sotto-barra.
  const [chatOpen, setChatOpen] = useState(false);

  // Command palette di ricerca (Cmd/K): stato condiviso dal trigger nella
  // sidebar (desktop e drawer mobile) e dalla scorciatoia globale da tastiera.
  const [searchOpen, setSearchOpen] = useState(false);

  // Scorciatoia globale Cmd/Ctrl+K: apre la palette. `setSearchOpen(true)` è
  // idempotente, quindi non serve gestire il caso "già aperta".
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Dal drawer mobile: apri la palette E chiudi il drawer albero (come fa
  // `onNavigate`); su desktop il drawer non c'è e `closeTree` è un no-op innocuo.
  const openSearchFromDrawer = useCallback(() => {
    closeTree();
    setSearchOpen(true);
  }, [closeTree]);

  return (
    <div className="relative flex h-full min-h-0 flex-col lg:flex-row">
      {/* Sotto-barra Docs (solo mobile): apre l'albero a drawer e la chat. */}
      <div
        className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-ink-900 px-4 lg:hidden"
        aria-label={t("docs:space.subbarLabel")}
      >
        <button
          type="button"
          onClick={() => setTreeOpen(true)}
          aria-expanded={treeOpen}
          aria-controls="docs-tree-drawer"
          className="-ml-1 inline-flex items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:bg-ink-800 hover:text-fg"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            className="size-4"
          >
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="17" x2="20" y2="17" />
          </svg>
          {t("docs:space.index")}
        </button>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase">
          {t("docs:space.back")}
        </span>
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          aria-expanded={chatOpen}
          aria-controls="docs-chat-drawer"
          className="inline-flex items-center rounded-sm px-2 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:bg-ink-800 hover:text-fg"
        >
          {t("docs:space.chat")}
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 lg:min-h-full">
        {/* Desktop (`lg+`): sidebar come aside fisso. Mobile: stessa DocsSidebar
            dentro un drawer. Una sola variante montata per non duplicare gli id. */}
        {isDesktop ? (
          <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-ink-950">
            <DocsSidebar
              projectId={projectId}
              tree={tree}
              onOpenSearch={() => setSearchOpen(true)}
            />
          </aside>
        ) : (
          <Drawer
            open={treeOpen}
            onClose={closeTree}
            side="left"
            aria-label={t("docs:space.indexLabel")}
          >
            <div id="docs-tree-drawer" className="h-full bg-ink-950">
              <DocsSidebar
                projectId={projectId}
                tree={tree}
                onNavigate={closeTree}
                onOpenSearch={openSearchFromDrawer}
              />
            </div>
          </Drawer>
        )}

        <section className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </section>

        {/* Zona destra: chat RAG (colonna su desktop, drawer su mobile). */}
        <DocsChat projectId={projectId} open={chatOpen} onOpenChange={setChatOpen} />
      </div>

      {/* Command palette di ricerca (Cmd/K): modale a livello di layout. */}
      <DocsCommandPalette
        projectId={projectId}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </div>
  );
}

/**
 * Indice dello spazio (`/docs/$projectId`, nessuno slug): stato "seleziona una
 * pagina". L'overview tecnica eventuale resta raggiungibile dall'albero; non
 * facciamo redirect automatico per non rincorrere uno slug che potrebbe non
 * esistere (es. spazi con sole pagine manuali).
 */
export function DocsSpaceIndex() {
  const { t } = useTranslation();
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="text-center">
        <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
          {t("docs:space.selectPage")}
        </p>
        <p className="mt-2 text-sm text-fg-muted">{t("docs:space.selectPageHint")}</p>
      </div>
    </div>
  );
}

/** Badge mono dello stile dell'app (sorgente/commit/manuale). */
function MetaBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-line bg-ink-900 px-2 py-1 font-mono text-[11px] tracking-[0.04em] text-fg-muted">
      {children}
    </span>
  );
}

/** Riga badge: documenta `sourcePath` + commit di generazione (quando presenti). */
function PageBadges({ page }: { page: DocPage }) {
  const { t } = useTranslation();
  const hasSource = Boolean(page.sourcePath);
  const hasCommit = Boolean(page.commitSha);
  if (!hasSource && !hasCommit && !page.isManual) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {hasSource && (
        <MetaBadge>{t("docs:space.documents", { path: page.sourcePath })}</MetaBadge>
      )}
      {hasCommit && (
        <MetaBadge>
          {t("docs:space.generatedAtCommit", { commit: page.commitSha!.slice(0, 7) })}
        </MetaBadge>
      )}
      {page.isManual && <MetaBadge>{t("docs:space.manualBadge")}</MetaBadge>}
    </div>
  );
}

/** Ordine dei gruppi di cross-link + la chiave i18n della loro intestazione. */
const LINK_GROUP_ORDER: DocPageLink["type"][] = ["implemented_by", "implements", "related"];

const LINK_GROUP_LABEL_KEY: Record<DocPageLink["type"], string> = {
  implemented_by: "docs:space.linksImplementedBy",
  implements: "docs:space.linksImplements",
  related: "docs:space.linksRelated",
};

/**
 * Sezione "Related" in fondo alla pagina: raggruppa i cross-link per type
 * (Implemented by / Implements / Related), ognuno una lista di Link allo slug.
 * Restituisce null se non ci sono link (la sezione sparisce). Eredita il layout
 * della pagina: su mobile i gruppi semplicemente si impilano.
 */
function PageLinks({ projectId, links }: { projectId: string; links: DocPageLink[] }) {
  const { t } = useTranslation();
  if (links.length === 0) return null;

  return (
    <section className="mt-10 border-t border-line pt-6" aria-label={t("docs:space.linksHeading")}>
      <h2 className="font-mono text-[11px] tracking-[0.18em] text-fg-faint uppercase">
        {t("docs:space.linksHeading")}
      </h2>
      <div className="mt-4 flex flex-col gap-5">
        {LINK_GROUP_ORDER.map((type) => {
          const group = links.filter((link) => link.type === type);
          if (group.length === 0) return null;
          return (
            <div key={type}>
              <p className="font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
                {t(LINK_GROUP_LABEL_KEY[type])}
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {group.map((link) => (
                  <li key={`${type}:${link.slug}`}>
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
          );
        })}
      </div>
    </section>
  );
}

/**
 * Render di una pagina (`/docs/$projectId/$slug`): titolo, riga badge e corpo
 * markdown (riuso `Markdown`, sanitizzato). 404 → messaggio amichevole.
 *
 * Solo per le pagine manuali (`isManual`) mostra le azioni Edit/Delete (M7.3):
 * Edit apre inline `DocsManualForm`, Delete chiede conferma poi elimina e torna
 * all'indice dello spazio. Le pagine autogenerate NON mostrano alcun controllo
 * di modifica/eliminazione.
 */
export function DocsPageView() {
  const { t } = useTranslation();
  const { projectId, slug } = useParams({ from: "/authed/docs/$projectId/$slug" });
  // Non-suspense: il loader prefetcha la pagina (happy path già in cache, niente
  // spinner), ma un 404 — pagina rimossa da una rigenerazione — lo gestiamo
  // inline qui invece di farlo esplodere nel pannello d'errore della route.
  const { data: page, error } = useQuery({ ...docPageQueryOptions(projectId, slug), retry: false });

  const [editing, setEditing] = useState(false);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="text-center">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("docs:space.pageNotFound")}
          </p>
          <p className="mt-2 text-sm text-fg-muted">{t("docs:space.pageNotFoundHint")}</p>
        </div>
      </div>
    );
  }

  // Errori non-404: lasciali al pannello d'errore globale della route.
  if (error) throw error;
  // Il loader ha già messo la pagina in cache: questo ramo copre solo il caso
  // limite di un primo render senza dati (navigazione client senza prefetch).
  if (!page) return null;

  if (editing && page.isManual) {
    return (
      <DocsManualForm
        projectId={projectId}
        page={page}
        onCancel={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    );
  }

  return (
    <article className="mx-auto max-w-3xl p-8">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-xl font-semibold">{page.title}</h1>
          {/* Edit/Delete SOLO per le pagine manuali: le autogenerate sono protette. */}
          {page.isManual && (
            <ManualPageActions projectId={projectId} page={page} onEdit={() => setEditing(true)} />
          )}
        </div>
        <PageBadges page={page} />
      </header>
      <div className="mt-6">
        <Markdown source={page.body} />
      </div>
      {page.links && <PageLinks projectId={projectId} links={page.links} />}
    </article>
  );
}

/** Azioni Edit/Delete di una pagina manuale (delete con conferma a due tempi). */
function ManualPageActions({
  projectId,
  page,
  onEdit,
}: {
  projectId: string;
  page: DocPage;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const deletion = useMutation({
    mutationFn: () => deleteManualPage(projectId, page.id),
    onSuccess: async () => {
      // Albero (pagina rimossa) + pagina stessa: riconcilia poi torna all'indice.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: docsKeys.tree(projectId) }),
        queryClient.invalidateQueries({ queryKey: docsKeys.page(projectId, page.slug) }),
      ]);
      await navigate({ to: "/docs/$projectId", params: { projectId } });
    },
  });

  return (
    <div className="flex shrink-0 items-center gap-2">
      {confirming ? (
        <>
          <ActionButton
            onClick={() => deletion.mutate()}
            disabled={deletion.isPending}
            danger
            label={deletion.isPending ? t("docs:manual.deleting") : t("docs:manual.confirm")}
          />
          <ActionButton onClick={() => setConfirming(false)} label={t("docs:manual.cancel")} />
        </>
      ) : (
        <>
          <ActionButton onClick={onEdit} label={t("docs:manual.edit")} />
          <ActionButton onClick={() => setConfirming(true)} danger label={t("docs:manual.delete")} />
        </>
      )}
    </div>
  );
}

/** Bottoncino mono delle azioni pagina (variante danger per il delete). */
function ActionButton({
  onClick,
  label,
  danger,
  disabled,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm border px-2 py-1 font-mono text-[11px] tracking-[0.06em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        danger
          ? "border-danger/30 text-danger hover:bg-danger/10"
          : "border-line-strong text-fg-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Rotta di creazione di una pagina manuale (`/docs/$projectId/new`): monta
 * `DocsManualForm` in modalità "create". Cancel torna all'indice dello spazio.
 */
export function DocsManualNew() {
  const { projectId } = useParams({ from: "/authed/docs/$projectId/new" });
  const navigate = useNavigate();
  return (
    <DocsManualForm
      projectId={projectId}
      onCancel={() => void navigate({ to: "/docs/$projectId", params: { projectId } })}
    />
  );
}
