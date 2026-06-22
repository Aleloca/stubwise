import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DocsManualForm } from "../../components/docs-manual-form";
import { DocsTree } from "../../components/docs-tree";
import { Markdown } from "../../components/markdown";
import { ApiError } from "../../lib/api";
import { type DocPage, deleteManualPage } from "../../lib/docs-api";
import { docPageQueryOptions, docsKeys, docTreeQueryOptions } from "../../lib/queries";

/**
 * Spazio di documentazione di un progetto: layout a tre zone (M7.2).
 * - sinistra: `DocsTree` (albero a tre gruppi della generazione corrente +
 *   manuali);
 * - centro: `<Outlet />` — la pagina selezionata (`$slug`) o un placeholder
 *   "seleziona una pagina" sull'indice dello spazio;
 * - destra: spazio riservato al drawer chat (M7.5), non ancora montato.
 *
 * Ricerca (M7.4), trigger generazione (M7.4) ed editing manuale (M7.3) sono
 * fuori scope: qui solo navigazione + render in sola lettura.
 */
export function DocsSpaceLayout() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/authed/docs/$projectId" });
  const { data: tree } = useSuspenseQuery(docTreeQueryOptions(projectId));

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-line bg-ink-950 p-4">
        <Link
          to="/docs"
          className="mb-4 inline-block font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase hover:text-fg"
        >
          ← {t("docs:space.back")}
        </Link>
        <DocsTree projectId={projectId} nodes={tree} />
        <Link
          to="/docs/$projectId/new"
          params={{ projectId }}
          className="mt-3 block rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-center font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
        >
          + {t("docs:manual.newPage")}
        </Link>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </section>

      {/* Zona destra riservata al drawer chat (M7.5). */}
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
