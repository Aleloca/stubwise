import type {
  DocPageKind,
  SearchDocHit,
  SearchDocSemanticHit,
  SearchEntityType,
  SearchHistoryItem,
  SearchResults,
} from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteSearchHistory,
  deleteSearchHistoryEntry,
  getDocsSemantic,
  getSearch,
  getSearchHistory,
  postSearchHistory,
} from "../lib/api";
import { formatRelativeTimeVerbose } from "../lib/format";

/**
 * Spotlight globale (Cmd/K): modale centrale che cerca in Ticket/Progetti/
 * Repository/Documentazione. Generalizza la vecchia palette Docs.
 *
 * DUE VELOCITÀ per la reattività percepita:
 * - debounce CORTO (150 ms) → `getSearch` (full-text federato): popola SUBITO
 *   tutti i gruppi;
 * - debounce LUNGO (600 ms) → `getDocsSemantic` (retrieval semantico): arricchisce
 *   e ri-ordina SOLO il gruppo Docs, fondendo i suoi risultati con quelli
 *   full-text (dedup per `(repositoryId, slug)`, semantica prima). Guardato da un
 *   AbortController + una guardia sull'ultima query: le risposte stantie non si
 *   applicano mai.
 *
 * SCOPE: `"global"` cerca ovunque; `{ repositoryId }` (aperta dai Docs) parte
 * ristretta a quel repository per il gruppo Docs e la cronologia, con un toggle
 * "Questa documentazione · Tutto" (Tab) per allargare a globale.
 */

/** Prop `scope`: globale, oppure ancorata a un repository (spazio Docs). */
export type SearchScope = "global" | { repositoryId: string; repositoryName?: string };

const KIND_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:search.kindTechnical",
  functional: "docs:search.kindFunctional",
  product: "docs:search.kindProduct",
  manual: "docs:search.kindManual",
  releases: "docs:search.kindReleases",
};

/** Sigla mono per tipo di entità (coerente con la nav della sidebar). */
const TYPE_CODE: Record<SearchEntityType, string> = {
  ticket: "TKT",
  project: "PRJ",
  repository: "REP",
  doc: "DOC",
};

/** Debounce della corsia veloce (full-text). */
const FAST_DEBOUNCE_MS = 150;
/** Debounce della corsia lenta (semantica Docs). */
const SLOW_DEBOUNCE_MS = 600;
/** Quanti item per gruppo si mostrano prima del "mostra altri". */
const PER_GROUP_VISIBLE = 5;

/**
 * Riduce uno snippet markdown a testo leggibile per l'anteprima: rimuove la
 * sintassi che renderizzata grezza confonde e collassa gli spazi. Non è un parser
 * completo: basta a ripulire i frammenti dei chunk/pagine e gli `<b>` di
 * `ts_headline`.
 */
function plainTextPreview(markdown: string): string {
  return markdown
    .replace(/<\/?b>/g, "") // <b> di ts_headline (full-text)
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

/** Doc fuso (full-text + semantico) del gruppo Docs. */
type MergedDoc = SearchDocHit & { score?: number };

/**
 * Voce normalizzata e navigabile della lista unificata: la route a cui va,
 * l'entità da registrare in cronologia e i campi di render (titolo/contesto/
 * snippet). Copre risultati di ricerca e voci recenti.
 */
interface PaletteItem {
  /** Chiave stabile per la lista (tipo + entità). */
  key: string;
  type: SearchEntityType;
  /** Entità per la cronologia (id o slug della doc). */
  entityId: string;
  title: string;
  /** Contesto secondario (progetto del ticket, repo della doc, slug del progetto/repo). */
  subtitle: string | null;
  /** Estratto rilevante da mostrare sotto il titolo (opzionale). */
  snippet?: string;
  /** Route di navigazione TanStack (già risolta). */
  navigate: () => void;
  /** Route persistita (per la cronologia): stringa canonica dell'entità. */
  route: string;
  /** repositoryId della doc (per il filtro cronologia in scope); solo per le doc. */
  repositoryId?: string;
  /** Tempo relativo dell'ultimo click (solo per i recenti). */
  clickedAt?: string;
}

/**
 * Fonde i doc full-text con quelli semantici: dedup per `(repositoryId, slug)`,
 * i semantici PRIMA (più rilevanti), poi i full-text non già presenti. Preserva
 * lo snippet/score del semantico quando disponibile.
 */
function mergeDocs(fullText: SearchDocHit[], semantic: SearchDocSemanticHit[]): MergedDoc[] {
  const seen = new Set<string>();
  const out: MergedDoc[] = [];
  for (const hit of semantic) {
    const dedup = `${hit.repositoryId}:${hit.slug}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(hit);
  }
  for (const hit of fullText) {
    const dedup = `${hit.repositoryId}:${hit.slug}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(hit);
  }
  return out;
}

export function GlobalSearchPalette({
  scope,
  open,
  onClose,
}: {
  scope: SearchScope;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [input, setInput] = useState("");
  const [fastQuery, setFastQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Con scope repo: false = "questa documentazione" (default), true = "Tutto".
  const [allScope, setAllScope] = useState(false);
  const scopedToRepo = scope !== "global" && !allScope;
  const scopeRepositoryId = scopedToRepo ? scope.repositoryId : undefined;

  // Corsia semantica: risultati fusi nel gruppo Docs, gestiti a mano (fuori da
  // React Query) per il controllo fine su AbortController/guardia di staleness.
  const [semantic, setSemantic] = useState<SearchDocSemanticHit[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  // La query semantica in volo: la guardia scarta le risposte stantie.
  const latestSemanticQuery = useRef<string>("");

  const inputRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const trimmedInput = input.trim();
  const wantsSearch = open && trimmedInput.length > 0;

  // All'apertura: salva il focus, focalizza l'input, azzera lo stato. Alla
  // chiusura: ripristina il focus e resetta il toggle di scope al default.
  useEffect(() => {
    if (open) {
      previouslyFocused.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setInput("");
      setFastQuery("");
      setActiveIndex(0);
      setAllScope(false);
      setSemantic([]);
      setSemanticLoading(false);
      latestSemanticQuery.current = "";
      const handle = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(handle);
    }
    previouslyFocused.current?.focus();
  }, [open]);

  // Debounce CORTO (full-text): aggiorna `fastQuery` dopo l'ultima battitura.
  useEffect(() => {
    const handle = setTimeout(() => setFastQuery(trimmedInput), FAST_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [trimmedInput]);

  const fastEnabled = open && fastQuery.length > 0;
  const { data: results, isFetching: fastFetching } = useQuery({
    queryKey: ["search", "fast", fastQuery, scopeRepositoryId ?? null],
    queryFn: () => getSearch(fastQuery, scopeRepositoryId),
    enabled: fastEnabled,
    staleTime: 30_000,
  });

  // Debounce LUNGO (semantica): dopo 600 ms dall'ultima battitura, lancia il
  // retrieval semantico. AbortController per annullare la richiesta precedente;
  // la guardia `latestSemanticQuery` scarta le risposte stantie (arrivate fuori
  // ordine). Cambiare scope/query invalida i risultati semantici correnti.
  useEffect(() => {
    if (!open || trimmedInput.length === 0) {
      setSemantic([]);
      setSemanticLoading(false);
      latestSemanticQuery.current = "";
      return;
    }
    // Chiave che identifica la richiesta corrente (query + scope): risultati di
    // una chiave diversa non vanno applicati.
    const queryKey = `${trimmedInput}::${scopeRepositoryId ?? ""}`;
    const controller = new AbortController();
    setSemanticLoading(true);
    const handle = setTimeout(() => {
      latestSemanticQuery.current = queryKey;
      getDocsSemantic(trimmedInput, scopeRepositoryId)
        .then((hits) => {
          if (controller.signal.aborted) return;
          // Guardia staleness: applica SOLO se è ancora l'ultima query lanciata.
          if (latestSemanticQuery.current !== queryKey) return;
          setSemantic(hits);
          setSemanticLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          if (latestSemanticQuery.current !== queryKey) return;
          // Best-effort: un errore semantico non degrada il full-text.
          setSemantic([]);
          setSemanticLoading(false);
        });
    }, SLOW_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [open, trimmedInput, scopeRepositoryId]);

  // Cronologia (recenti): a query vuota. In scope repo filtra a quel repository.
  const historyEnabled = open && trimmedInput.length === 0;
  const { data: history } = useQuery({
    queryKey: ["search", "history", scopeRepositoryId ?? null],
    queryFn: () => getSearchHistory(scopeRepositoryId),
    enabled: historyEnabled,
    staleTime: 30_000,
  });

  const historyKey = ["search", "history", scopeRepositoryId ?? null] as const;

  // --- Mutation: rimozione singola voce recente (ottimistica) ---
  const removeEntry = useMutation({
    mutationFn: (entry: { type: SearchEntityType; entityId: string }) =>
      deleteSearchHistoryEntry(entry.type, entry.entityId),
    onMutate: async (entry) => {
      await queryClient.cancelQueries({ queryKey: historyKey });
      const previous = queryClient.getQueryData<SearchHistoryItem[]>(historyKey);
      queryClient.setQueryData<SearchHistoryItem[]>(historyKey, (items) =>
        (items ?? []).filter((i) => !(i.type === entry.type && i.entityId === entry.entityId)),
      );
      return { previous };
    },
    onError: (_error, _entry, context) => {
      if (context?.previous) queryClient.setQueryData(historyKey, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: historyKey });
    },
  });

  // --- Mutation: svuotamento totale della cronologia (ottimistica) ---
  const clearAll = useMutation({
    mutationFn: () => deleteSearchHistory(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: historyKey });
      const previous = queryClient.getQueryData<SearchHistoryItem[]>(historyKey);
      queryClient.setQueryData<SearchHistoryItem[]>(historyKey, []);
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(historyKey, context.previous);
    },
    onSettled: () => {
      // La clear è globale (non filtrata per repo): invalida tutte le cronologie.
      void queryClient.invalidateQueries({ queryKey: ["search", "history"] });
    },
  });

  // --- Costruzione della lista unificata ---

  const kindLabel = useCallback((kind: DocPageKind) => t(KIND_LABEL_KEY[kind]), [t]);

  // Voci recenti (query vuota) → PaletteItem, navigando alla route persistita.
  const recentItems = useMemo<PaletteItem[]>(() => {
    return (history ?? []).map((entry: SearchHistoryItem) => ({
      key: `${entry.type}:${entry.entityId}`,
      type: entry.type,
      entityId: entry.entityId,
      title: entry.title,
      subtitle: entry.subtitle,
      // La route dei recenti è una stringa persistita arbitraria (non un literal
      // di route tipizzato): navighiamo per stringa grezza.
      navigate: () => void navigate({ to: entry.route as string }),
      route: entry.route,
      repositoryId: entry.repositoryId ?? undefined,
      clickedAt: entry.clickedAt,
    }));
  }, [history, navigate]);

  // Gruppi di risultati (query non vuota): ordine TKT/PRJ/REP/DOC. Il gruppo Docs
  // fonde full-text + semantica.
  const groups = useMemo(() => {
    const r: SearchResults | undefined = results;
    const mergedDocs = mergeDocs(r?.docs.items ?? [], semantic);
    return [
      {
        type: "ticket" as const,
        labelKey: "search:groups.tickets",
        hasMore: r?.tickets.hasMore ?? false,
        items: (r?.tickets.items ?? []).map<PaletteItem>((ticket) => ({
          key: `ticket:${ticket.id}`,
          type: "ticket",
          entityId: ticket.id,
          title: `#${ticket.number} ${ticket.title}`,
          subtitle: ticket.projectName,
          snippet: ticket.snippet,
          navigate: () =>
            void navigate({ to: "/tickets/$id", params: { id: ticket.id } }),
          route: `/tickets/${ticket.id}`,
        })),
      },
      {
        type: "project" as const,
        labelKey: "search:groups.projects",
        hasMore: r?.projects.hasMore ?? false,
        items: (r?.projects.items ?? []).map<PaletteItem>((project) => ({
          key: `project:${project.id}`,
          type: "project",
          entityId: project.id,
          title: project.name,
          subtitle: project.slug,
          snippet: project.snippet ?? undefined,
          navigate: () =>
            void navigate({ to: "/projects/$projectId", params: { projectId: project.id } }),
          route: `/projects/${project.id}`,
        })),
      },
      {
        type: "repository" as const,
        labelKey: "search:groups.repositories",
        hasMore: r?.repositories.hasMore ?? false,
        items: (r?.repositories.items ?? []).map<PaletteItem>((repo) => ({
          key: `repository:${repo.id}`,
          type: "repository",
          entityId: repo.id,
          title: repo.name,
          subtitle: repo.slug,
          snippet: repo.repoUrl,
          navigate: () =>
            void navigate({ to: "/repositories/$slug", params: { slug: repo.slug } }),
          route: `/repositories/${repo.slug}`,
        })),
      },
      {
        type: "doc" as const,
        labelKey: "search:groups.docs",
        // "mostra altri" del gruppo Docs: hasMore full-text O più di quanti ne
        // mostriamo dopo la fusione con la semantica.
        hasMore: (r?.docs.hasMore ?? false) || mergedDocs.length > PER_GROUP_VISIBLE,
        items: mergedDocs.map<PaletteItem>((doc) => ({
          key: `doc:${doc.repositoryId}:${doc.slug}`,
          type: "doc",
          entityId: doc.slug,
          title: doc.title,
          subtitle: `${doc.repositoryName} · ${kindLabel(doc.kind)}`,
          snippet: doc.snippet,
          navigate: () =>
            void navigate({
              to: "/docs/$projectId/$slug",
              params: { projectId: doc.repositoryId, slug: doc.slug },
            }),
          route: `/docs/${doc.repositoryId}/${doc.slug}`,
          repositoryId: doc.repositoryId,
        })),
      },
    ];
  }, [results, semantic, navigate, kindLabel]);

  // Quali gruppi sono espansi ("mostra altri" cliccato): mostrano tutti i loro
  // item invece dei primi PER_GROUP_VISIBLE.
  const [expanded, setExpanded] = useState<Set<SearchEntityType>>(new Set());
  useEffect(() => {
    // Nuova query/scope: ricollassa i gruppi.
    setExpanded(new Set());
  }, [fastQuery, scopeRepositoryId]);

  const showingRecents = !wantsSearch;

  // La lista PIATTA navigabile da tastiera (recenti O risultati, con la finestra
  // per-gruppo). Ogni item porta la sua funzione di navigazione.
  const flatItems = useMemo<PaletteItem[]>(() => {
    if (showingRecents) return recentItems;
    return groups.flatMap((group) => {
      const isExpanded = expanded.has(group.type);
      return isExpanded ? group.items : group.items.slice(0, PER_GROUP_VISIBLE);
    });
  }, [showingRecents, recentItems, groups, expanded]);

  // Cambio lista (query/scope/set di voci): riazzera la selezione.
  useEffect(() => {
    setActiveIndex(0);
  }, [showingRecents, fastQuery, scopeRepositoryId, flatItems.length]);

  function openItem(item: PaletteItem) {
    // Registra il click nella cronologia (fire-and-forget). Le voci doc portano
    // il repositoryId per il filtro in scope; per gli altri tipi resta null.
    postSearchHistory({
      type: item.type,
      entityId: item.entityId,
      title: item.title,
      subtitle: item.subtitle ?? undefined,
      route: item.route,
      repositoryId: item.repositoryId,
    }).catch(() => {});
    item.navigate();
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // Tab: alterna lo scope (solo quando la palette è ancorata a un repository).
    if (event.key === "Tab" && scope !== "global") {
      event.preventDefault();
      setAllScope((v) => !v);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(flatItems.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const item = flatItems[activeIndex];
      if (item) {
        event.preventDefault();
        openItem(item);
      }
    }
  }

  if (!open) return null;

  // In caricamento (spinner globale) quando l'utente vuole cercare ma non abbiamo
  // ancora i risultati full-text del termine CORRENTE.
  const fastLoading =
    wantsSearch && (fastFetching || trimmedInput !== fastQuery || results === undefined);
  const totalResults = groups.reduce((sum, group) => sum + group.items.length, 0);
  const noResults = wantsSearch && !fastLoading && totalResults === 0 && !semanticLoading;

  const placeholder =
    scope === "global" ? t("search:placeholderGlobal") : t("docs:palette.placeholder");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/80 p-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("search:label")}
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
            placeholder={placeholder}
            aria-label={t("search:label")}
            aria-controls="global-search-listbox"
            aria-activedescendant={
              flatItems[activeIndex] ? `global-search-item-${activeIndex}` : undefined
            }
            className="w-full bg-transparent text-[15px] text-fg placeholder:text-fg-faint focus:outline-none"
          />
          {(fastLoading || semanticLoading) && <Spinner />}
        </div>

        {/* Scope switch: solo quando la palette è ancorata a un repository. */}
        {scope !== "global" && (
          <div className="flex items-center gap-1 border-b border-line px-4 py-2">
            <ScopeButton
              active={scopedToRepo}
              onClick={() => setAllScope(false)}
              label={t("search:scope.repo")}
            />
            <span className="text-fg-faint">·</span>
            <ScopeButton
              active={!scopedToRepo}
              onClick={() => setAllScope(true)}
              label={t("search:scope.all")}
            />
            <span className="ml-auto font-mono text-[10px] tracking-[0.08em] text-fg-faint">
              tab
            </span>
          </div>
        )}

        {/* Corpo: recenti oppure gruppi di risultati */}
        <div className="max-h-[60vh] min-h-[200px] overflow-y-auto p-2">
          {showingRecents ? (
            <RecentsSection
              items={recentItems}
              activeIndex={activeIndex}
              onActivate={openItem}
              onHover={setActiveIndex}
              recentsLabel={t("search:recents")}
              clearAllLabel={t("search:clearAll")}
              removeLabel={(title) => t("search:removeOne", { title })}
              typeLabel={(type) => TYPE_CODE[type]}
              onClearAll={() => clearAll.mutate()}
              onRemove={(item) => removeEntry.mutate({ type: item.type, entityId: item.entityId })}
            />
          ) : fastLoading ? (
            <SkeletonList label={t("search:searching")} />
          ) : noResults ? (
            <p className="px-2 py-6 text-center font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("search:noResults")}
            </p>
          ) : (
            <ul id="global-search-listbox" role="listbox" className="flex flex-col gap-2">
              {(() => {
                // Indice progressivo attraverso i gruppi = indice nella lista
                // piatta (così frecce/Invio e la selezione visiva combaciano).
                let cursor = 0;
                return groups.map((group) => {
                  if (group.items.length === 0) return null;
                  const isExpanded = expanded.has(group.type);
                  const visible = isExpanded
                    ? group.items
                    : group.items.slice(0, PER_GROUP_VISIBLE);
                  const isDocs = group.type === "doc";
                  return (
                    <li key={group.type}>
                      <div className="flex items-center justify-between px-2 pb-1">
                        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
                          {t(group.labelKey)}
                        </span>
                        {isDocs && semanticLoading && (
                          <span className="font-mono text-[9px] tracking-[0.1em] text-fg-faint uppercase">
                            {t("search:enriching")}
                          </span>
                        )}
                      </div>
                      <ul role="group" className="flex flex-col gap-0.5">
                        {visible.map((item) => {
                          const index = cursor++;
                          return (
                            <PaletteRow
                              key={item.key}
                              id={`global-search-item-${index}`}
                              typeCode={TYPE_CODE[item.type]}
                              item={item}
                              active={index === activeIndex}
                              onActivate={() => openItem(item)}
                              onHover={() => setActiveIndex(index)}
                            />
                          );
                        })}
                        {/* Skeleton SOLO sul gruppo Docs mentre gira la semantica. */}
                        {isDocs && semanticLoading && (
                          <li
                            role="status"
                            aria-label={t("search:enriching")}
                            className="flex flex-col gap-1.5 rounded-sm px-2 py-2"
                          >
                            <div className="h-3 w-1/3 animate-pulse rounded-sm bg-ink-700" />
                            <div className="h-2.5 w-3/4 animate-pulse rounded-sm bg-ink-800" />
                          </li>
                        )}
                      </ul>
                      {group.hasMore && !isExpanded && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => new Set(prev).add(group.type))
                          }
                          className="mt-0.5 w-full rounded-sm px-2 py-1 text-left font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase transition-colors hover:text-fg"
                        >
                          {t("search:showMore")}
                        </button>
                      )}
                    </li>
                  );
                });
              })()}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        <footer className="flex items-center gap-3 border-t border-line px-4 py-2 font-mono text-[10px] tracking-[0.08em] text-fg-faint">
          <span>↑↓ {t("search:hintNav")}</span>
          <span>↵ {t("search:hintOpen")}</span>
          {scope !== "global" && <span>tab {t("search:hintScope")}</span>}
          <span>esc {t("search:hintClose")}</span>
        </footer>
      </div>
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-sm px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase transition-colors ${
        active ? "bg-ink-800 text-fg" : "text-fg-faint hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

function RecentsSection({
  items,
  activeIndex,
  onActivate,
  onHover,
  recentsLabel,
  clearAllLabel,
  removeLabel,
  typeLabel,
  onClearAll,
  onRemove,
}: {
  items: PaletteItem[];
  activeIndex: number;
  onActivate: (item: PaletteItem) => void;
  onHover: (index: number) => void;
  recentsLabel: string;
  clearAllLabel: string;
  removeLabel: (title: string) => string;
  typeLabel: (type: SearchEntityType) => string;
  onClearAll: () => void;
  onRemove: (item: PaletteItem) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 pt-1 pb-2">
        <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
          {recentsLabel}
        </span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase transition-colors hover:text-fg"
          >
            {clearAllLabel}
          </button>
        )}
      </div>
      <ul id="global-search-listbox" role="listbox" className="flex flex-col gap-0.5">
        {items.map((item, index) => (
          <PaletteRow
            key={item.key}
            id={`global-search-item-${index}`}
            typeCode={typeLabel(item.type)}
            item={item}
            active={index === activeIndex}
            recency={item.clickedAt ? formatRelativeTimeVerbose(item.clickedAt) : undefined}
            removeLabel={removeLabel(item.title)}
            onActivate={() => onActivate(item)}
            onHover={() => onHover(index)}
            onRemove={() => onRemove(item)}
          />
        ))}
      </ul>
    </div>
  );
}

function PaletteRow({
  id,
  typeCode,
  item,
  active,
  recency,
  removeLabel,
  onActivate,
  onHover,
  onRemove,
}: {
  id: string;
  typeCode: string;
  item: PaletteItem;
  active: boolean;
  recency?: string;
  removeLabel?: string;
  onActivate: () => void;
  onHover: () => void;
  onRemove?: () => void;
}) {
  return (
    <li id={id} role="option" aria-selected={active}>
      <div
        className={`group flex items-start gap-2 rounded-sm px-2 py-1.5 transition-colors ${
          active ? "bg-ink-800" : "hover:bg-ink-850"
        }`}
        onMouseEnter={onHover}
      >
        <button type="button" onClick={onActivate} className="min-w-0 flex-1 text-left">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 font-mono text-[10px] tracking-[0.14em] text-fg-faint">
              {typeCode}
            </span>
            <span className="min-w-0 truncate text-[13px] text-fg">{item.title}</span>
            {item.subtitle && (
              <span className="shrink-0 truncate font-mono text-[10px] text-fg-faint">
                {item.subtitle}
              </span>
            )}
            {recency && (
              <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-fg-faint">
                {recency}
              </span>
            )}
          </span>
          {item.snippet && (
            <span className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-fg-muted">
              {plainTextPreview(item.snippet)}
            </span>
          )}
        </button>
        {onRemove && removeLabel && (
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

function SkeletonList({ label }: { label: string }) {
  return (
    <ul role="status" aria-label={label} className="flex flex-col gap-0.5">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex flex-col gap-1.5 rounded-sm px-2 py-2">
          <div className="h-3 w-1/3 animate-pulse rounded-sm bg-ink-700" />
          <div className="h-2.5 w-3/4 animate-pulse rounded-sm bg-ink-800" />
        </li>
      ))}
    </ul>
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
