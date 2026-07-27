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

/**
 * Ordine dei gruppi nella sidebar (registri tecnico → funzionale → product →
 * manuale). Product è la classe PUBBLICA (verticali per superficie). Le release
 * NON sono un gruppo dell'albero: sono eventi datati, non capitoli di manuale, e
 * vivono nella vista changelog dedicata (`/docs/$projectId/releases`).
 */
const GROUP_ORDER: DocPageKind[] = ["technical", "functional", "product", "manual"];

const GROUP_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:space.groupTechnical",
  functional: "docs:space.groupFunctional",
  product: "docs:space.groupProduct",
  manual: "docs:space.groupManual",
  releases: "docs:space.groupReleases",
};

/** Nodo dell'albero con i figli già risolti (gerarchia + ordinamento). */
export interface TreeItem extends DocTreeNode {
  children: TreeItem[];
}

/**
 * Ricostruisce la foresta di un gruppo dai nodi piatti: indicizza per id,
 * appende ogni nodo al suo parent (se il parent è nello stesso gruppo) e
 * ordina ogni livello per `position` poi per `title` (tie-break stabile). I
 * nodi con `parentId` fuori dal gruppo (o assente) sono radici.
 */
export function buildForest(nodes: DocTreeNode[]): TreeItem[] {
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
                // I titoli lunghi sono troncati: il tooltip nativo li mostra per
                // intero senza dover allargare la sidebar.
                title={item.title}
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

/** Chiave localStorage della categoria scelta, per repository. */
function categoryStorageKey(projectId: string): string {
  return `stubwise:docs:category:${projectId}`;
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

  // Solo le categorie che hanno davvero pagine: una tab vuota è rumore.
  const available = useMemo(
    () => GROUP_ORDER.filter((kind) => nodes.some((node) => node.kind === kind)),
    [nodes],
  );
  // Categoria della pagina aperta: entrando da una ricerca o da un cross-link la
  // sidebar deve mostrare il ramo giusto, non ripartire da "Tecnico".
  const activePageKind = useMemo(
    () => nodes.find((node) => node.slug === activeSlug)?.kind,
    [nodes, activeSlug],
  );

  // Scelta dell'utente, ricordata per repository (la categoria di lavoro cambia
  // da repo a repo). Cede alla categoria della pagina aperta, quando c'è.
  const [chosen, setChosen] = useState<DocPageKind | undefined>(() => {
    const stored = globalThis.localStorage?.getItem(categoryStorageKey(projectId));
    return GROUP_ORDER.find((kind) => kind === stored);
  });
  useEffect(() => {
    if (activePageKind) setChosen(activePageKind);
  }, [activePageKind]);

  const activeKind =
    (chosen && available.includes(chosen) ? chosen : undefined) ?? available[0];

  const selectKind = (kind: DocPageKind) => {
    setChosen(kind);
    globalThis.localStorage?.setItem(categoryStorageKey(projectId), kind);
  };

  if (!activeKind) {
    return (
      <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
        {t("docs:space.groupEmpty")}
      </p>
    );
  }

  const forest = buildForest(nodes.filter((node) => node.kind === activeKind));
  // Download ZIP della categoria ATTIVA: <a href download>, il browser scarica
  // con il cookie di sessione.
  const downloadLabel = t("docs:space.downloadCategory", {
    category: t(GROUP_LABEL_KEY[activeKind]),
  });

  return (
    <nav className="flex min-w-0 flex-col gap-2" aria-label={t("docs:space.back")}>
      {/* Tab di categoria: una sola categoria per volta, così l'albero resta
          corto e leggibile anche su repo con centinaia di pagine. */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-line pb-2">
        {available.map((kind) => {
          const count = nodes.filter((node) => node.kind === kind).length;
          const isActive = kind === activeKind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => selectKind(kind)}
              aria-pressed={isActive}
              className={`rounded-sm px-1.5 py-1 font-mono text-[10px] tracking-[0.1em] uppercase transition-colors ${
                isActive
                  ? "bg-ink-800 text-fg"
                  : "text-fg-faint hover:bg-ink-850 hover:text-fg-muted"
              }`}
            >
              {t(GROUP_LABEL_KEY[kind])}{" "}
              <span className={isActive ? "text-fg-muted" : "text-fg-faint"}>{count}</span>
            </button>
          );
        })}
        <a
          href={`/api/repositories/${projectId}/docs/export?kind=${activeKind}`}
          download
          aria-label={downloadLabel}
          title={downloadLabel}
          className="ml-auto flex items-center gap-1 rounded-sm px-1.5 py-1 font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase transition-colors hover:bg-ink-800 hover:text-fg"
        >
          <span aria-hidden>MD</span>
          <span aria-hidden className="text-[11px] leading-none">
            ⭳
          </span>
        </a>
      </div>

      <DocsTreeGroup
        key={activeKind}
        projectId={projectId}
        forest={forest}
        activeSlug={activeSlug}
        onNavigate={onNavigate}
      />
    </nav>
  );
}
