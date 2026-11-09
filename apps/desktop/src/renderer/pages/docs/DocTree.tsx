import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DocKind, DocPageRef, DocTreeCategory, DocTreeNode } from "../../data/types";
import { itemClass } from "../../tasks-ui/Menu";
import { downloadText } from "../../tasks-ui/exportFile";
import { useToast } from "../../tasks-ui/Toast";
import { MoreIcon, ghostButton } from "../task/parts";
import { MenuButton } from "../tasks/controls";
import { pageLink } from "./parts";

// L'albero di uno spazio (shape docs.md §3, §7): quattro gruppi nell'ordine
// Technical, Functional, Product, Manual, ciascuno richiudibile e con «⋯ →
// Download as .zip»; dentro, le cartelle del percorso (richiudibili) e le
// pagine per titolo. Il codice della pagina non è nell'albero: sta nel
// `title` al passaggio, sulla pagina e nei risultati (A 4).
//
// Ogni gruppo è un `role="tree"`: ↑/↓ muovono, →/← aprono e chiudono (o
// vanno al primo figlio / al genitore), Home/End, Enter apre. Un solo
// elemento per albero è raggiungibile con Tab (tabindex a rotazione).
//
// Cosa è chiuso lo tiene lo spazio (`collapsed`), non l'albero: così resta
// uguale passando da una pagina all'altra e nel cassetto a 1024.

export const categoryKey = (kind: DocKind) => `cat:${kind}`;
const folderKey = (kind: DocKind, path: string) => `dir:${kind}:${path}`;
const pageKey = (page: DocPageRef) => `page:${page.id}`;

/** Le chiavi delle cartelle (non dei gruppi), per «Collapse all». */
export function folderKeys(categories: readonly DocTreeCategory[]): string[] {
  const out: string[] = [];
  const walk = (kind: DocKind, nodes: DocTreeNode[], path: string) => {
    for (const n of nodes) {
      if (n.page) continue;
      const here = path ? `${path}/${n.name}` : n.name;
      out.push(folderKey(kind, here));
      walk(kind, n.children, here);
    }
  };
  for (const c of categories) walk(c.kind, c.nodes, "");
  return out;
}

/** Le chiavi da aprire perché una pagina si veda: il suo gruppo e le sue cartelle. */
export function ancestorKeys(categories: readonly DocTreeCategory[], slug: string): string[] {
  for (const c of categories) {
    const find = (nodes: DocTreeNode[], path: string): string[] | null => {
      for (const n of nodes) {
        if (n.page) {
          if (n.page.slug === slug) return [];
          continue;
        }
        const here = path ? `${path}/${n.name}` : n.name;
        const below = find(n.children, here);
        if (below) return [folderKey(c.kind, here), ...below];
      }
      return null;
    };
    const keys = find(c.nodes, "");
    if (keys) return [categoryKey(c.kind), ...keys];
  }
  return [];
}

const pagesOf = (nodes: DocTreeNode[]): DocPageRef[] =>
  nodes.flatMap((n) => (n.page ? [n.page] : pagesOf(n.children)));

/** La freccia di un nodo che si apre: punta a destra, ruota di 90° da aperto. */
function Caret({ open }: { open: boolean }) {
  return (
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
  );
}

const nodeClass =
  "flex h-7 w-full min-w-0 cursor-default items-center gap-1.5 rounded-md pr-2 text-left text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink";

/** Rientro di un livello: 12 px, più lo spazio della freccia per le foglie. */
const indent = (level: number, leaf: boolean) => ({
  paddingLeft: 8 + (level - 1) * 12 + (leaf ? 18 : 0),
});

export function DocTree({
  categories,
  projectCode,
  repo,
  collapsed,
  onToggle,
  onExpandAll,
  onCollapseAll,
  focusCategory,
  onNavigate,
}: {
  categories: DocTreeCategory[];
  projectCode: string;
  repo: string;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Un gruppo da portare in vista col fuoco (cambia `nonce` per ripeterlo). */
  focusCategory: { kind: DocKind; nonce: number } | null;
  /** Dopo un clic su una pagina (il cassetto si chiude). */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col pb-4">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <button type="button" onClick={onExpandAll} className={`${ghostButton} h-6 px-1.5 text-xs`}>
          {t("docs.tree.expandAll")}
        </button>
        <button
          type="button"
          onClick={onCollapseAll}
          className={`${ghostButton} h-6 px-1.5 text-xs`}
        >
          {t("docs.tree.collapseAll")}
        </button>
      </div>
      {categories.map((c) => (
        <Category
          key={c.kind}
          category={c}
          projectCode={projectCode}
          repo={repo}
          collapsed={collapsed}
          onToggle={onToggle}
          focusNonce={focusCategory?.kind === c.kind ? focusCategory.nonce : null}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

function Category({
  category,
  projectCode,
  repo,
  collapsed,
  onToggle,
  focusNonce,
  onNavigate,
}: {
  category: DocTreeCategory;
  projectCode: string;
  repo: string;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  focusNonce: number | null;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const treeId = useId();
  const header = useRef<HTMLButtonElement>(null);
  const open = !collapsed.has(categoryKey(category.kind));
  const label = t(`docs.kinds.${category.kind}`);

  useEffect(() => {
    if (focusNonce === null) return;
    header.current?.focus();
    header.current?.scrollIntoView?.({ block: "nearest" });
  }, [focusNonce]);

  const download = () => {
    // Prototipo: uno zip finto (un indice delle pagine), con l'avviso che lo dice.
    const pages = pagesOf(category.nodes);
    const file = `${label}.zip`;
    downloadText(
      file,
      [`${label} — ${repo}`, "", ...pages.map((p) => `${p.code}  ${p.path}/${p.slug}.md`)].join(
        "\n",
      ),
      "application/zip",
    );
    toast.show(t("docs.tree.downloaded", { file, count: category.count }));
  };

  return (
    <section data-doc-category={category.kind} className="mt-2 flex flex-col">
      {/* Il «⋯» della categoria compare col passaggio o col fuoco sulla riga:
          fermo, a 24 px, si leggeva come un filetto puntinato. */}
      <div className="group/category flex h-8 items-center gap-1 pr-1 pl-1">
        <h3 className="min-w-0 flex-1">
          <button
            ref={header}
            type="button"
            aria-expanded={open}
            aria-controls={treeId}
            onClick={() => onToggle(categoryKey(category.kind))}
            className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
          >
            <Caret open={open} />
            <span className="heading-group truncate">{label}</span>
            <span className="num text-xs text-ink-faint">{category.count}</span>
          </button>
        </h3>
        {category.count > 0 && (
          <MenuButton
            menuLabel={t("docs.tree.more", { name: label })}
            ariaLabel={t("docs.tree.more", { name: label })}
            title={t("docs.tree.more", { name: label })}
            align="right"
            className={`${ghostButton} h-6 w-6 justify-center px-0 opacity-0 group-focus-within/category:opacity-100 group-hover/category:opacity-100 aria-expanded:bg-ink/8 aria-expanded:opacity-100`}
            label={<MoreIcon />}
          >
            {(close) => (
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  close();
                  download();
                }}
              >
                {t("docs.tree.download")}
              </button>
            )}
          </MenuButton>
        )}
      </div>
      {open &&
        (category.count === 0 ? (
          <p id={treeId} className="py-1 pl-7 text-xs text-ink-faint">
            {t("docs.tree.empty")}
          </p>
        ) : (
          <Tree
            id={treeId}
            label={label}
            category={category}
            projectCode={projectCode}
            repo={repo}
            collapsed={collapsed}
            onToggle={onToggle}
            onNavigate={onNavigate}
          />
        ))}
    </section>
  );
}

/** Le chiavi visibili nell'ordine in cui si leggono (per il tabindex a rotazione). */
function visibleKeys(
  kind: DocKind,
  nodes: DocTreeNode[],
  collapsed: ReadonlySet<string>,
  path = "",
): string[] {
  return nodes.flatMap((n) => {
    if (n.page) return [pageKey(n.page)];
    const here = path ? `${path}/${n.name}` : n.name;
    const key = folderKey(kind, here);
    return collapsed.has(key) ? [key] : [key, ...visibleKeys(kind, n.children, collapsed, here)];
  });
}

/**
 * Un nodo è il `treeitem` stesso (schema WAI dell'albero): prende il fuoco,
 * porta `aria-level`, `aria-expanded` (cartelle) e `aria-selected` (la
 * pagina aperta). La riga visibile è il suo primo figlio: il fuoco e la
 * selezione si disegnano lì, così una cartella aperta non tinge i figli.
 */
const treeItemClass =
  "outline-none [&:focus-visible>[data-row]]:outline-2 [&:focus-visible>[data-row]]:-outline-offset-2 [&:focus-visible>[data-row]]:outline-focus [&[aria-selected=true]>[data-row]]:bg-ink/10 [&[aria-selected=true]>[data-row]]:font-semibold [&[aria-selected=true]>[data-row]]:text-ink";

function Tree({
  id,
  label,
  category,
  projectCode,
  repo,
  collapsed,
  onToggle,
  onNavigate,
}: {
  id: string;
  label: string;
  category: DocTreeCategory;
  projectCode: string;
  repo: string;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { slug?: string };
  const [active, setActive] = useState<string | null>(null);
  const visible = visibleKeys(category.kind, category.nodes, collapsed);
  const currentKey = pagesOf(category.nodes).find((p) => p.slug === params.slug);
  const fallback =
    currentKey && visible.includes(pageKey(currentKey)) ? pageKey(currentKey) : visible[0];
  const tabStop = active && visible.includes(active) ? active : fallback;

  const open = (slug: string) => {
    onNavigate?.();
    void navigate(pageLink(projectCode, repo, slug));
  };

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=treeitem]")];
    const current = document.activeElement as HTMLElement | null;
    const at = current ? items.indexOf(current) : -1;
    if (at < 0) return;
    const go = (i: number) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    };
    const key = current!.dataset.key!;
    const isFolder = key.startsWith("dir:");
    switch (e.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(items.length - 1);
      case "Enter":
      case " ":
        e.preventDefault();
        if (isFolder) onToggle(key);
        else if (current!.dataset.slug) open(current!.dataset.slug);
        return;
      case "ArrowRight":
        if (!isFolder) return;
        e.preventDefault();
        if (collapsed.has(key)) onToggle(key);
        else items[at + 1]?.focus();
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (isFolder && !collapsed.has(key)) return onToggle(key);
        current!.parentElement?.closest<HTMLElement>("[role=treeitem]")?.focus();
        return;
      }
    }
  }

  const render = (nodes: DocTreeNode[], level: number, path: string) =>
    nodes.map((node) => {
      if (node.page) {
        const page = node.page;
        const key = pageKey(page);
        const selected = page.slug === params.slug;
        return (
          <li
            key={key}
            role="treeitem"
            aria-level={level}
            aria-selected={selected}
            aria-label={page.title}
            data-key={key}
            data-slug={page.slug}
            tabIndex={tabStop === key ? 0 : -1}
            className={treeItemClass}
          >
            <div
              data-row
              title={`${page.code} · ${page.title}`}
              onClick={() => open(page.slug)}
              style={indent(level, true)}
              className={nodeClass}
            >
              <span className="min-w-0 truncate">{page.title}</span>
            </div>
          </li>
        );
      }
      const here = path ? `${path}/${node.name}` : node.name;
      const key = folderKey(category.kind, here);
      const expanded = !collapsed.has(key);
      return (
        <li
          key={key}
          role="treeitem"
          aria-level={level}
          aria-expanded={expanded}
          aria-selected={false}
          aria-label={node.name}
          data-key={key}
          tabIndex={tabStop === key ? 0 : -1}
          className={treeItemClass}
        >
          <div
            data-row
            title={node.name}
            onClick={() => onToggle(key)}
            style={indent(level, false)}
            className={nodeClass}
          >
            <Caret open={expanded} />
            <span className="min-w-0 truncate">{node.name}</span>
          </div>
          {expanded && (
            <ul role="group" className="flex flex-col">
              {render(node.children, level + 1, here)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <ul
      id={id}
      role="tree"
      aria-label={label}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const key = (e.target as HTMLElement).dataset.key;
        if (key) setActive(key);
      }}
      className="flex flex-col px-1"
    >
      {render(category.nodes, 1, "")}
    </ul>
  );
}

/** Lo scheletro dell'albero: dodici righe (shape §5). */
export function DocTreeSkeleton() {
  const widths = [52, 70, 44, 64, 38, 58, 66, 48, 72, 40, 60, 54];
  return (
    <div
      data-testid="doc-tree-skeleton"
      aria-hidden="true"
      className="skeleton-breathe flex flex-col gap-2 px-3 pt-4"
    >
      {widths.map((w, i) => (
        <span key={i} className="h-3 rounded-sm bg-ink/8" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
