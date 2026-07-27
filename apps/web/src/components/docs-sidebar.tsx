import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { DocTreeNode } from "../lib/docs-api";
import { DocsGenerationPanel } from "./docs-generation-panel";
import { DocsSearchTrigger } from "./docs-search-trigger";
import { DocsTree } from "./docs-tree";

/**
 * Contenuto della sidebar dello spazio Docs: back link, ricerca, brief, release,
 * albero e — IN FONDO — il box delle azioni sullo spazio (stato/trigger della
 * generazione + "nuova pagina manuale"). L'ordine segue la frequenza d'uso: si
 * naviga a ogni visita, si rigenera la documentazione una volta ogni tanto.
 * Estratto in un componente condiviso così l'aside desktop e il drawer mobile
 * rendono esattamente le stesse cose senza duplicazione.
 *
 * `onNavigate` permette al drawer mobile di chiudersi quando si tocca un link
 * (back, una pagina dell'albero o "nuova pagina"); la chiusura su navigazione a
 * una pagina doc è comunque garantita da `useCloseOnRouteChange` lato chiamante.
 *
 * `onOpenSearch` apre la command palette (Cmd/K). Dal drawer mobile il layout
 * passa una `onOpenSearch` che chiude prima il drawer (vedi `$projectId.tsx`).
 */
export function DocsSidebar({
  projectId,
  tree,
  onNavigate,
  onOpenSearch,
}: {
  projectId: string;
  tree: DocTreeNode[];
  onNavigate?: () => void;
  onOpenSearch: () => void;
}) {
  const { t } = useTranslation();
  const releaseCount = tree.filter((node) => node.kind === "releases").length;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <Link
        to="/docs"
        onClick={onNavigate}
        className="mb-4 inline-block font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase hover:text-fg"
      >
        ← {t("docs:space.back")}
      </Link>
      <DocsSearchTrigger onOpen={onOpenSearch} />
      <Link
        to="/docs/$projectId/brief"
        params={{ projectId }}
        onClick={onNavigate}
        activeProps={{ "data-active": "true" }}
        className="mb-3 block rounded-sm border border-line px-2 py-1.5 text-center font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg data-[active=true]:border-signal/40 data-[active=true]:text-signal"
      >
        {t("docs:brief.link")}
      </Link>
      {/* Changelog: voce di primo livello, fuori dall'albero (le release sono
          eventi datati). Il conteggio dà subito la misura della storia del repo. */}
      <Link
        to="/docs/$projectId/releases"
        params={{ projectId }}
        onClick={onNavigate}
        activeProps={{ "data-active": "true" }}
        className="mb-3 flex items-center justify-between gap-2 rounded-sm border border-line px-2 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg data-[active=true]:border-signal/40 data-[active=true]:text-signal"
      >
        <span>{t("docs:releases.link")}</span>
        <span className="text-fg-faint">{releaseCount}</span>
      </Link>
      {/* Grafo del codice (graphify): voce di primo livello accanto a brief e
          changelog — è un'altra LETTURA del repository, non un capitolo del
          manuale. Sempre visibile: la vista spiega da sé il caso "non
          abilitato" (e come abilitarlo), che è anche il modo in cui la feature
          si fa scoprire. */}
      <Link
        to="/docs/$projectId/graph"
        params={{ projectId }}
        onClick={onNavigate}
        activeProps={{ "data-active": "true" }}
        className="mb-3 block rounded-sm border border-line px-2 py-1.5 text-center font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg data-[active=true]:border-signal/40 data-[active=true]:text-signal"
      >
        {t("docs:graph.tab")}
      </Link>
      <DocsTree projectId={projectId} nodes={tree} onNavigate={onNavigate} />
      {/* Azioni sullo spazio, ancorate in fondo (`mt-auto`): con l'albero corto
          restano a piè di colonna invece di galleggiare a metà. */}
      <div className="mt-auto pt-4">
        <DocsGenerationPanel
          projectId={projectId}
          action={
            <Link
              to="/docs/$projectId/new"
              params={{ projectId }}
              onClick={onNavigate}
              className="block rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-center font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              + {t("docs:manual.newPage")}
            </Link>
          }
        />
      </div>
    </div>
  );
}
