import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import type { DocTreeNode } from "../lib/docs-api";
import { docTreeQueryOptions } from "../lib/queries";
import { buildForest, type TreeItem } from "./docs-tree";

/**
 * Filtro FINE di un singolo repository nell'editor di un widget: limita il
 * retrieval della chat a un sottoinsieme delle sezioni Docs del repo. Due modi
 * di selezione, per nodo:
 *
 * - nodi con `sourcePath` (pagine autogenerate da un file/cartella): si spunta un
 *   PREFISSO di path, che copre il nodo e tutti i suoi discendenti con lo stesso
 *   prefisso. Selezionare `apps/webapp` include tutta la sua sottocartella.
 * - nodi senza `sourcePath` (panoramiche/manuali): si spunta lo `slug` puntuale.
 *
 * Il valore emesso (`{paths, slugs}`) è gemello di `widgetRepositoryFilterSchema`
 * di @stubwise/shared: `paths` sono prefissi di sourcePath, `slugs` pagine
 * esplicite. `undefined` = nessun filtro = tutto il repo.
 *
 * SCELTA UX sul nodo coperto da un antenato: quando un nodo risulta già spuntato
 * perché un suo ANTENATO ha un path selezionato che lo copre, il suo checkbox è
 * DISABILITATO (checked + disabled) con un `title` esplicativo. Non lo si
 * de-seleziona togliendo il path dell'antenato (sarebbe magico e distruttivo per
 * i fratelli): per escluderlo si toglie la spunta all'antenato e si ri-selezionano
 * i rami desiderati. Semplice e prevedibile.
 */

interface WidgetSectionFilterProps {
  repositoryId: string;
  repositoryName: string;
  /** Filtro corrente del repo, o `undefined` se il repo è incluso INTERO (nessun filtro fine). */
  value: { paths: string[]; slugs: string[] } | undefined;
  /** Emette il nuovo filtro, o `undefined` per rimuovere il filtro (repo intero). */
  onChange: (value: { paths: string[]; slugs: string[] } | undefined) => void;
  disabled?: boolean;
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
  const emit = (nextPaths: string[], nextSlugs: string[]): void => {
    onChange({ paths: nextPaths, slugs: nextSlugs });
  };

  const togglePath = (sourcePath: string, checked: boolean): void => {
    if (checked) {
      // Aggiunge il path; rimuove eventuali path già selezionati che questo copre
      // (evita ridondanze del tipo apps/webapp/x sotto apps/webapp).
      const pruned = paths.filter((p) => !pathCovers(sourcePath, p));
      emit([...pruned, sourcePath], slugs);
    } else {
      emit(
        paths.filter((p) => p !== sourcePath),
        slugs,
      );
    }
  };

  const toggleSlug = (slug: string, checked: boolean): void => {
    emit(paths, checked ? [...slugs, slug] : slugs.filter((s) => s !== slug));
  };

  const forest = useMemo(() => buildForest(nodes ?? []), [nodes]);

  const isEmptyFilter = value !== undefined && paths.length === 0 && slugs.length === 0;
  const treeIsEmpty = treeQuery.isSuccess && (nodes?.length ?? 0) === 0;
  // Un 404 (repository senza pagine/inesistente) è equivalente a un albero vuoto:
  // «nessuna documentazione». Ogni altro errore (rete = status 0, 500, …) è un
  // guasto reale e va segnalato come tale, distinto da «nessuna doc».
  const error = treeQuery.error;
  const treeMissing = error instanceof ApiError && error.status === 404;
  const treeLoadFailed = treeQuery.isError && !treeMissing;
  const showNoDocs = treeIsEmpty || treeMissing;

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
        {value !== undefined && (
          <span className="text-signal-dim">
            {t("widget:filter.summary", { sections: paths.length, pages: slugs.length })}
          </span>
        )}
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
            <FilterNodes
              forest={forest}
              pathState={pathState}
              coveringPath={coveringPath}
              slugs={slugs}
              onTogglePath={togglePath}
              onToggleSlug={toggleSlug}
              disabled={disabled}
              depth={0}
              coveredByTitle={(covering) =>
                t("widget:filter.coveredBy", { path: covering })
              }
            />
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

function FilterNodes({
  forest,
  pathState,
  coveringPath,
  slugs,
  onTogglePath,
  onToggleSlug,
  disabled,
  depth,
  coveredByTitle,
}: {
  forest: TreeItem[];
  pathState: (node: DocTreeNode, descendants: DocTreeNode[]) => PathCheckState;
  coveringPath: (path: string) => string | undefined;
  slugs: string[];
  onTogglePath: (sourcePath: string, checked: boolean) => void;
  onToggleSlug: (slug: string, checked: boolean) => void;
  disabled?: boolean;
  depth: number;
  coveredByTitle: (covering: string) => string;
}) {
  const listClass =
    depth === 0
      ? "flex flex-col gap-1"
      : "ml-2 flex flex-col gap-1 border-l border-line pl-2";

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

        return (
          <li key={item.id}>
            <label
              className={`flex items-center gap-2 font-mono text-[12px] ${
                disabled ? "text-fg-faint" : "text-fg-muted"
              }`}
            >
              <input
                type="checkbox"
                className="size-3.5 accent-signal"
                aria-label={item.title}
                checked={item.sourcePath ? state === "checked" : slugs.includes(item.slug)}
                ref={(el) => {
                  if (el && item.sourcePath) el.indeterminate = state === "indeterminate";
                }}
                disabled={disabled || coveredByAncestor}
                title={coveredByAncestor && covering ? coveredByTitle(covering) : undefined}
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
            {item.children.length > 0 && (
              <FilterNodes
                forest={item.children}
                pathState={pathState}
                coveringPath={coveringPath}
                slugs={slugs}
                onTogglePath={onTogglePath}
                onToggleSlug={onToggleSlug}
                disabled={disabled}
                depth={depth + 1}
                coveredByTitle={coveredByTitle}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
