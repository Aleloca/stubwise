import type { DocPageKind } from "@stubwise/shared";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { DocTreeNode } from "../lib/docs-api";
import { CollapsibleSection } from "./collapsible-section";

/**
 * Albero di navigazione dello spazio: tre gruppi (Tecnico/Funzionale/Manuale),
 * ciascuno una sezione collassabile (riuso `CollapsibleSection`). Dentro ogni
 * gruppo i nodi sono annidati per `parentId` e ordinati per `position`; ogni
 * foglia/nodo è un Link allo slug (la pagina attiva si evidenzia).
 *
 * Il toggle/editor delle manuali (M7.3) e il trigger generazione (M7.4) sono
 * fuori scope: qui solo lettura/navigazione.
 */

/** Ordine dei gruppi nella sidebar (registri tecnico → funzionale → manuale). */
const GROUP_ORDER: DocPageKind[] = ["technical", "functional", "manual"];

const GROUP_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:space.groupTechnical",
  functional: "docs:space.groupFunctional",
  manual: "docs:space.groupManual",
};

/** Nodo dell'albero con i figli già risolti (gerarchia + ordinamento). */
interface TreeItem extends DocTreeNode {
  children: TreeItem[];
}

/**
 * Ricostruisce la foresta di un gruppo dai nodi piatti: indicizza per id,
 * appende ogni nodo al suo parent (se il parent è nello stesso gruppo) e
 * ordina ogni livello per `position` poi per `title` (tie-break stabile). I
 * nodi con `parentId` fuori dal gruppo (o assente) sono radici.
 */
function buildForest(nodes: DocTreeNode[]): TreeItem[] {
  const byId = new Map<string, TreeItem>();
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });

  const roots: TreeItem[] = [];
  for (const item of byId.values()) {
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (parent) parent.children.push(item);
    else roots.push(item);
  }

  const sort = (items: TreeItem[]): TreeItem[] => {
    items.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    for (const item of items) sort(item.children);
    return items;
  };
  return sort(roots);
}

function TreeNodes({ projectId, items, depth }: { projectId: string; items: TreeItem[]; depth: number }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to="/docs/$projectId/$slug"
            params={{ projectId, slug: item.slug }}
            className="block truncate rounded-sm px-2 py-1 text-[13px] text-fg-muted transition-colors hover:bg-ink-850 hover:text-fg"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            activeProps={{
              className: "bg-ink-800 text-fg shadow-[inset_2px_0_0_0_var(--color-signal)]",
            }}
          >
            {item.title}
          </Link>
          {item.children.length > 0 && (
            <TreeNodes projectId={projectId} items={item.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function DocsTree({ projectId, nodes }: { projectId: string; nodes: DocTreeNode[] }) {
  const { t } = useTranslation();

  return (
    <nav className="flex flex-col gap-2" aria-label={t("docs:space.back")}>
      {GROUP_ORDER.map((kind) => {
        const groupNodes = nodes.filter((node) => node.kind === kind);
        const forest = buildForest(groupNodes);
        return (
          <CollapsibleSection
            key={kind}
            title={t(GROUP_LABEL_KEY[kind])}
            meta={String(groupNodes.length)}
            defaultOpen={groupNodes.length > 0}
          >
            {forest.length === 0 ? (
              <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
                {t("docs:space.groupEmpty")}
              </p>
            ) : (
              <TreeNodes projectId={projectId} items={forest} depth={0} />
            )}
          </CollapsibleSection>
        );
      })}
    </nav>
  );
}
