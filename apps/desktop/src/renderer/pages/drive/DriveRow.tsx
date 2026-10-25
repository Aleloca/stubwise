import { memo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DriveFileRow } from "../../data/types";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { middleEllipsis, previewKind } from "./driveFilters";
import { modifiedLabel } from "./format";
import {
  DownloadGlyph,
  ErrorGlyph,
  ExternalGlyph,
  GoogleDriveGlyph,
  OpenGlyph,
  Spinner,
  TypeGlyph,
  UnavailableGlyph,
} from "./glyphs";

// Una riga del Drive (shape drive.md §3): due linee, 56 px. Linea 1: codice,
// glifo del tipo, nome (ellissi a metà: l'estensione resta), il Drive di
// Google con la freccia d'uscita per un file Google. Linea 2: la prima riga
// del riassunto, o lo stato del contenuto quando non è pronto. A destra: chi
// l'ha aggiunto, la modifica (al passaggio le azioni rapide), le aperture
// degli ultimi 90 giorni. Nella destinazione `#/drive` anche il progetto, e
// la cartella sta sulla seconda linea. Nessuna striscia di reparto: non è
// una task.

export interface RowActions {
  /** Seleziona e apre il dettaglio (clic, Enter). */
  onOpen: (row: DriveFileRow) => void;
  /**
   * L'anteprima intera (Space) o «Open in Google Drive»: conta un'apertura.
   * `view` sono i file nell'ordine della vista (l'anteprima li scorre).
   */
  onPrimary: (row: DriveFileRow, view?: DriveFileRow[]) => void;
  onDownload: (row: DriveFileRow) => void;
}

/** La seconda linea: riassunto o stato del contenuto, in parole (mai solo colore). */
function SecondLine({ row, showFolder }: { row: DriveFileRow; showFolder: boolean }) {
  const { t } = useTranslation();
  const folder =
    showFolder && row.folder ? (
      <span className="mr-1 shrink-0">{t("drive.folder.in", { name: row.folder.name })} ·</span>
    ) : null;
  let body;
  if (row.unavailable) {
    body = (
      <span className="flex min-w-0 items-center gap-1.5 text-ink-faint">
        <UnavailableGlyph />
        <span className="truncate">{t(`drive.unavailable.${row.unavailable}`)}</span>
      </span>
    );
  } else if (row.content === "processing") {
    body = (
      <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
        <Spinner />
        <span className="truncate">{t("drive.content.processing")}</span>
      </span>
    );
  } else if (row.content === "error") {
    body = (
      <span className="flex min-w-0 items-center gap-1.5 text-critical">
        <ErrorGlyph />
        <span className="truncate">{t("drive.content.error")}</span>
      </span>
    );
  } else if (row.content === "no_text" || row.content === "unsupported") {
    body = <span className="truncate text-ink-faint">{t(`drive.content.${row.content}`)}</span>;
  } else if (row.summaryLine) {
    body = (
      <span title={row.summaryLine} className="truncate">
        {row.summaryLine}
      </span>
    );
  } else {
    body = <span className="truncate text-ink-faint">{t("drive.content.noSummary")}</span>;
  }
  return (
    <span className="flex min-w-0 items-center text-sm text-ink-muted">
      {folder}
      {body}
    </span>
  );
}

/** Il numero delle aperture: tnum, «—» a zero; si dissolve dentro solo quando cambia. */
function Opens({ count }: { count: number }) {
  const { t } = useTranslation();
  const first = useRef(count);
  const changed = count !== first.current;
  const label = t("drive.opens.count", { count });
  return (
    <span title={label} className="block text-right">
      <span
        key={count}
        aria-hidden="true"
        data-opens={count}
        className={`num text-md ${count === 0 ? "text-ink-faint" : "font-semibold text-ink"} ${changed ? "drive-count-fade" : ""}`}
      >
        {count === 0 ? "—" : count}
      </span>
    </span>
  );
}

const quickButton =
  "grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/8 hover:text-ink";

export const DriveRow = memo(function DriveRow({
  row,
  global,
  projectName,
  personName,
  selected,
  current,
  focusable,
  arrived,
  actions,
  onKeyDown,
  onFocusRow,
}: {
  row: DriveFileRow;
  /** Nella destinazione `#/drive`: colonna del progetto e cartella sulla seconda linea. */
  global: boolean;
  projectName?: string;
  personName: string;
  selected: boolean;
  /** Aperto nel pannello di dettaglio. */
  current: boolean;
  /** Il posto nella tastiera della griglia (un solo `tabIndex=0`). */
  focusable: boolean;
  /** Appena caricato: prende il suo posto (200 ms). */
  arrived: boolean;
  actions: RowActions;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, row: DriveFileRow) => void;
  onFocusRow: (row: DriveFileRow) => void;
}) {
  const { t, i18n } = useTranslation();
  const { head, tail } = middleEllipsis(row.name);
  const typeName =
    row.source === "google" ? t(`drive.googleTypes.${row.type}`) : t(`drive.types.${row.type}`);
  const opens = t("drive.opens.count", { count: row.opens90d });
  const label = global
    ? t("drive.row.labelProject", {
        code: row.code,
        project: projectName ?? row.projectCode,
        name: row.name,
        type: typeName,
        person: personName,
        opens,
      })
    : t("drive.row.label", { code: row.code, name: row.name, type: typeName, person: personName, opens });
  const kind = previewKind(row);
  const unavailable = row.unavailable !== null;
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      role="row"
      aria-label={label}
      aria-selected={selected}
      aria-current={current ? "true" : undefined}
      tabIndex={focusable ? 0 : -1}
      data-drive-row={row.code}
      onClick={() => actions.onOpen(row)}
      onKeyDown={(e) => onKeyDown(e, row)}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow(row);
      }}
      className={`group/row @container relative flex h-14 cursor-default items-center gap-3 border-b border-rule pr-3 pl-4 outline-none transition-colors duration-[var(--duration-fast)] ease-out [contain-intrinsic-size:auto_56px] [content-visibility:auto] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${selected || current ? "bg-ink/10" : "hover:bg-ink/6"} ${arrived ? "drive-arrive" : ""}`}
    >
      <span role="gridcell" className="num w-[72px] shrink-0 self-start pt-[9px] text-xs font-semibold tracking-[0.02em] text-ink">
        {row.code}
      </span>
      {global && (
        <span role="gridcell" className="flex w-40 shrink-0 items-baseline gap-1.5 self-start pt-[9px] @max-[720px]:w-12">
          <span className="num text-xs font-semibold tracking-[0.02em] text-ink">{row.projectCode}</span>
          <span title={projectName} className="min-w-0 truncate text-sm text-ink-muted @max-[720px]:hidden">
            {projectName}
          </span>
        </span>
      )}
      <span role="gridcell" className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className={`flex min-w-0 items-center gap-2 ${unavailable ? "text-ink-faint" : "text-ink"}`}>
          <span className="text-ink-muted">
            <TypeGlyph type={row.type} />
          </span>
          <span title={row.name} className="flex min-w-0 text-md">
            <span className="truncate">{head}</span>
            {tail && <span className="shrink-0">{tail}</span>}
          </span>
          {row.source === "google" && (
            <span title={t("drive.google.file")} className="flex shrink-0 items-center gap-0.5 text-ink-muted">
              <GoogleDriveGlyph />
              <ExternalGlyph size={10} />
            </span>
          )}
        </span>
        <SecondLine row={row} showFolder={global} />
      </span>
      <span role="gridcell" className="relative flex w-[140px] shrink-0 @max-[720px]:w-[22px]">
        <PersonChip personId={row.addedById} nameClassName="@max-[720px]:sr-only" />
      </span>
      <span role="gridcell" className="relative flex w-[76px] shrink-0 justify-end @max-[720px]:hidden">
        <span
          title={modifiedLabel(row.modifiedAt, t, i18n.language)}
          className="num text-xs whitespace-nowrap text-ink-muted group-focus-within/row:hidden group-hover/row:hidden"
        >
          {modifiedLabel(row.modifiedAt, t, i18n.language)}
        </span>
        <span className="hidden items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
          {row.source === "google" && !unavailable && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("drive.row.openGoogle", { code: row.code })}
              title={t("drive.google.open")}
              onClick={(e) => {
                stop(e);
                actions.onPrimary(row);
              }}
              className={quickButton}
            >
              <ExternalGlyph size={14} />
            </button>
          )}
          {row.source === "upload" && kind && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("drive.row.open", { code: row.code })}
              title={t("drive.detail.open")}
              onClick={(e) => {
                stop(e);
                actions.onPrimary(row);
              }}
              className={quickButton}
            >
              <OpenGlyph />
            </button>
          )}
          {row.source === "upload" && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("drive.row.download", { code: row.code })}
              title={t("drive.detail.download")}
              onClick={(e) => {
                stop(e);
                actions.onDownload(row);
              }}
              className={quickButton}
            >
              <DownloadGlyph />
            </button>
          )}
        </span>
      </span>
      <span role="gridcell" className="w-[124px] shrink-0">
        <Opens count={row.opens90d} />
      </span>
    </div>
  );
});
