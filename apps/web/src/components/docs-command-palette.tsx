import type { DocPageKind } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type DocHistoryEntry,
  clearDocsHistory,
  deleteDocsHistoryEntry,
  getDocsHistory,
  recordDocsHistoryClick,
  searchDocs,
} from "../lib/docs-api";
import { formatRelativeTimeVerbose } from "../lib/format";
import { docsKeys } from "../lib/queries";

/**
 * Command palette di ricerca dei Docs (Cmd/K): modale centrale con input
 * debounced. Sotto i 2 caratteri mostra i RECENTI (cronologia server-side,
 * con rimozione/svuotamento ottimistici); da 2 caratteri in su i risultati
 * live della ricerca ibrida. Lista unificata navigabile da tastiera
 * (frecce + invio); aprire una voce la registra nella cronologia e naviga
 * alla pagina. Riusa la logica di debounce/render-risultato di `DocsSearch`.
 */

const KIND_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:search.kindTechnical",
  functional: "docs:search.kindFunctional",
  manual: "docs:search.kindManual",
};

/** Soglia minima di caratteri per interrogare la ricerca (come `DocsSearch`). */
const MIN_QUERY_LENGTH = 2;

/**
 * Riduce uno snippet markdown a testo leggibile per l'anteprima: rimuove la
 * sintassi (heading, enfasi, codice, link, liste, citazioni) che renderizzata
 * grezza nel preview confonde, e collassa gli spazi. Non è un parser completo:
 * basta a ripulire i frammenti dei chunk/pagine.
 */
function plainTextPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // blocchi di codice
    .replace(/`([^`]+)`/g, "$1") // codice inline
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // immagini
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link → testo
    .replace(/^#{1,6}\s+/gm, "") // heading
    .replace(/^\s{0,3}>\s?/gm, "") // citazioni
    .replace(/^\s*[-*+]\s+/gm, "") // elenchi puntati
    .replace(/^\s*\d+\.\s+/gm, "") // elenchi numerati
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // grassetto
    .replace(/(\*|_)(.*?)\1/g, "$2") // corsivo
    .replace(/~~(.*?)~~/g, "$2") // barrato
    .replace(/\s+/g, " ") // collassa spazi/newline
    .trim();
}

/** Voce normalizzata della lista unificata (recente o risultato di ricerca). */
interface PaletteItem {
  slug: string;
  title: string;
  kind: DocPageKind;
  snippet?: string;
  /** Istante dell'ultimo click (solo per i recenti): tempo relativo. */
  clickedAt?: string;
}

export function DocsCommandPalette({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  // Elemento a fuoco prima dell'apertura: lo ripristiniamo alla chiusura.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Debounce 250ms: il valore interrogato si aggiorna dopo l'ultima battitura.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(handle);
  }, [input]);

  // All'apertura: salva il focus corrente, focalizza l'input e azzera lo stato.
  // Alla chiusura: ripristina il focus all'elemento precedente.
  useEffect(() => {
    if (open) {
      previouslyFocused.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setInput("");
      setDebounced("");
      setActiveIndex(0);
      // Il render del dialog è sincrono; focalizziamo dopo il commit.
      const handle = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(handle);
    }
    previouslyFocused.current?.focus();
  }, [open]);

  const searchQuery = debounced;
  const searchEnabled = open && searchQuery.length >= MIN_QUERY_LENGTH;
  const historyEnabled = open && searchQuery.length < MIN_QUERY_LENGTH;
  // L'utente "vuole cercare" appena l'INPUT (non il debounced) raggiunge la
  // soglia: così mostriamo subito lo stato di caricamento già durante il
  // debounce, senza un lampo dei recenti tra una battitura e i risultati.
  const trimmedInput = input.trim();
  const wantsSearch = open && trimmedInput.length >= MIN_QUERY_LENGTH;

  const { data: history } = useQuery({
    queryKey: docsKeys.history(projectId),
    queryFn: () => getDocsHistory(projectId),
    enabled: historyEnabled,
    staleTime: 30_000,
  });

  const { data: results, isFetching: isSearching } = useQuery({
    queryKey: [...docsKeys.space(projectId), "search", searchQuery],
    queryFn: () => searchDocs(projectId, searchQuery),
    enabled: searchEnabled,
    staleTime: 30_000,
  });

  const showingRecents = !wantsSearch;

  // Lista unificata: recenti OPPURE risultati di ricerca.
  const items: PaletteItem[] = useMemo(() => {
    if (showingRecents) {
      return (history ?? []).map((entry) => ({
        slug: entry.slug,
        title: entry.title,
        kind: entry.kind,
        snippet: entry.snippet ?? undefined,
        clickedAt: entry.clickedAt,
      }));
    }
    return (results ?? []).map((result) => ({
      slug: result.slug,
      title: result.title,
      kind: result.kind,
      snippet: result.snippet,
    }));
  }, [showingRecents, history, results]);

  // La lista è cambiata (query o set di voci): riazzera la selezione.
  useEffect(() => {
    setActiveIndex(0);
  }, [showingRecents, searchQuery, items.length]);

  // --- Mutation: rimozione singola voce recente (ottimistica) ---
  const removeEntry = useMutation({
    mutationFn: (slug: string) => deleteDocsHistoryEntry(projectId, slug),
    onMutate: async (slug: string) => {
      const key = docsKeys.history(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DocHistoryEntry[]>(key);
      queryClient.setQueryData<DocHistoryEntry[]>(key, (entries) =>
        (entries ?? []).filter((entry) => entry.slug !== slug),
      );
      return { previous, key };
    },
    onError: (_error, _slug, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: docsKeys.history(projectId) });
    },
  });

  // --- Mutation: svuotamento totale della cronologia (ottimistica) ---
  const clearAll = useMutation({
    mutationFn: () => clearDocsHistory(projectId),
    onMutate: async () => {
      const key = docsKeys.history(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DocHistoryEntry[]>(key);
      queryClient.setQueryData<DocHistoryEntry[]>(key, []);
      return { previous, key };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: docsKeys.history(projectId) });
    },
  });

  function openItem(item: PaletteItem) {
    // Registra il click nella cronologia (fire-and-forget) e invalida i recenti.
    recordDocsHistoryClick(projectId, {
      slug: item.slug,
      title: item.title,
      kind: item.kind,
      snippet: item.snippet,
    })
      .then(() => queryClient.invalidateQueries({ queryKey: docsKeys.history(projectId) }))
      .catch(() => {});
    void navigate({
      to: "/docs/$projectId/$slug",
      params: { projectId, slug: item.slug },
    });
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const item = items[activeIndex];
      if (item) {
        event.preventDefault();
        openItem(item);
      }
    }
  }

  if (!open) return null;

  // In caricamento finché l'utente vuole cercare ma non abbiamo ancora i
  // risultati del termine CORRENTE: debounce in corso (input ≠ debounced) o
  // fetch in volo. Pilota skeleton e spinner.
  const isLoadingResults =
    wantsSearch && (isSearching || trimmedInput !== debounced || results === undefined);
  const noResults = wantsSearch && !isLoadingResults && (results?.length ?? 0) === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/80 p-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        // Click sul backdrop (non sul pannello) = chiusura.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("docs:palette.label")}
        onKeyDown={handleKeyDown}
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-md border border-line-strong bg-ink-900 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
      >
        {/* Input con icona di ricerca */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t("docs:palette.placeholder")}
            aria-label={t("docs:palette.label")}
            aria-controls="docs-palette-listbox"
            aria-activedescendant={
              items[activeIndex] ? `docs-palette-item-${activeIndex}` : undefined
            }
            className="w-full bg-transparent text-[15px] text-fg placeholder:text-fg-faint focus:outline-none"
          />
          {isLoadingResults && <Spinner />}
        </div>

        {/* Corpo: recenti oppure risultati */}
        <div className="max-h-[60vh] min-h-[180px] overflow-y-auto p-2">
          {showingRecents && (
            <div className="flex items-center justify-between px-2 pt-1 pb-2">
              <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
                {t("docs:palette.recents")}
              </span>
              {(history?.length ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => clearAll.mutate()}
                  className="font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase transition-colors hover:text-fg"
                >
                  {t("docs:palette.clearAll")}
                </button>
              )}
            </div>
          )}

          {isLoadingResults ? (
            <ul
              role="status"
              aria-label={t("docs:palette.searching")}
              className="flex flex-col gap-0.5"
            >
              {[0, 1, 2, 3].map((row) => (
                <li key={row} className="flex flex-col gap-1.5 rounded-sm px-2 py-2">
                  <div className="h-3 w-1/3 animate-pulse rounded-sm bg-ink-700" />
                  <div className="h-2.5 w-3/4 animate-pulse rounded-sm bg-ink-800" />
                </li>
              ))}
            </ul>
          ) : noResults ? (
            <p className="px-2 py-6 text-center font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("docs:palette.noResults")}
            </p>
          ) : (
            <ul
              id="docs-palette-listbox"
              role="listbox"
              className="flex flex-col gap-0.5"
            >
              {items.map((item, index) => (
                <PaletteRow
                  key={item.slug}
                  id={`docs-palette-item-${index}`}
                  item={item}
                  active={index === activeIndex}
                  removable={showingRecents}
                  kindLabel={t(KIND_LABEL_KEY[item.kind])}
                  recency={item.clickedAt ? formatRelativeTimeVerbose(item.clickedAt) : undefined}
                  removeLabel={t("docs:palette.removeOne", { title: item.title })}
                  onActivate={() => openItem(item)}
                  onHover={() => setActiveIndex(index)}
                  onRemove={() => removeEntry.mutate(item.slug)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        <footer className="flex items-center gap-3 border-t border-line px-4 py-2 font-mono text-[10px] tracking-[0.08em] text-fg-faint">
          <span>↑↓ {t("docs:palette.hintNav")}</span>
          <span>↵ {t("docs:palette.hintOpen")}</span>
          <span>esc {t("docs:palette.hintClose")}</span>
        </footer>
      </div>
    </div>
  );
}

function PaletteRow({
  id,
  item,
  active,
  removable,
  kindLabel,
  recency,
  removeLabel,
  onActivate,
  onHover,
  onRemove,
}: {
  id: string;
  item: PaletteItem;
  active: boolean;
  removable: boolean;
  kindLabel: string;
  recency?: string;
  removeLabel: string;
  onActivate: () => void;
  onHover: () => void;
  onRemove: () => void;
}) {
  return (
    <li id={id} role="option" aria-selected={active}>
      <div
        className={`group flex items-start gap-2 rounded-sm px-2 py-1.5 transition-colors ${
          active ? "bg-ink-800" : "hover:bg-ink-850"
        }`}
        onMouseEnter={onHover}
      >
        <button
          type="button"
          onClick={onActivate}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[13px] text-fg">{item.title}</span>
            <span className="shrink-0 font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
              {kindLabel}
            </span>
            {recency && (
              <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-fg-faint">
                {recency}
              </span>
            )}
          </span>
          {item.snippet && (
            // Anteprima: markdown ridotto a testo (evita la sintassi grezza) e
            // altezza fissa a 2 righe, così tutte le righe hanno la stessa
            // altezza a prescindere dalla lunghezza dello snippet. NB: niente
            // `block`, altrimenti sovrascriverebbe il display flex/-webkit-box
            // necessario a `line-clamp` (che così non taglierebbe più).
            <span className="mt-0.5 line-clamp-2 min-h-10 text-[12px] leading-5 text-fg-muted">
              {plainTextPreview(item.snippet)}
            </span>
          )}
        </button>
        {removable && (
          <button
            type="button"
            aria-label={removeLabel}
            onClick={onRemove}
            className="shrink-0 rounded-sm px-1 text-[14px] leading-none text-fg-faint transition-colors hover:text-fg"
          >
            ✕
          </button>
        )}
      </div>
    </li>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0 animate-spin text-fg-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="8" cy="8" r="6" className="opacity-25" />
      <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0 text-fg-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" strokeLinecap="round" />
    </svg>
  );
}
