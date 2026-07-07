import type { DocPageKind } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import type { DocTreeNode } from "../lib/docs-api";
import { docTreeQueryOptions } from "../lib/queries";
import { buildForest, type TreeItem } from "./docs-tree";

/**
 * Filtro FINE di un singolo repository nell'editor di un widget: limita il
 * retrieval della chat a un sottoinsieme delle sezioni Docs del repo. Le pagine
 * sono RAGGRUPPATE per `kind` (technical/functional/manual/releases) come nella
 * sidebar Docs (`docs-tree.tsx`): ogni gruppo è un blocco collassabile con
 * header e conteggio, dentro cui l'albero è annidato e indentato. Tre modi di
 * selezione:
 *
 * - GRUPPO intero (checkbox sull'header di gruppo): salva il `kind` nel filtro.
 *   Semantica VIVA: le pagine future di quel kind restano esposte.
 * - nodi con `sourcePath` (pagine autogenerate da un file/cartella): si spunta un
 *   PREFISSO di path, che copre il nodo e tutti i suoi discendenti con lo stesso
 *   prefisso. Selezionare `apps/webapp` include tutta la sua sottocartella.
 * - nodi senza `sourcePath` (panoramiche/manuali): si spunta lo `slug` puntuale.
 *
 * Il valore emesso (`{paths, slugs, kinds}`) è gemello di
 * `widgetRepositoryFilterSchema` di @stubwise/shared: `paths` sono prefissi di
 * sourcePath, `slugs` pagine esplicite, `kinds` gruppi interi.
 * `undefined` = nessun filtro = tutto il repo.
 *
 * SCELTA UX sul nodo coperto da un antenato (path) o dal GRUPPO: quando un nodo
 * risulta già spuntato perché un suo ANTENATO ha un path selezionato che lo copre
 * — o perché il suo kind è nei `kinds` — il suo checkbox è DISABILITATO
 * (checked + disabled) con un `title` esplicativo. Non lo si de-seleziona
 * togliendo la copertura (sarebbe magico e distruttivo per i fratelli): per
 * escluderlo si toglie la spunta al gruppo/antenato e si ri-selezionano i rami.
 * Semplice e prevedibile.
 */

/**
 * Ordine dei gruppi = quello della sidebar Docs (`docs-tree.tsx`): tecnico →
 * funzionale → manuale → release.
 */
const GROUP_ORDER: DocPageKind[] = ["technical", "functional", "product", "manual", "releases"];

const GROUP_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:space.groupTechnical",
  functional: "docs:space.groupFunctional",
  product: "docs:space.groupProduct",
  manual: "docs:space.groupManual",
  releases: "docs:space.groupReleases",
};

/** Filtro di un repo: gemello di `widgetRepositoryFilterSchema`. */
type RepositoryFilter = { paths: string[]; slugs: string[]; kinds: DocPageKind[] };

interface WidgetSectionFilterProps {
  repositoryId: string;
  repositoryName: string;
  /** Filtro corrente del repo, o `undefined` se il repo è incluso INTERO (nessun filtro fine). */
  value: RepositoryFilter | undefined;
  /** Emette il nuovo filtro, o `undefined` per rimuovere il filtro (repo intero). */
  onChange: (value: RepositoryFilter | undefined) => void;
  disabled?: boolean;
}

/**
 * Rimuove gli slash FINALI da un sourcePath. Il docs-engine li produce in modo
 * INCOERENTE: alcune directory/radici arrivano con slash finale (es.
 * `audin-api/src/controllers/`, `audin-operator-sdk/`), altre senza
 * (`audin-api/src/services`). Senza normalizzazione `pathCovers` si rompe
 * (`startsWith("a/b//")` → i figli non risultano MAI coperti dal padre) e il
 * prefisso salvato con slash finale verrebbe respinto da `repoPathSchema`
 * (@stubwise/shared) → 422. Normalizziamo qui, all'UNICO confine di lettura del
 * nodo, così `pathCovers`, lo stato del checkbox, il toggle e il valore emesso
 * usano tutti il path senza slash. Un sourcePath fatto solo di slash (`/`)
 * diventa `""` → trattato come "senza sourcePath" (selezione per slug).
 */
function normalizeSourcePath(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Normalizza i sourcePath dell'albero al confine di lettura: uno slug/dir con
 * slash finale (o solo slash → `null`) è appiattito così che tutta la logica a
 * valle veda path normalizzati.
 */
function normalizeNodes(nodes: DocTreeNode[]): DocTreeNode[] {
  return nodes.map((node) => {
    if (!node.sourcePath) return node;
    const normalized = normalizeSourcePath(node.sourcePath);
    // Solo slash (o vuoto) → nessun sourcePath: il nodo si seleziona per slug.
    return { ...node, sourcePath: normalized === "" ? null : normalized };
  });
}

/**
 * Vero se `prefix` (un path selezionato) copre `path`: uguaglianza o `path`
 * discendente diretto/indiretto di `prefix` (stesso confine di segmento, così
 * `apps/web` NON copre `apps/webapp`).
 */
function pathCovers(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Stato del checkbox di un nodo con sourcePath rispetto ai path selezionati. */
type PathCheckState = "checked" | "indeterminate" | "unchecked";

/** Raccoglie ricorsivamente tutti i nodi (self incluso) di una foresta. */
function flattenForest(items: TreeItem[], acc: TreeItem[] = []): TreeItem[] {
  for (const item of items) {
    acc.push(item);
    flattenForest(item.children, acc);
  }
  return acc;
}

export function WidgetSectionFilter({
  repositoryId,
  repositoryName,
  value,
  onChange,
  disabled,
}: WidgetSectionFilterProps) {
  const { t } = useTranslation();
  // Aperto di default se un filtro esiste già (l'utente lo sta modificando).
  const [open, setOpen] = useState(value !== undefined);

  // Albero on-demand: caricato solo quando il blocco è aperto. `retry: false` per
  // non ritentare inutilmente in caso d'errore. Un repo senza docs NON è un errore:
  // il server ritorna 200 + `[]` (albero vuoto → messaggio "nessuna doc"). Solo un
  // 404 (repository inesistente) o un errore reale (rete/500) prendono il ramo error.
  const treeQuery = useQuery({ ...docTreeQueryOptions(repositoryId), enabled: open, retry: false });
  const nodes = treeQuery.data;

  const paths = value?.paths ?? [];
  const slugs = value?.slugs ?? [];
  const kinds = value?.kinds ?? [];

  // Un path è coperto se un path selezionato lo include (se stesso o antenato).
  const coveringPath = (path: string): string | undefined =>
    paths.find((selected) => pathCovers(selected, path));

  const pathState = (node: DocTreeNode, descendants: DocTreeNode[]): PathCheckState => {
    if (node.sourcePath && coveringPath(node.sourcePath)) return "checked";
    const someDescendantCovered = descendants.some(
      (d) => d.sourcePath && coveringPath(d.sourcePath),
    );
    return someDescendantCovered ? "indeterminate" : "unchecked";
  };

  /** Applica un cambiamento partendo dal filtro corrente (materializza `undefined` → vuoto). */
  const emit = (nextPaths: string[], nextSlugs: string[], nextKinds: DocPageKind[]): void => {
    onChange({ paths: nextPaths, slugs: nextSlugs, kinds: nextKinds });
  };

  const togglePath = (sourcePath: string, checked: boolean): void => {
    if (checked) {
      // Aggiunge il path; rimuove eventuali path già selezionati che questo copre
      // (evita ridondanze del tipo apps/webapp/x sotto apps/webapp).
      const pruned = paths.filter((p) => !pathCovers(sourcePath, p));
      emit([...pruned, sourcePath], slugs, kinds);
    } else {
      emit(
        paths.filter((p) => p !== sourcePath),
        slugs,
        kinds,
      );
    }
  };

  const toggleSlug = (slug: string, checked: boolean): void => {
    emit(paths, checked ? [...slugs, slug] : slugs.filter((s) => s !== slug), kinds);
  };

  // Ogni gruppo (kind) espone la sua foresta e l'insieme di path/slug che
  // contiene: spuntare il gruppo li POTA (diventano ridondanti sotto il kind),
  // in analogia con la potatura dei path sotto un antenato.
  const groups = useMemo(() => {
    const normalized = normalizeNodes(nodes ?? []);
    return GROUP_ORDER.map((kind) => {
      const groupNodes = normalized.filter((node) => node.kind === kind);
      const forest = buildForest(groupNodes);
      const all = flattenForest(forest);
      const groupPaths = new Set(all.map((n) => n.sourcePath).filter((p): p is string => !!p));
      const groupSlugs = new Set(all.filter((n) => !n.sourcePath).map((n) => n.slug));
      return { kind, forest, count: groupNodes.length, groupPaths, groupSlugs };
    }).filter((g) => g.count > 0);
  }, [nodes]);

  const toggleKind = (
    kind: DocPageKind,
    checked: boolean,
    groupPaths: Set<string>,
    groupSlugs: Set<string>,
  ): void => {
    if (checked) {
      // Aggiunge il kind e POTA le selezioni fini ridondanti del gruppo (tutte le
      // pagine del kind sono ora coperte). Le selezioni fini rimosse NON risorgono
      // togliendo poi la spunta al gruppo (coerente con la potatura dei path).
      const prunedPaths = paths.filter((p) => !groupPaths.has(p));
      const prunedSlugs = slugs.filter((s) => !groupSlugs.has(s));
      emit(prunedPaths, prunedSlugs, [...kinds, kind]);
    } else {
      emit(
        paths,
        slugs,
        kinds.filter((k) => k !== kind),
      );
    }
  };

  const isEmptyFilter =
    value !== undefined && paths.length === 0 && slugs.length === 0 && kinds.length === 0;
  const treeIsEmpty = treeQuery.isSuccess && (nodes?.length ?? 0) === 0;
  // Un 404 (repository senza pagine/inesistente) è equivalente a un albero vuoto:
  // «nessuna documentazione». Ogni altro errore (rete = status 0, 500, …) è un
  // guasto reale e va segnalato come tale, distinto da «nessuna doc».
  const error = treeQuery.error;
  const treeMissing = error instanceof ApiError && error.status === 404;
  const treeLoadFailed = treeQuery.isError && !treeMissing;
  const showNoDocs = treeIsEmpty || treeMissing;

  // Riepilogo: gruppi + sezioni (path) + pagine (slug), con plurali; le parti a
  // zero sono omesse. Se tutto è zero non mostra nulla (l'entry vuota ha il suo
  // warning dedicato).
  const summary = [
    kinds.length > 0 ? t("widget:filter.summaryGroups", { count: kinds.length }) : null,
    paths.length > 0 ? t("widget:filter.summarySections", { count: paths.length }) : null,
    slugs.length > 0 ? t("widget:filter.summaryPages", { count: slugs.length }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <div className="ml-6 flex flex-col gap-2 border-l border-line pl-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        <span aria-hidden className="text-[10px] leading-none">
          {open ? "▾" : "▸"}
        </span>
        {t("widget:filter.toggle")}
        {value !== undefined && summary && <span className="text-signal-dim">({summary})</span>}
      </button>

      {open && (
        <div className="flex flex-col gap-2">
          {treeQuery.isLoading && (
            <p className="font-mono text-[11px] text-fg-faint">{t("widget:filter.loading")}</p>
          )}

          {showNoDocs && (
            <p className="font-mono text-[11px] text-fg-faint">{t("widget:filter.noDocs")}</p>
          )}

          {treeLoadFailed && (
            <p role="alert" className="font-mono text-[11px] text-danger">
              {t("widget:filter.loadError")}
            </p>
          )}

          {treeQuery.isSuccess && !treeIsEmpty && (
            <div className="flex flex-col gap-1.5">
              {groups.map((group) => (
                <FilterGroup
                  key={group.kind}
                  kind={group.kind}
                  label={t(GROUP_LABEL_KEY[group.kind])}
                  count={group.count}
                  forest={group.forest}
                  kindChecked={kinds.includes(group.kind)}
                  groupPaths={group.groupPaths}
                  groupSlugs={group.groupSlugs}
                  paths={paths}
                  slugs={slugs}
                  pathState={pathState}
                  coveringPath={coveringPath}
                  onToggleKind={toggleKind}
                  onTogglePath={togglePath}
                  onToggleSlug={toggleSlug}
                  disabled={disabled}
                  coveredByTitle={(covering) => t("widget:filter.coveredBy", { path: covering })}
                  coveredByGroupTitle={t("widget:filter.coveredByGroup", {
                    group: t(GROUP_LABEL_KEY[group.kind]),
                  })}
                />
              ))}
            </div>
          )}

          {isEmptyFilter && (
            <p role="alert" className="font-mono text-[11px] text-danger">
              {t("widget:filter.emptyWarning", { repository: repositoryName })}
            </p>
          )}

          {value !== undefined && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              disabled={disabled}
              className="w-fit rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("widget:filter.remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Raccoglie ricorsivamente tutti i discendenti (esclusi self) di un nodo. */
function collectDescendants(item: TreeItem, acc: TreeItem[] = []): TreeItem[] {
  for (const child of item.children) {
    acc.push(child);
    collectDescendants(child, acc);
  }
  return acc;
}

/**
 * Un gruppo (kind): header collassabile con checkbox sul gruppo intero e, dentro,
 * l'albero indentato del kind. Default collassato se nessuna selezione fine è
 * dentro, espanso altrimenti. L'header è indeterminate quando c'è una selezione
 * fine dentro ma il kind NON è selezionato interamente.
 */
function FilterGroup({
  kind,
  label,
  count,
  forest,
  kindChecked,
  groupPaths,
  groupSlugs,
  paths,
  slugs,
  pathState,
  coveringPath,
  onToggleKind,
  onTogglePath,
  onToggleSlug,
  disabled,
  coveredByTitle,
  coveredByGroupTitle,
}: {
  kind: DocPageKind;
  label: string;
  count: number;
  forest: TreeItem[];
  kindChecked: boolean;
  groupPaths: Set<string>;
  groupSlugs: Set<string>;
  paths: string[];
  slugs: string[];
  pathState: (node: DocTreeNode, descendants: DocTreeNode[]) => PathCheckState;
  coveringPath: (path: string) => string | undefined;
  onToggleKind: (
    kind: DocPageKind,
    checked: boolean,
    groupPaths: Set<string>,
    groupSlugs: Set<string>,
  ) => void;
  onTogglePath: (sourcePath: string, checked: boolean) => void;
  onToggleSlug: (slug: string, checked: boolean) => void;
  disabled?: boolean;
  coveredByTitle: (covering: string) => string;
  coveredByGroupTitle: string;
}) {
  const { t } = useTranslation();

  // Selezione fine dentro il gruppo (indipendente dal kind): un path o slug del
  // gruppo è nel filtro → header indeterminate quando il kind NON è spuntato.
  const hasFineSelection =
    paths.some((p) => groupPaths.has(p)) || slugs.some((s) => groupSlugs.has(s));

  // Default: collassato se nessuna selezione dentro (kind o fine), espanso se sì.
  const [collapsed, setCollapsed] = useState(!kindChecked && !hasFineSelection);

  return (
    <div className="rounded-sm border border-line bg-ink-950/40">
      <div className="flex items-center gap-1.5 px-2 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "docs:space.expand" : "docs:space.collapse", { title: label })}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
        >
          <span aria-hidden className="text-[11px] leading-none">
            {collapsed ? "▶" : "▼"}
          </span>
        </button>
        <label className="flex flex-1 items-center gap-2 font-mono text-[11px] tracking-[0.12em] uppercase">
          <input
            type="checkbox"
            className="size-4 accent-signal"
            aria-label={label}
            checked={kindChecked}
            ref={(el) => {
              if (el) el.indeterminate = !kindChecked && hasFineSelection;
            }}
            disabled={disabled}
            onChange={(event) =>
              onToggleKind(kind, event.target.checked, groupPaths, groupSlugs)
            }
          />
          <span className={disabled ? "text-fg-faint" : "text-fg-muted"}>{label}</span>
          <span className="text-fg-faint">{count}</span>
        </label>
      </div>
      {!collapsed && (
        <div className="border-t border-line px-2 py-2">
          <FilterNodes
            forest={forest}
            pathState={pathState}
            coveringPath={coveringPath}
            slugs={slugs}
            kindChecked={kindChecked}
            onTogglePath={onTogglePath}
            onToggleSlug={onToggleSlug}
            disabled={disabled}
            depth={0}
            coveredByTitle={coveredByTitle}
            coveredByGroupTitle={coveredByGroupTitle}
          />
        </div>
      )}
    </div>
  );
}

function FilterNodes({
  forest,
  pathState,
  coveringPath,
  slugs,
  kindChecked,
  onTogglePath,
  onToggleSlug,
  disabled,
  depth,
  coveredByTitle,
  coveredByGroupTitle,
}: {
  forest: TreeItem[];
  pathState: (node: DocTreeNode, descendants: DocTreeNode[]) => PathCheckState;
  coveringPath: (path: string) => string | undefined;
  slugs: string[];
  /** Il gruppo (kind) di questi nodi è selezionato interamente: nodi coperti+disabled. */
  kindChecked: boolean;
  onTogglePath: (sourcePath: string, checked: boolean) => void;
  onToggleSlug: (slug: string, checked: boolean) => void;
  disabled?: boolean;
  depth: number;
  coveredByTitle: (covering: string) => string;
  coveredByGroupTitle: string;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Livello 0 a filo; i livelli annidati hanno una guida verticale (rail).
  const listClass =
    depth === 0
      ? "flex flex-col gap-0.5"
      : "ml-2 flex flex-col gap-0.5 border-l border-line pl-2";

  return (
    <ul className={listClass}>
      {forest.map((item) => {
        const descendants = collectDescendants(item);
        // Un nodo con sourcePath è coperto da un ANTENATO se il path che lo copre
        // non è il suo stesso sourcePath (in tal caso il check è dell'utente).
        const covering = item.sourcePath ? coveringPath(item.sourcePath) : undefined;
        const coveredByAncestor = Boolean(
          item.sourcePath && covering && covering !== item.sourcePath,
        );
        const state = item.sourcePath ? pathState(item, descendants) : "unchecked";
        // Il gruppo intero è selezionato → il nodo è coperto dal gruppo.
        const coveredByGroup = kindChecked;
        const covered = coveredByGroup || coveredByAncestor;
        const hasChildren = item.children.length > 0;
        const isCollapsed = collapsed.has(item.id);

        // Checked: coperto dal gruppo, oppure dallo stato path/slug proprio.
        const checked = coveredByGroup
          ? true
          : item.sourcePath
            ? state === "checked"
            : slugs.includes(item.slug);
        const title = coveredByGroup
          ? coveredByGroupTitle
          : coveredByAncestor && covering
            ? coveredByTitle(covering)
            : undefined;

        return (
          <li key={item.id}>
            <div className="flex items-center gap-0.5">
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => toggleCollapse(item.id)}
                  aria-expanded={!isCollapsed}
                  aria-label={t(isCollapsed ? "docs:space.expand" : "docs:space.collapse", {
                    title: item.title,
                  })}
                  className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
                >
                  <span aria-hidden className="text-[11px] leading-none">
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                </button>
              ) : (
                <span aria-hidden className="w-6 shrink-0" />
              )}
              <label
                className={`flex min-w-0 flex-1 items-center gap-2 py-1 font-mono text-[12px] ${
                  disabled ? "text-fg-faint" : "text-fg-muted"
                }`}
              >
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-signal"
                  aria-label={item.title}
                  checked={checked}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        Boolean(item.sourcePath) && !coveredByGroup && state === "indeterminate";
                  }}
                  disabled={disabled || covered}
                  title={title}
                  onChange={(event) => {
                    if (item.sourcePath) onTogglePath(item.sourcePath, event.target.checked);
                    else onToggleSlug(item.slug, event.target.checked);
                  }}
                />
                <span className="truncate text-fg">{item.title}</span>
                {item.sourcePath && (
                  <span className="truncate text-fg-faint">{item.sourcePath}</span>
                )}
              </label>
            </div>
            {hasChildren && !isCollapsed && (
              <FilterNodes
                forest={item.children}
                pathState={pathState}
                coveringPath={coveringPath}
                slugs={slugs}
                kindChecked={kindChecked}
                onTogglePath={onTogglePath}
                onToggleSlug={onToggleSlug}
                disabled={disabled}
                depth={depth + 1}
                coveredByTitle={coveredByTitle}
                coveredByGroupTitle={coveredByGroupTitle}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
