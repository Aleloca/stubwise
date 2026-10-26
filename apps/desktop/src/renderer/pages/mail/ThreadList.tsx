import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { shortcutLabel } from "../../platform/platform";
import type { MailboxView, MailThreadRow } from "../../data/types";
import { fold, searchWords } from "../chat/search";
import { Chevron, MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton } from "../tasks/controls";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { SearchGlyph } from "./glyphs";
import { IMPORTANCES, NO_PROJECT, hasFilters, type MailSearch } from "./mailFilters";
import { ExpiredBanner, SyncStatus, worstMailbox } from "./SyncStatus";
import { ThreadRow, useRowLabel, type ProjectRef } from "./ThreadRow";

// L'elenco della Posta (shape mail.md §3, A4): in testa la barra con «Search
// mail» e i due menu a gettone (Importance, Project), poi la riga di stato
// dell'allineamento, poi le conversazioni dalla più recente — una finestra
// di 50 righe che cresce scorrendo — e in fondo la nota dei 90 giorni.

/** Quante righe si disegnano per volta. */
export const LIST_WINDOW = 50;

const chip =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-2.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-expanded:bg-ink/10";
const chipOn = "border-ink/60";

/** Il frammento con le parole cercate in grassetto. */
function highlight(text: string, q: string): ReactNode {
  const words = searchWords(q);
  if (words.length === 0) return text;
  const folded = fold(text);
  const marks: [number, number][] = [];
  for (const w of words) {
    let at = folded.indexOf(w);
    while (at >= 0) {
      marks.push([at, at + w.length]);
      at = folded.indexOf(w, at + w.length);
    }
  }
  if (marks.length === 0) return text;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([from, to], i) => {
    if (from < pos) return;
    out.push(text.slice(pos, from));
    out.push(
      <strong key={i} className="font-semibold text-ink">
        {text.slice(from, to)}
      </strong>,
    );
    pos = to;
  });
  out.push(text.slice(pos));
  return out;
}

export function ThreadList({
  search,
  setSearch,
  rows,
  loading,
  error,
  onRetry,
  projects,
  mailProjects,
  boxes,
  selectedId,
  drafts,
  onOpen,
  onEnter,
  listRef,
  searchRef,
  hits = new Map(),
}: {
  search: MailSearch;
  setSearch: (patch: Partial<MailSearch>) => void;
  rows: MailThreadRow[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  projects: ReadonlyMap<string, ProjectRef>;
  /** I progetti delle mie email, per il menu «Project». */
  mailProjects: readonly ProjectRef[];
  boxes: readonly MailboxView[];
  selectedId: string | null;
  drafts: ReadonlySet<string>;
  onOpen: (threadId: string, how: "click" | "keys") => void;
  onEnter: () => void;
  listRef: RefObject<HTMLDivElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Con una ricerca: il frammento trovato (`searchMail`) per conversazione. */
  hits?: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const rowLabel = useRowLabel();
  const [limit, setLimit] = useState(LIST_WINDOW);
  const scroller = useRef<HTMLDivElement>(null);

  const box = search.mailbox ? boxes.find((b) => b.email === search.mailbox) : undefined;
  const statusBox = box ?? worstMailbox(boxes);
  const filtered = hasFilters(search);

  // Le righe arrivate dopo il primo disegno entrano in dissolvenza; se chi
  // legge ha scrollato, «N new» in testa le porta in vista.
  // Per filtro: cambiare filtro non fa «arrivare» le righe dell'altro elenco.
  const filterKey = JSON.stringify([search.mailbox, search.importance, search.project, search.q]);
  const known = useRef<{ key: string; ids: Set<string> } | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  const [newCount, setNewCount] = useState(0);
  useEffect(() => {
    if (!rows) return;
    const ids = new Set(rows.map((r) => r.threadId));
    if (known.current && known.current.key === filterKey) {
      const before = known.current.ids;
      const fresh = [...ids].filter((id) => !before.has(id));
      if (fresh.length > 0) {
        setArrived(new Set(fresh));
        if ((scroller.current?.scrollTop ?? 0) > 0) setNewCount((n) => n + fresh.length);
      }
    }
    known.current = { key: filterKey, ids };
  }, [rows, filterKey]);

  const shown = useMemo(() => (rows ?? []).slice(0, limit), [rows, limit]);

  function move(delta: number) {
    if (!rows || rows.length === 0) return;
    const at = rows.findIndex((r) => r.threadId === selectedId);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
    if (!next) return;
    const index = rows.indexOf(next);
    if (index >= limit) setLimit(index + LIST_WINDOW);
    onOpen(next.threadId, "keys");
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (key === "ArrowDown" || key === "j") {
      e.preventDefault();
      move(1);
    } else if (key === "ArrowUp" || key === "k") {
      e.preventDefault();
      move(-1);
    } else if (key === "Enter") {
      e.preventDefault();
      onEnter();
    }
  }

  // La riga corrente prende il fuoco quando la si sceglie con la tastiera.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !selectedId || !list.contains(document.activeElement)) return;
    list.querySelector<HTMLElement>(`[data-thread="${CSS.escape(selectedId)}"]`)?.focus();
  }, [selectedId, listRef]);

  const importanceLabel = search.importance
    ? t(`mail.filters.${search.importance}`)
    : t("mail.filters.importance");
  const projectLabel =
    search.project === NO_PROJECT
      ? t("mail.filters.noProject")
      : search.project
        ? search.project
        : t("mail.filters.project");

  const empty = () => {
    if (search.q) return t("mail.list.noMatch", { q: search.q });
    if (search.project === NO_PROJECT) return t("mail.list.noProjectMail");
    if (search.project) return t("mail.list.noMailFor", { code: search.project });
    if (search.importance === "high") return t("mail.list.noImportant");
    if (search.importance) return t("mail.list.noFilterMatch");
    return t("mail.list.empty");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-rule px-4 pt-1 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-rule-strong px-2.5 text-ink-muted focus-within:border-ink/60">
          <SearchGlyph />
          <input
            ref={searchRef}
            type="search"
            value={search.q ?? ""}
            onChange={(e) => setSearch({ q: e.target.value || undefined })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search.q) {
                e.preventDefault();
                setSearch({ q: undefined });
              }
            }}
            placeholder={t("mail.filters.search")}
            aria-label={t("mail.filters.search")}
            className="min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-faint"
          />
          <kbd aria-hidden="true" className="num rounded-[5px] border border-rule-strong px-1 text-xs text-ink-faint">
            {shortcutLabel(["mod", "F"])}
          </kbd>
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <MenuButton
            menuLabel={t("mail.filters.importance")}
            className={`${chip} ${search.importance ? chipOn : ""}`}
            label={
              <>
                {importanceLabel}
                <Chevron />
              </>
            }
          >
            {(close) => (
              <MenuGroup label={t("mail.filters.importance")}>
                <RadioItem checked={!search.importance} onSelect={() => (setSearch({ importance: undefined }), close())}>
                  {t("mail.filters.any")}
                </RadioItem>
                {IMPORTANCES.map((value) => (
                  <RadioItem
                    key={value}
                    checked={search.importance === value}
                    onSelect={() => (setSearch({ importance: value }), close())}
                  >
                    {t(`mail.filters.${value}`)}
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuButton>
          <MenuButton
            menuLabel={t("mail.filters.project")}
            className={`${chip} ${search.project ? chipOn : ""}`}
            label={
              <>
                <span className="num">{projectLabel}</span>
                <Chevron />
              </>
            }
          >
            {(close) => (
              <MenuGroup label={t("mail.filters.project")}>
                <RadioItem checked={!search.project} onSelect={() => (setSearch({ project: undefined }), close())}>
                  {t("mail.filters.any")}
                </RadioItem>
                {mailProjects.map((p) => (
                  <RadioItem
                    key={p.id}
                    checked={search.project === p.code}
                    onSelect={() => (setSearch({ project: p.code }), close())}
                  >
                    <span className="num w-9 shrink-0 text-xs font-semibold">{p.code}</span>
                    <span className="min-w-0 truncate">{p.name}</span>
                  </RadioItem>
                ))}
                <RadioItem
                  checked={search.project === NO_PROJECT}
                  onSelect={() => (setSearch({ project: NO_PROJECT }), close())}
                >
                  {t("mail.filters.noProject")}
                </RadioItem>
              </MenuGroup>
            )}
          </MenuButton>
          {filtered && (
            <button
              type="button"
              onClick={() => setSearch({ importance: undefined, project: undefined, q: undefined })}
              className="ml-auto inline-flex h-7 items-center rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              {t("mail.filters.clear")}
            </button>
          )}
        </div>
      </div>
      {/* Scaduto: la fascia dice tutto (da quando, cosa non succede, «Reconnect»). */}
      {statusBox && !statusBox.expired && <SyncStatus box={statusBox} prefix={!box && boxes.length > 1} />}
      {statusBox?.expired && <ExpiredBanner box={statusBox} />}
      {box && !box.proposalsEnabled && (
        <p className="flex shrink-0 items-center gap-1 px-4 pb-1 text-xs text-ink-muted">
          {t("mail.list.proposalsOff")} ·
          <button
            type="button"
            onClick={() => openGoogleAccount()}
            className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink disabled:opacity-40"
          >
            {t("mail.list.turnOn")}
          </button>
        </p>
      )}
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop === 0 && newCount > 0) setNewCount(0);
          if (rows && limit < rows.length && el.scrollTop + el.clientHeight > el.scrollHeight - 300) {
            setLimit((l) => l + LIST_WINDOW);
          }
        }}
      >
        {newCount > 0 && (
          <button
            type="button"
            onClick={() => {
              scroller.current?.scrollTo({ top: 0 });
              setNewCount(0);
            }}
            className="sticky top-2 z-10 mx-auto mb-[-28px] flex h-7 items-center rounded-full border border-rule-strong bg-surface px-3 text-xs font-medium text-ink shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)]"
          >
            {t("mail.list.newRows", { count: newCount })}
          </button>
        )}
        {loading ? (
          <ListSkeleton />
        ) : error ? (
          <PageError message={t("mail.list.error")} onRetry={onRetry} />
        ) : shown.length === 0 ? (
          <PageEmpty
            title={empty()}
            action={
              filtered ? (
                <button
                  type="button"
                  onClick={() => setSearch({ importance: undefined, project: undefined, q: undefined })}
                  className="inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink hover:bg-ink/6"
                >
                  {t("mail.filters.clear")}
                </button>
              ) : undefined
            }
          />
        ) : (
          <div
            ref={listRef}
            role="listbox"
            aria-label={t("mail.list.label")}
            onKeyDown={onKeyDown}
            tabIndex={selectedId && shown.some((r) => r.threadId === selectedId) ? -1 : 0}
            className="flex flex-col outline-none"
          >
            {shown.map((row) => (
              <ThreadRow
                key={row.threadId}
                row={row}
                projects={projects}
                selected={row.threadId === selectedId}
                draft={drafts.has(row.threadId)}
                label={rowLabel(row, projects, drafts.has(row.threadId))}
                onOpen={(id) => onOpen(id, "click")}
                snippet={search.q ? highlight(hits.get(row.threadId) ?? row.snippet, search.q) : undefined}
                arrived={arrived.has(row.threadId)}
              />
            ))}
          </div>
        )}
        {!loading && !error && (
          <p className="px-4 pt-4 pb-6 text-xs text-ink-faint">
            {t("mail.list.retention")}{" "}
            <button
              type="button"
              onClick={() => toast.show(t("mail.gmailNotice"))}
              className="rounded-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink"
            >
              {t("mail.list.openGmail")}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/** Otto righe scheletro, con la forma a tre linee della riga vera. */
function ListSkeleton() {
  const { t } = useTranslation();
  const bar = "block rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} data-skeleton-row className="flex h-[72px] flex-col justify-center gap-2 border-b border-rule px-4">
          <span className={`${bar} h-2.5`} style={{ width: `${40 + ((i * 13) % 30)}%` }} />
          <span className={`${bar} ml-4 h-2.5`} style={{ width: `${55 + ((i * 7) % 30)}%` }} />
          <span className={`${bar} ml-4 h-2`} style={{ width: `${30 + ((i * 11) % 25)}%` }} />
        </div>
      ))}
    </div>
  );
}
