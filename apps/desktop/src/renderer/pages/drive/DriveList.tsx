import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { DriveFileRow, DriveSort, FolderLinkView } from "../../data/types";
import { hasModKey } from "../../platform/platform";
import { useToast } from "../../tasks-ui/Toast";
import { DisclosureGlyph } from "../chat/glyphs";
import { typing } from "../tasks/useTaskKeys";
import { DriveRow, type RowActions } from "./DriveRow";
import { setViewItems } from "./FilePreview";
import { FolderGlyph } from "./glyphs";

// L'elenco del Drive (shape drive.md §3, §7): una griglia con le intestazioni
// di colonna (`aria-sort`), i gruppi delle cartelle Google collegate in testa
// — aperti, i primi 5 nell'ordinamento scelto e «Show N more» — poi i file
// sciolti (FILES, senza nome se non ci sono cartelle). Nella destinazione
// `#/drive` nessun gruppo: una riga per riferimento, la cartella sulla
// seconda linea. J/K (o le frecce) muovono la selezione; Enter apre il
// dettaglio; Space l'anteprima (o il file Google); ⌘C copia il link; Esc
// toglie la selezione. Con 500 file le righe fuori vista non si disegnano
// (`content-visibility`), senza finestre virtuali da tenere a mano.

/** Quanti file di una cartella si vedono prima di «Show N more» (A1). */
export const FOLDER_PREVIEW = 5;

/**
 * Un dialogo modale o un menu aperto si tengono J/K — ma non il pannello di
 * dettaglio sovrapposto (modale anche lui, a 1024 sempre): J/K da lì
 * scorrono i file, come affiancato.
 */
function somethingOnTop(): boolean {
  if (document.querySelector('[role="menu"]')) return true;
  return [...document.querySelectorAll('[aria-modal="true"]')].some(
    (el) => !el.hasAttribute("data-detail-panel"),
  );
}

/** Lo scheletro della pagina: 8 righe con la forma vera di una riga del Drive (56 px, due linee). */
const SKELETON_WIDTHS = ["58%", "44%", "66%", "38%", "52%", "61%", "47%", "55%"];

export function DriveSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {SKELETON_WIDTHS.map((w, i) => (
        <div
          key={i}
          data-drive-skeleton-row
          className="flex h-14 items-center gap-3 border-b border-rule pr-3 pl-4"
        >
          <span className={`h-2.5 w-12 shrink-0 self-start mt-[13px] ${bar}`} />
          <span className="ml-[24px] flex min-w-0 flex-1 flex-col gap-2">
            <span className={`block h-2.5 ${bar}`} style={{ width: w }} />
            <span className={`block h-2 ${bar} opacity-70`} style={{ width: `calc(${w} + 18%)` }} />
          </span>
          <span className="flex w-[140px] shrink-0 items-center gap-2">
            <span className="size-[22px] rounded-full bg-ink/8" />
            <span className={`h-2.5 w-16 ${bar}`} />
          </span>
          <span className={`h-2.5 w-10 shrink-0 ${bar}`} />
          <span className="flex w-[124px] shrink-0 justify-end">
            <span className={`h-2.5 w-5 ${bar}`} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Il link di un file, da incollare ovunque. */
export const fileHref = (row: Pick<DriveFileRow, "projectCode" | "code">) =>
  `#/p/${row.projectCode}/drive?file=${row.code}`;

/** I gruppi chiusi, per persona e progetto (A1): ricordati in `localStorage`. */
function groupsKey(personId: string, projectId: string) {
  return `stubwise.driveFolders.${personId}.${projectId}`;
}

function readClosed(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeClosed(key: string, closed: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(closed));
  } catch {
    // Storage bloccato: vale per questa sessione.
  }
}

interface FolderGroup {
  id: string;
  name: string;
  link: FolderLinkView | undefined;
  rows: DriveFileRow[];
}

function SortArrow({ dir }: { dir: "ascending" | "descending" }) {
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
      className="shrink-0"
    >
      <path d={dir === "descending" ? "M8 3v10M4.5 9.5 8 13l3.5-3.5" : "M8 13V3M4.5 6.5 8 3l3.5 3.5"} />
    </svg>
  );
}

const SORT_OF: Partial<Record<string, DriveSort>> = {
  name: "name",
  modified: "recent",
  opens: "most_used",
};

export function DriveList({
  rows,
  global,
  label,
  folders,
  sort,
  onSort,
  openCode,
  personId,
  storageScope,
  peopleNames,
  projectNames,
  arrived,
  actions,
  onMoveOpen,
  top,
  folderMenu,
}: {
  rows: DriveFileRow[];
  global: boolean;
  label: string;
  folders: FolderLinkView[];
  sort: DriveSort;
  onSort: (sort: DriveSort) => void;
  /** Il file aperto nel pannello (`?file=`). */
  openCode: string | undefined;
  personId: string;
  /** Il progetto, per ricordare i gruppi chiusi. */
  storageScope: string;
  peopleNames: ReadonlyMap<string, string>;
  projectNames: ReadonlyMap<string, string>;
  arrived: ReadonlySet<string>;
  actions: RowActions;
  /** J/K col pannello aperto: il file dopo / prima nella vista. */
  onMoveOpen: (row: DriveFileRow) => void;
  /** In testa all'elenco (il gruppo UPLOADING). */
  top?: ReactNode;
  /** Il menu «⋯» di una cartella (Google, Task 7): senza, non c'è. */
  folderMenu?: (link: FolderLinkView) => ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const key = groupsKey(personId, storageScope);
  const [closed, setClosed] = useState<string[]>(() => readClosed(key));
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | undefined>(openCode);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openCode) setSelected(openCode);
  }, [openCode]);

  const toggleGroup = (id: string) => {
    const next = closed.includes(id) ? closed.filter((x) => x !== id) : [...closed, id];
    setClosed(next);
    writeClosed(key, next);
  };

  // I gruppi delle cartelle (solo nel progetto), nell'ordine dei collegamenti.
  const { groups, loose } = useMemo(() => {
    if (global) return { groups: [] as FolderGroup[], loose: rows };
    const byFolder = new Map<string, FolderGroup>();
    for (const link of folders) byFolder.set(link.id, { id: link.id, name: link.name, link, rows: [] });
    const looseRows: DriveFileRow[] = [];
    for (const row of rows) {
      if (!row.folder) {
        looseRows.push(row);
        continue;
      }
      let g = byFolder.get(row.folder.id);
      if (!g) {
        g = { id: row.folder.id, name: row.folder.name, link: undefined, rows: [] };
        byFolder.set(row.folder.id, g);
      }
      g.rows.push(row);
    }
    return { groups: [...byFolder.values()].filter((g) => g.rows.length > 0), loose: looseRows };
  }, [global, rows, folders]);

  /** Le righe che si vedono, nell'ordine dello schermo: J/K e l'anteprima scorrono queste. */
  const visible = useMemo(() => {
    const out: DriveFileRow[] = [];
    for (const g of groups) {
      if (closed.includes(g.id)) continue;
      out.push(...(expanded.includes(g.id) ? g.rows : g.rows.slice(0, FOLDER_PREVIEW)));
    }
    out.push(...loose);
    return out;
  }, [groups, loose, closed, expanded]);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Il dettaglio apre l'anteprima su questi stessi file (←/→ come dalla riga).
  useEffect(() => {
    setViewItems(visible.map((r) => ({ id: r.id, code: r.code })));
  }, [visible]);
  useEffect(() => () => setViewItems([]), []);
  // L'anteprima scorre (←/→) i file nell'ordine in cui la vista li mostra.
  const rowActions = useMemo<RowActions>(
    () => ({ ...actions, onPrimary: (row) => actions.onPrimary(row, visibleRef.current) }),
    [actions],
  );

  const focusRow = (code: string) => {
    grid.current?.querySelector<HTMLElement>(`[data-drive-row="${CSS.escape(code)}"]`)?.focus();
  };

  const move = useCallback(
    (from: string | undefined, delta: 1 | -1): DriveFileRow | undefined => {
      const list = visibleRef.current;
      const at = from ? list.findIndex((r) => r.code === from) : -1;
      const next = at === -1 ? list[0] : list[at + delta];
      return next;
    },
    [],
  );

  // J/K dal pannello aperto (il fuoco non è nella griglia): il file dopo / prima.
  useEffect(() => {
    if (!openCode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (typing(e.target) || somethingOnTop()) return;
      const k = e.key.toLowerCase();
      if (k !== "j" && k !== "k") return;
      const next = move(openCode, k === "j" ? 1 : -1);
      if (!next || next.code === openCode) return;
      e.preventDefault();
      setSelected(next.code);
      onMoveOpen(next);
      grid.current
        ?.querySelector(`[data-drive-row="${CSS.escape(next.code)}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCode, move, onMoveOpen]);

  const onRowKey = useCallback(
    (e: KeyboardEvent<HTMLElement>, row: DriveFileRow) => {
      if (e.target !== e.currentTarget) return;
      const k = e.key;
      if (k === "c" && hasModKey(e) && !e.shiftKey) {
        if ((window.getSelection()?.toString() ?? "") !== "") return;
        e.preventDefault();
        void navigator.clipboard?.writeText(fileHref(row)).catch(() => {});
        toast.show(t("drive.detail.linkCopied"));
        return;
      }
      if (k === "o" && hasModKey(e)) {
        e.preventDefault();
        rowActions.onPrimary(row);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (k === "ArrowDown" || k === "ArrowUp" || k === "j" || k === "k") {
        const next = move(row.code, k === "ArrowDown" || k === "j" ? 1 : -1);
        e.preventDefault();
        if (!next) return;
        setSelected(next.code);
        focusRow(next.code);
        if (openCode && next.code !== openCode) onMoveOpen(next);
      } else if (k === "Enter") {
        e.preventDefault();
        rowActions.onOpen(row);
      } else if (k === " ") {
        e.preventDefault();
        rowActions.onPrimary(row);
      } else if (k === "Escape" && !openCode) {
        e.preventDefault();
        setSelected(undefined);
      }
    },
    [rowActions, move, openCode, onMoveOpen, t, toast],
  );

  const onFocusRow = useCallback((row: DriveFileRow) => setSelected(row.code), []);

  const tabStop = selected && visible.some((r) => r.code === selected) ? selected : visible[0]?.code;
  const person = (id: string) => peopleNames.get(id) ?? t("drive.row.someone");

  const renderRow = (row: DriveFileRow) => (
    <DriveRow
      key={row.id}
      row={row}
      global={global}
      projectName={projectNames.get(row.projectId)}
      personName={person(row.addedById)}
      selected={selected === row.code}
      current={openCode === row.code}
      focusable={tabStop === row.code}
      arrived={arrived.has(row.id)}
      actions={rowActions}
      onKeyDown={onRowKey}
      onFocusRow={onFocusRow}
    />
  );

  const ariaSort = (col: "name" | "modified" | "opens") =>
    SORT_OF[col] === sort ? (sort === "name" ? "ascending" : "descending") : undefined;
  const header = (col: "name" | "modified" | "opens", text: string, className: string) => {
    const dir = ariaSort(col);
    return (
      <span role="columnheader" aria-sort={dir ?? "none"} className={className}>
        <button
          type="button"
          onClick={() => onSort(SORT_OF[col]!)}
          className={`inline-flex items-center gap-1 rounded-sm transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink ${dir ? "text-ink" : ""}`}
        >
          {text}
          {dir && <SortArrow dir={dir} />}
        </button>
      </span>
    );
  };

  return (
    <>
    {/* Il gruppo UPLOADING sta sopra la griglia, fuori dalla sua struttura di righe. */}
    {top}
    <div ref={grid} role="grid" aria-label={label} data-drive-grid className="@container min-w-0">
      <div role="rowgroup" className="sticky top-0 z-10 bg-ground">
        <div
          role="row"
          className="@container flex h-7 items-center gap-3 border-b border-rule pr-3 pl-4 text-xs font-medium text-ink-muted"
        >
          <span role="columnheader" className="w-[72px] shrink-0">
            {t("drive.columns.code")}
          </span>
          {global && (
            <span role="columnheader" className="w-40 shrink-0 @max-[720px]:w-12">
              <span className="@max-[720px]:sr-only">{t("drive.columns.project")}</span>
            </span>
          )}
          {header("name", t("drive.columns.name"), "min-w-0 flex-1")}
          <span role="columnheader" className="w-[140px] shrink-0 @max-[720px]:w-[22px]">
            <span className="@max-[720px]:sr-only">{t("drive.columns.addedBy")}</span>
          </span>
          {header("modified", t("drive.columns.modified"), "flex w-[76px] shrink-0 justify-end @max-[720px]:hidden")}
          {header("opens", t("drive.columns.opens"), "flex w-[124px] shrink-0 justify-end whitespace-nowrap")}
        </div>
      </div>
      {groups.map((g) => {
        const open = !closed.includes(g.id);
        const showAll = expanded.includes(g.id);
        const shown = showAll ? g.rows : g.rows.slice(0, FOLDER_PREVIEW);
        const more = g.rows.length - shown.length;
        const linkedBy = g.link ? person(g.link.linkedById) : undefined;
        return (
          <div role="rowgroup" key={g.id} data-drive-folder={g.id}>
            <div
              role="row"
              aria-expanded={open}
              className="group/folder flex h-9 items-center gap-2 border-b border-rule pr-3 pl-2"
            >
              <span role="gridcell" className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  onClick={() => toggleGroup(g.id)}
                  aria-expanded={open}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
                >
                  <DisclosureGlyph open={open} />
                  <span className="text-ink-muted">
                    <FolderGlyph />
                  </span>
                  <span className="truncate text-md font-semibold text-ink">{g.name}</span>
                </button>
                {g.link && (
                  <span className="ml-1 min-w-0 truncate text-xs text-ink-muted">
                    {t("drive.folder.meta", { count: g.link.fileCount, name: linkedBy })}
                  </span>
                )}
              </span>
              {g.link && folderMenu && <span role="gridcell">{folderMenu(g.link)}</span>}
            </div>
            {open && shown.map(renderRow)}
            {open && more > 0 && (
              <div role="row" className="flex h-9 items-center border-b border-rule pl-[100px]">
                <span role="gridcell">
                  <button
                    type="button"
                    onClick={() => setExpanded((x) => [...x, g.id])}
                    className="rounded-md px-2 py-1 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
                  >
                    {t("drive.folder.showMore", { count: more, name: g.name })}
                  </button>
                </span>
              </div>
            )}
          </div>
        );
      })}
      {loose.length > 0 && (
        <div role="rowgroup" data-drive-loose>
          {groups.length > 0 && (
            <div role="row" className="flex h-9 items-end border-b border-rule px-4 pb-1.5">
              <span role="columnheader" className="heading-group">
                {t("drive.loose")}
              </span>
            </div>
          )}
          {loose.map(renderRow)}
        </div>
      )}
    </div>
    </>
  );
}
