import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DriveFileRow, DriveSearchHit, DriveSearchResult, GoogleOutsideHit } from "../../data/types";
import { hasModKey, shortcutLabel } from "../../platform/platform";
import { PageError } from "../../tasks-ui/PageStates";
import { Highlighted } from "../chat/ChatSearch";
import { searchWords } from "../chat/search";
import { quietButton, secondaryButton } from "../tasks/controls";
import { GoogleConnectInvite } from "./DriveBanners";
import { modifiedLabel } from "./format";
import {
  ExternalGlyph,
  GoogleDriveGlyph,
  SearchGlyph,
  Spinner,
  TypeGlyph,
  UnavailableGlyph,
} from "./glyphs";
import { openGoogleOutsideFile } from "./WhichProjectDialog";

// La ricerca nei file del Drive (shape drive-search.md): il campo «Search
// files» della barra (⌘F) e i risultati, che prendono il posto dell'elenco
// tenendo i filtri. Ogni risultato è la scheda di catalogo del file: codice,
// nome e aperture in testa, il riassunto come abstract, il passaggio
// trovato come citazione con le parole marcate (la stessa evidenziazione
// della Chat). Mostrare un risultato non conta un'apertura: Enter (o il
// clic) apre il file e conta, ⌥Enter (o «Details») apre solo il dettaglio.
// In coda i file del proprio Google Drive non ancora in un progetto, senza
// codice e visibili solo a chi cerca.

/** Attesa dopo l'ultimo tasto prima di cercare. */
export const DRIVE_SEARCH_DEBOUNCE_MS = 200;

/**
 * Il contenuto di un file non si legge (non disponibile, o ancora in
 * lettura): l'ha trovato il nome, e la riga lo dice al posto del passaggio.
 * La stessa frase nel Drive e in ⌘K.
 */
export function fileStateLine(
  file: Pick<DriveFileRow, "unavailable" | "content">,
  t: TFunction,
): string | null {
  if (file.unavailable !== null) return t("drive.search.unavailable");
  if (file.content === "processing") return t("drive.search.reading");
  return null;
}
/** Quanti file Google fuori dai progetti prima di «Show more». */
export const OUTSIDE_PREVIEW = 5;

/**
 * Il campo «Search files»: scrive la query (dopo 200 ms) con `onQuery`. Esc
 * svuota; nel campo vuoto torna all'elenco (toglie il fuoco). ↓ entra nei
 * risultati. ⌘F ci porta il fuoco da qualunque punto del Drive.
 */
export function DriveSearchField({
  query,
  onQuery,
  onEnterResults,
  inputRef,
}: {
  /** La query dell'indirizzo (`?q=`). */
  query: string;
  onQuery: (q: string) => void;
  onEnterResults: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [value, setValue] = useState(query);
  // La query cambiata da fuori (⌘K, indietro) riscrive il campo.
  const written = useRef(query);
  useEffect(() => {
    if (query !== written.current) {
      written.current = query;
      setValue(query);
    }
  }, [query]);
  const onQueryRef = useRef(onQuery);
  onQueryRef.current = onQuery;
  useEffect(() => {
    if (value === written.current) return;
    const timer = window.setTimeout(() => {
      written.current = value;
      onQueryRef.current(value);
    }, DRIVE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  const clear = () => {
    setValue("");
    written.current = "";
    onQuery("");
  };

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || !hasModKey(e) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-detail-panel])')) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inputRef]);

  return (
    <div className="relative flex h-8 w-[280px] min-w-[200px] shrink items-center max-[1200px]:w-[220px] rounded-md border border-rule text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out focus-within:border-ink/40 hover:border-rule-strong">
      <label htmlFor={id} className="pl-2.5 text-ink-faint">
        <span className="sr-only">{t("drive.search.field")}</span>
        <SearchGlyph />
      </label>
      <input
        ref={inputRef}
        id={id}
        type="search"
        data-drive-search
        placeholder={t("drive.search.field")}
        spellCheck={false}
        autoComplete="off"
        aria-keyshortcuts="Meta+F"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (value) clear();
            else e.currentTarget.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            // La query scritta vale subito: niente attesa per entrare nei risultati.
            if (value !== written.current) {
              written.current = value;
              onQuery(value);
            }
            onEnterResults();
          } else if (e.key === "Enter" && value !== written.current) {
            e.preventDefault();
            written.current = value;
            onQuery(value);
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-2 text-md text-ink outline-none placeholder:text-ink-muted focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label={t("drive.search.clear")}
          title={t("drive.search.clear")}
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
          className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/8 hover:text-ink"
        >
          <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      ) : (
        <kbd className="num pointer-events-none shrink-0 pr-2.5 font-sans text-xs text-ink-faint">
          {shortcutLabel(["mod", "F"])}
        </kbd>
      )}
    </div>
  );
}

/** Tre risultati scheletro con la forma vera (tre linee). */
function SearchSkeleton() {
  const { t } = useTranslation();
  const bar = "block rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {["52%", "64%", "45%"].map((w) => (
        <div key={w} className="flex gap-3 border-b border-rule py-3 pr-4 pl-4">
          <span className={`mt-1 h-2.5 w-12 shrink-0 ${bar}`} />
          <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <span className={`h-2.5 ${bar}`} style={{ width: w }} />
            <span className={`h-2 ${bar} opacity-70`} style={{ width: "72%" }} />
            <span className={`ml-3 h-2 ${bar} opacity-50`} style={{ width: "58%" }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SearchActions {
  /** Apre il file (anteprima intera, Google, o il dettaglio se non ha anteprima): conta. */
  open: (row: DriveFileRow, view: DriveFileRow[]) => void;
  /** Solo il pannello di dettaglio (`?file=`): non conta. */
  details: (row: DriveFileRow) => void;
}

/**
 * I risultati: «N files match “q” · Sorted by relevance», i file per
 * pertinenza, poi il gruppo IN YOUR GOOGLE DRIVE (o l'invito a collegare
 * l'account). J/K o le frecce muovono, Enter apre, ⌥Enter il dettaglio,
 * Esc torna al campo.
 */
export function DriveSearchResults({
  query,
  result,
  pending,
  error,
  onRetry,
  stale,
  global,
  projectNames,
  openCode,
  actions,
  hasFilters,
  onClearFilters,
  listRef,
  onBackToField,
}: {
  query: string;
  result: DriveSearchResult | undefined;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
  /** I risultati sono della query di prima (si vedono, la nuova è in arrivo). */
  stale: boolean;
  global: boolean;
  projectNames: ReadonlyMap<string, string>;
  openCode: string | undefined;
  actions: SearchActions;
  hasFilters: boolean;
  onClearFilters: () => void;
  listRef: RefObject<HTMLDivElement | null>;
  onBackToField: () => void;
}) {
  const { t } = useTranslation();
  const [showAllOutside, setShowAllOutside] = useState(false);
  useEffect(() => setShowAllOutside(false), [query]);
  // Coi risultati di prima (in attesa dei nuovi) restano anche la loro query,
  // il loro conteggio e le loro parole: mai la query nuova col numero vecchio.
  const shown = useRef(query);
  if (!stale && result) shown.current = query;
  const q = shown.current;
  const words = searchWords(q);

  if (error) return <PageError message={t("drive.search.error")} onRetry={onRetry} />;
  if (!result || (pending && !stale)) return <SearchSkeleton />;

  const files = result.files;
  const rows = files.map((h) => h.file);
  const outside = showAllOutside ? result.outside : result.outside.slice(0, OUTSIDE_PREVIEW);
  const moreOutside = result.outside.length - outside.length;

  /** Le righe focalizzabili, nell'ordine dello schermo. */
  const focusables = () =>
    [...(listRef.current?.querySelectorAll<HTMLElement>("[data-drive-result]") ?? [])];
  const onKey = (e: KeyboardEvent<HTMLElement>, run: { open: () => void; details?: () => void }) => {
    if (e.target !== e.currentTarget) return;
    const all = focusables();
    const at = all.indexOf(e.currentTarget);
    const k = e.key;
    if (k === "Enter") {
      e.preventDefault();
      if (e.altKey && run.details) run.details();
      else run.open();
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && (k === "ArrowDown" || k === "j")) {
      e.preventDefault();
      all[at + 1]?.focus();
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && (k === "ArrowUp" || k === "k")) {
      e.preventDefault();
      if (at <= 0) onBackToField();
      else all[at - 1]?.focus();
    } else if (k === "Escape") {
      e.preventDefault();
      onBackToField();
    }
  };

  const empty = files.length === 0 && result.outside.length === 0;
  return (
    <div
      ref={listRef}
      data-drive-results
      className={`@container ${stale ? "opacity-60 transition-opacity duration-[var(--duration-fast)]" : ""}`}
    >
      {/* Il conteggio, o «nessun file», annunciato dopo l'attesa: una regione sola. */}
      <div role="status" aria-live="polite">
        {empty ? (
          <div className="flex max-w-[60ch] flex-col items-start gap-2 px-4 pt-9 pb-1">
            <h2 className="text-lg font-semibold text-ink">{t("drive.search.emptyTitle", { q })}</h2>
            {!hasFilters && <p className="text-md text-ink-muted">{t("drive.search.emptyHint")}</p>}
          </div>
        ) : (
          <p className="num px-4 pt-3 pb-2 text-sm text-ink-muted">
            {files.length === 0
              ? t("drive.search.noneInProjects", { q })
              : t("drive.search.count", { count: files.length, q })}
            {files.length > 0 && <span className="text-ink-faint"> · {t("drive.search.sorted")}</span>}
          </p>
        )}
      </div>
      {empty && hasFilters && (
        <div className="px-4 pt-2">
          <button type="button" className={secondaryButton} onClick={onClearFilters}>
            {t("drive.filters.clear")}
          </button>
        </div>
      )}
      {empty && <div className="pb-6" />}
      {files.length > 0 && (
        <ul aria-label={t("drive.search.results", { q })} key={q} className="drive-count-fade border-t border-rule">
          {files.map((hit) => (
            <ResultRow
              key={hit.file.id}
              hit={hit}
              words={words}
              global={global}
              projectName={projectNames.get(hit.file.projectId)}
              current={openCode === hit.file.code}
              onOpen={() => actions.open(hit.file, rows)}
              onDetails={() => actions.details(hit.file)}
              onKey={onKey}
            />
          ))}
        </ul>
      )}
      {result.outside.length > 0 && (
        // Un solo filetto forte: copre quello dell’ultima riga dei file, senza
        // una fascia vuota fra due linee.
        <section aria-labelledby="drive-outside-heading" className="relative -mt-px border-t border-rule-strong pb-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 pt-4 pb-2">
            <h2 id="drive-outside-heading" className="heading-group">
              {t("drive.search.outsideTitle")}
            </h2>
            <p className="text-xs text-ink-muted">{t("drive.search.outsideNote")}</p>
          </div>
          <ul aria-labelledby="drive-outside-heading" className="border-t border-rule">
            {outside.map((o) => (
              <OutsideRow key={o.googleFileId} hit={o} words={words} onKey={onKey} />
            ))}
          </ul>
          {moreOutside > 0 && (
            <button type="button" className={`${quietButton} mt-1 ml-[88px]`} onClick={() => setShowAllOutside(true)}>
              {t("drive.search.showMore", { count: moreOutside })}
            </button>
          )}
        </section>
      )}
      {/* Vuoto (account collegato): niente filetto. */}
      <div className={`empty:hidden ${files.length > 0 || result.outside.length > 0 ? "mt-2 border-t border-rule" : ""}`}>
        <GoogleConnectInvite />
      </div>
    </div>
  );
}

const resultClass =
  "group/result relative flex cursor-default gap-3 border-b border-rule py-3 pr-4 pl-4 outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

function ResultRow({
  hit,
  words,
  global,
  projectName,
  current,
  onOpen,
  onDetails,
  onKey,
}: {
  hit: DriveSearchHit;
  words: string[];
  global: boolean;
  projectName: string | undefined;
  current: boolean;
  onOpen: () => void;
  onDetails: () => void;
  onKey: (e: KeyboardEvent<HTMLElement>, run: { open: () => void; details?: () => void }) => void;
}) {
  const { t } = useTranslation();
  const { file, passage } = hit;
  const typeName =
    file.source === "google" ? t(`drive.googleTypes.${file.type}`) : t(`drive.types.${file.type}`);
  const unavailable = file.unavailable !== null;
  const reading = !unavailable && file.content === "processing";
  const stateLine = fileStateLine(file, t);
  const opens = t("drive.opens.count", { count: file.opens90d });
  const summary = file.summary?.replace(/\s+/g, " ").trim() ?? "";
  const label = [
    `${file.code}, ${file.name}, ${typeName}, ${file.projectCode}.`,
    stateLine ??
      [
            summary && t("drive.search.labelSummary", { summary }),
            passage ? t("drive.search.labelMatched", { passage }) : t("drive.search.matchedName"),
          ]
            .filter(Boolean)
            .join(" "),
    `${opens}.`,
  ].join(" ");

  return (
    <li className="group/item relative">
      <div
        role="link"
        tabIndex={0}
        aria-label={label}
        aria-current={current ? "true" : undefined}
        data-drive-result={file.code}
        onClick={onOpen}
        onKeyDown={(e) => onKey(e, { open: onOpen, details: onDetails })}
        className={`${resultClass} ${current ? "bg-ink/10" : ""}`}
      >
        <span className="num w-[72px] shrink-0 pt-[3px] text-xs font-semibold tracking-[0.02em] text-ink">
          {file.code}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={`flex min-w-0 items-center gap-2 ${unavailable ? "text-ink-faint" : "text-ink"}`}>
            <span className="text-ink-muted">
              <TypeGlyph type={file.type} />
            </span>
            <span title={file.name} className="min-w-0 truncate text-md font-medium">
              <Highlighted text={file.name} words={words} />
            </span>
            {file.source === "google" && (
              <span title={t("drive.google.file")} className="flex shrink-0 items-center gap-0.5 text-ink-muted">
                <GoogleDriveGlyph />
                <ExternalGlyph size={10} />
              </span>
            )}
            {global && (
              <span className="ml-1 flex min-w-0 shrink items-baseline gap-1.5">
                <span className="num text-xs font-semibold tracking-[0.02em] text-ink-muted">{file.projectCode}</span>
                <span className="min-w-0 truncate text-sm text-ink-faint @max-[900px]:hidden">{projectName}</span>
              </span>
            )}
          </span>
          {unavailable ? (
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-faint">
              <UnavailableGlyph />
              <span className="truncate">{stateLine}</span>
            </span>
          ) : reading ? (
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-muted">
              <Spinner />
              <span className="truncate">{stateLine}</span>
            </span>
          ) : (
            <>
              <span className="line-clamp-2 max-w-[80ch] text-sm text-ink-muted">
                {summary || (
                  <span className="text-ink-faint">
                    {file.content === "no_text" || file.content === "unsupported"
                      ? t(`drive.content.${file.content}`)
                      : t("drive.content.noSummary")}
                  </span>
                )}
              </span>
              {passage ? (
                <span data-drive-passage className="max-w-[80ch] border-l-2 border-rule-strong pl-2.5 text-sm text-ink">
                  <span className="line-clamp-2 @max-[1100px]:line-clamp-1">
                    <Highlighted text={passage} words={words} />
                  </span>
                  {file.ocr && <span className="text-xs text-ink-faint"> {t("drive.search.scan")}</span>}
                </span>
              ) : (
                <span className="text-sm text-ink-faint">{t("drive.search.matchedName")}</span>
              )}
            </>
          )}
        </span>
        <span className="flex w-[124px] shrink-0 justify-end pt-px">
          <span
            aria-hidden="true"
            title={opens}
            className={`num text-md ${file.opens90d === 0 ? "text-ink-faint" : "font-semibold text-ink"}`}
          >
            {file.opens90d === 0 ? "—" : file.opens90d}
          </span>
        </span>
      </div>
      {/* «Details»: il pannello senza aprire il file (non conta). ⌥Enter dalla riga. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("drive.search.detailsLabel", { code: file.code })}
        onClick={onDetails}
        className="absolute top-2.5 right-12 hidden h-7 items-center rounded-md border border-rule-strong bg-ground px-2 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out group-focus-within/item:flex group-hover/item:flex hover:bg-ink/6"
      >
        {t("drive.search.details")}
      </button>
    </li>
  );
}

function OutsideRow({
  hit,
  words,
  onKey,
}: {
  hit: GoogleOutsideHit;
  words: string[];
  onKey: (e: KeyboardEvent<HTMLElement>, run: { open: () => void }) => void;
}) {
  const { t, i18n } = useTranslation();
  const open = () => openGoogleOutsideFile({ googleFileId: hit.googleFileId, name: hit.name });
  const typeName = t(`drive.googleTypes.${hit.type}`);
  return (
    <li className="relative">
      <div
        role="link"
        tabIndex={0}
        aria-label={t("drive.search.outsideLabel", {
          name: hit.name,
          type: typeName,
          owner: hit.owner,
          summary: hit.summary,
        })}
        data-drive-result
        data-drive-outside={hit.googleFileId}
        onClick={open}
        onKeyDown={(e) => onKey(e, { open })}
        className={resultClass}
      >
        {/* Nessun codice: lo prende solo entrando in un progetto. */}
        <span className="w-[72px] shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2 text-ink">
            <span className="text-ink-muted">
              <TypeGlyph type={hit.type} />
            </span>
            <span title={hit.name} className="min-w-0 truncate text-md font-medium">
              <Highlighted text={hit.name} words={words} />
            </span>
            {/* Il proprietario si accorcia prima del nome. */}
            <span className="flex shrink-0 items-center gap-0.5 text-ink-muted">
              <GoogleDriveGlyph />
              <ExternalGlyph size={10} />
            </span>
            <span className="num min-w-0 flex-1 basis-0 truncate text-sm text-ink-faint">
              {t("drive.search.owner", { owner: hit.owner })} · {modifiedLabel(hit.modifiedAt, t, i18n.language)}
            </span>
          </span>
          <span className="line-clamp-2 max-w-[80ch] text-sm text-ink-muted">{hit.summary}</span>
          {hit.passage && (
            <span className="line-clamp-1 max-w-[80ch] border-l-2 border-rule-strong pl-2.5 text-sm text-ink">
              <Highlighted text={hit.passage} words={words} />
            </span>
          )}
        </span>
        <span className="flex w-[124px] shrink-0 justify-end">
          <span className="inline-flex h-7 items-center rounded-md border border-rule-strong px-2.5 text-sm font-medium text-ink" aria-hidden="true">
            {t("drive.search.open")}
          </span>
        </span>
      </div>
    </li>
  );
}
