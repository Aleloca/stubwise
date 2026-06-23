import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { DocTreeNode } from "../lib/docs-api";
import { DocsGenerationPanel } from "./docs-generation-panel";
import { DocsSearch } from "./docs-search";
import { DocsTree } from "./docs-tree";

/**
 * Contenuto della sidebar dello spazio Docs (back link + pannello generazione +
 * ricerca + albero + "nuova pagina"). Estratto in un componente condiviso così
 * l'aside desktop (`hidden lg:flex`) e il drawer mobile rendono esattamente le
 * stesse cose senza duplicazione.
 *
 * `onNavigate` permette al drawer mobile di chiudersi quando si tocca un link
 * (back, una pagina dell'albero o "nuova pagina"); la chiusura su navigazione a
 * una pagina doc è comunque garantita da `useCloseOnRouteChange` lato chiamante.
 */
export function DocsSidebar({
  projectId,
  tree,
  onNavigate,
}: {
  projectId: string;
  tree: DocTreeNode[];
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <Link
        to="/docs"
        onClick={onNavigate}
        className="mb-4 inline-block font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase hover:text-fg"
      >
        ← {t("docs:space.back")}
      </Link>
      <DocsGenerationPanel projectId={projectId} />
      <DocsSearch projectId={projectId} onNavigate={onNavigate} />
      <DocsTree projectId={projectId} nodes={tree} onNavigate={onNavigate} />
      <Link
        to="/docs/$projectId/new"
        params={{ projectId }}
        onClick={onNavigate}
        className="mt-3 block rounded-sm border border-dashed border-line-strong px-2 py-1.5 text-center font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
      >
        + {t("docs:manual.newPage")}
      </Link>
    </div>
  );
}
