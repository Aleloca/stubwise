import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { DocsTree } from "../../components/docs-tree";
import { Markdown } from "../../components/markdown";
import { ApiError } from "../../lib/api";
import type { DocPage } from "../../lib/docs-api";
import { docPageQueryOptions, docTreeQueryOptions } from "../../lib/queries";

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
 */
export function DocsPageView() {
  const { t } = useTranslation();
  const { projectId, slug } = useParams({ from: "/authed/docs/$projectId/$slug" });
  // Non-suspense: il loader prefetcha la pagina (happy path già in cache, niente
  // spinner), ma un 404 — pagina rimossa da una rigenerazione — lo gestiamo
  // inline qui invece di farlo esplodere nel pannello d'errore della route.
  const { data: page, error } = useQuery({ ...docPageQueryOptions(projectId, slug), retry: false });

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

  return (
    <article className="mx-auto max-w-3xl p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{page.title}</h1>
        <PageBadges page={page} />
      </header>
      <div className="mt-6">
        <Markdown source={page.body} />
      </div>
    </article>
  );
}
