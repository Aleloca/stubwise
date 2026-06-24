import type { DocPageKind } from "@stubwise/shared";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocTreeNode } from "../lib/docs-api";
import { CollapsibleSection } from "./collapsible-section";

/**
 * Albero di navigazione dello spazio: tre gruppi (Tecnico/Funzionale/Manuale),
 * ciascuno una sezione collassabile (riuso `CollapsibleSection`). Dentro ogni
 * gruppo i nodi sono annidati per `parentId` e ordinati per `position`.
 *
 * La gerarchia è resa esplicita da una guida verticale (rail) per livello e da
 * un chevron su ogni nodo con figli, che li collassa/espande senza navigare (il
 * titolo resta un Link). Un toggle "comprimi/espandi tutto" per gruppo doma gli
 * alberi grandi; gli antenati della pagina attiva si riespandono da soli così
 * la selezione corrente resta sempre visibile (es. arrivando dalla ricerca).
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

/** Tutti gli id dei nodi con almeno un figlio (i "padri" collassabili). */
function collectParentIds(items: TreeItem[], acc: string[] = []): string[] {
  for (const item of items) {
    if (item.children.length > 0) {
      acc.push(item.id);
      collectParentIds(item.children, acc);
    }
  }
  return acc;
}

/**
 * Id degli ANTENATI del nodo il cui slug è `activeSlug` (il nodo stesso escluso).
 * Serve a riespandere la catena fino alla pagina attiva.
 */
function collectActiveAncestors(
  items: TreeItem[],
  activeSlug: string | undefined,
  trail: string[] = [],
  out: Set<string> = new Set(),
): Set<string> {
  if (!activeSlug) return out;
  for (const item of items) {
    if (item.slug === activeSlug) for (const id of trail) out.add(id);
    if (item.children.length > 0) {
      collectActiveAncestors(item.children, activeSlug, [...trail, item.id], out);
    }
  }
  return out;
}

function TreeNodes({
  projectId,
  items,
  depth,
  collapsed,
  onToggle,
  onNavigate,
}: {
  projectId: string;
  items: TreeItem[];
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  // Livello 0 a filo; i livelli annidati hanno una guida verticale (rail) a
  // sinistra che li lega visivamente al padre.
  const listClass =
    depth === 0
      ? "flex flex-col gap-0.5"
      : "ml-2 flex flex-col gap-0.5 border-l border-line pl-2";

  return (
    <ul className={listClass}>
      {items.map((item) => {
        const hasChildren = item.children.length > 0;
        const isCollapsed = collapsed.has(item.id);
        return (
          <li key={item.id}>
            <div className="flex items-center gap-0.5">
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => onToggle(item.id)}
                  aria-expanded={!isCollapsed}
                  aria-label={t(isCollapsed ? "docs:space.expand" : "docs:space.collapse", {
                    title: item.title,
                  })}
                  className="flex h-6 w-5 shrink-0 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
                >
                  <span aria-hidden className="text-[11px] leading-none">
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                </button>
              ) : (
                <span aria-hidden className="w-5 shrink-0" />
              )}
              <Link
                to="/docs/$projectId/$slug"
                params={{ projectId, slug: item.slug }}
                onClick={onNavigate}
                className={`block min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 text-[13px] transition-colors hover:bg-ink-850 hover:text-fg ${
                  hasChildren ? "text-fg" : "text-fg-muted"
                }`}
                activeProps={{
                  className: "bg-ink-800 text-fg",
                }}
              >
                {item.title}
              </Link>
            </div>
            {hasChildren && !isCollapsed && (
              <TreeNodes
                projectId={projectId}
                items={item.children}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                onNavigate={onNavigate}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Un gruppo (tecnico/funzionale/manuale): tiene lo stato di collasso per-nodo
 * (Set di id collassati, default vuoto = tutto espanso) e il toggle di gruppo.
 */
function DocsTreeGroup({
  projectId,
  forest,
  activeSlug,
  onNavigate,
}: {
  projectId: string;
  forest: TreeItem[];
  activeSlug: string | undefined;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const parentIds = useMemo(() => collectParentIds(forest), [forest]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Riespande la catena di antenati della pagina attiva (utile se l'utente
  // aveva collassato un ramo e poi ci atterra dentro, es. dalla ricerca).
  const activeAncestors = useMemo(
    () => collectActiveAncestors(forest, activeSlug),
    [forest, activeSlug],
  );
  useEffect(() => {
    if (activeAncestors.size === 0) return;
    setCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of activeAncestors) if (next.delete(id)) changed = true;
      return changed ? next : prev;
    });
  }, [activeAncestors]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const allCollapsed = parentIds.length > 0 && parentIds.every((id) => collapsed.has(id));

  return (
    <div className="flex flex-col">
      {parentIds.length > 0 && (
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(parentIds))}
            className="rounded-sm px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase transition-colors hover:bg-ink-850 hover:text-fg-muted"
          >
            {t(allCollapsed ? "docs:space.expandAll" : "docs:space.collapseAll")}
          </button>
        </div>
      )}
      <TreeNodes
        projectId={projectId}
        items={forest}
        depth={0}
        collapsed={collapsed}
        onToggle={toggle}
        onNavigate={onNavigate}
      />
    </div>
  );
}

export function DocsTree({
  projectId,
  nodes,
  onNavigate,
}: {
  projectId: string;
  nodes: DocTreeNode[];
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  // Slug della pagina aperta (se siamo su /docs/$projectId/$slug): per
  // riespandere i suoi antenati. `strict: false` => params del match corrente.
  const { slug: activeSlug } = useParams({ strict: false });

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
              <DocsTreeGroup
                projectId={projectId}
                forest={forest}
                activeSlug={activeSlug}
                onNavigate={onNavigate}
              />
            )}
          </CollapsibleSection>
        );
      })}
    </nav>
  );
}
