import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ClaudeMark } from "../../../components/ClaudeMark";
import { now } from "../../../data/dates";
import {
  usePeople,
  useProductFirstVersion,
  useProductRevisions,
  useUndoProductChange,
} from "../../../data/queries";
import type {
  ProductBlock,
  ProductBlockChange,
  ProductPageView,
  ProductRevisionView,
  ProductTreeNode,
  ProductUndoView,
  RichText,
} from "../../../data/types";
import { formatDate } from "../../../notifications/time";
import { CloseIcon } from "../../task/parts";
import { GestureFailed, UndoReason } from "../claude/ProductClaudeMark";
import { SourceLine } from "../claude/SourceLine";
import { blockLabel } from "../editor/BlockBody";
import { RichView } from "../editor/RichView";
import { REDUCED_MOTION_QUERY, useMediaQuery } from "../../../layout/useMediaQuery";
import { usePersonName, useProductSpaceContext } from "../parts";
import type { HistoryFocus } from "../SideColumn";

// La cronologia di una pagina (shape product-comments-history.md §3.7,
// [PC 9], [PC 10]): nella stessa colonna dei commenti, una alla volta.
// Righe dalla più recente (`lastSeq`), raggruppate per giorno: iniziali ·
// nome · cosa · ora. Aperta (clic, Invio o →; ← chiude), per ancora in
// verticale: l'etichetta del tipo quando non è un paragrafo, «Before» e
// «After» col testo coi suoi segni (`RichView`); una frase tolta solo
// «Before» con «Removed», una aggiunta solo «After» con «Added», un cambio
// di soli segni «Formatting changed» con «After». Più di 5 ancore: le prime
// 5 e «Show N more». Le parole cambiate non si evidenziano nel 11a. Niente
// «Restore». Una revisione senza `via` né `sessionId`, o con blocchi senza
// `marks`, si disegna come le altre.
//
// 11b, Task 9 (shape product-claude-mark.md §3.6, [PM 7]): le righe di
// Claude. «Claude on behalf of Laura Costa» con le iniziali della persona e
// l'anello «Made with Claude» sotto l'ora (per il Claude collega, «Claude»);
// sotto, la fonte (`SourceLine`) e «Undo» / «Undo all» coi loro stati,
// tutti dal dato (`undo`, `undoByAnchor`, `undoneCount`): se anche una
// frase l'ha toccata un altro «Undo all» è spento col suo nome e le altre
// si annullano una per una nella riga aperta (Review Focus 4). La riga
// annullata dice «Undone by …» (o «1 of 3 undone · …»), e l'annullamento ha
// la sua riga, «Undid Claude's change», che rimanda a quella annullata. La
// risposta a una domanda è della persona («Laura Costa, from Claude's
// question», nessun anello né «Undo»), con «See the question». La prima
// versione si annulla dalla riga in cima alla pagina, non da qui. Chi legge
// soltanto la legge: nessun «Undo» e nessuna frase.

const FIRST = 50;
const ANCHORS = 5;

/** Una frase di prima: un dato vecchio può non avere `marks`. */
const rich = (content: RichText | { text: string } | undefined): RichText => ({
  text: content?.text ?? "",
  marks: (content as RichText | undefined)?.marks ?? [],
});

type Side = RichText | string | null;
interface Detail {
  key: string;
  /** L'etichetta del tipo, quando non è un paragrafo. */
  label: string | null;
  kind: "changed" | "added" | "removed" | "formatting";
  before: Side;
  after: Side;
}

function contentOf(block: ProductBlock | null, t: (k: string, o?: Record<string, unknown>) => string): Side {
  if (!block) return null;
  if ("content" in block) return rich(block.content);
  if (block.type === "image") {
    return block.caption ? t("productDocs.history.image", { caption: block.caption }) : t("productDocs.history.imageNoCaption");
  }
  return blockLabel(block, t);
}

function sameMarks(a: Side, b: Side): boolean {
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return a === b;
  return JSON.stringify(a.marks) === JSON.stringify(b.marks);
}

function textOf(side: Side): string | null {
  if (side === null) return null;
  return typeof side === "string" ? side : side.text;
}

function detail(key: string, label: string | null, before: Side, after: Side): Detail {
  const kind =
    before === null
      ? "added"
      : after === null
        ? "removed"
        : textOf(before) === textOf(after) && !sameMarks(before, after)
          ? "formatting"
          : "changed";
  return { key, label, kind, before, after };
}

/** Le ancore cambiate di un blocco: le celle, per una tabella (decisione 4). */
function detailsOf(change: ProductBlockChange, t: (k: string, o?: Record<string, unknown>) => string): Detail[] {
  const { before, after } = change;
  if (before?.type === "table" || after?.type === "table") {
    const cells = (b: ProductBlock | null) =>
      new Map(b?.type === "table" ? b.rows.flatMap((r) => r.cells.map((c) => [c.id, rich(c.content)] as const)) : []);
    const was = cells(before);
    const is = cells(after);
    // Senza `anchors` (un dato di prima) contano solo le celle che sono
    // davvero cambiate, non tutte; nessuna cambiata: la tabella, una volta.
    const ids =
      change.anchors.length > 0
        ? change.anchors
        : [...new Set([...was.keys(), ...is.keys()])].filter(
            (id) => JSON.stringify(was.get(id) ?? null) !== JSON.stringify(is.get(id) ?? null),
          );
    if (ids.length === 0) {
      const label = blockLabel((after ?? before)!, t);
      return [detail(change.blockId, null, before ? label : null, after ? label : null)];
    }
    return ids.map((id) => detail(id, t("productDocs.history.tableCell"), was.get(id) ?? null, is.get(id) ?? null));
  }
  const block = after ?? before;
  const label = block && block.type !== "paragraph" ? blockLabel(block, t) : null;
  return [detail(change.blockId, label, contentOf(before, t), contentOf(after, t))];
}

function findTitle(nodes: readonly ProductTreeNode[], id: string): string | null {
  for (const node of nodes) {
    if (node.page.id === id) return node.page.title;
    const inside = findTitle(node.children, id);
    if (inside) return inside;
  }
  return null;
}

/** Cosa dice la riga (§3.7, la tabella dei tipi). */
function summaryOf(
  r: ProductRevisionView,
  tree: readonly ProductTreeNode[],
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  switch (r.kind) {
    case "create":
      return t("productDocs.history.create");
    case "rename":
      return t("productDocs.history.rename", { before: r.title?.before ?? "" });
    case "undo":
      return t("productDocs.history.undid");
    case "first_version":
      return t("productDocs.history.firstVersion");
    case "move": {
      const to = r.parent?.afterId ?? null;
      if (to === null) return t("productDocs.history.moveTop");
      const parent = findTitle(tree, to);
      return parent ? t("productDocs.history.moveUnder", { parent }) : t("productDocs.history.moved");
    }
    default: {
      // La bozza di schermata (11b): disegnata, rifatta, tenuta o sostituita con un'immagine.
      if (r.wireframe) return t(`productDocs.history.wireframe.${r.wireframe}`);
      const details = r.changes.flatMap((c) => detailsOf(c, t));
      if (details.length > 0 && details.every((d) => d.kind === "formatting")) return t("productDocs.history.formatting");
      return t("productDocs.history.edit", { count: Math.max(details.length, 1) });
    }
  }
}

/** Il nome della riga: la persona, «Claude on behalf of …», o «…, from Claude's question». */
function useRowName() {
  const { t } = useTranslation();
  const nameOf = usePersonName();
  return (r: ProductRevisionView): string =>
    r.answerOf
      ? t("productDocs.history.answerFrom", { name: r.actorName })
      : r.via === "claude" && r.onBehalfOfId
        ? t("productDocs.history.onBehalfOf", { name: nameOf(r.onBehalfOfId) })
        : r.actorName;
}

/** L'anello «ritorna» di un annullamento: disegnato, non un glifo. */
function UndoGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0">
      <path d="M5.5 3.5 3 6l2.5 2.5" />
      <path d="M3 6h6.25a3.75 3.75 0 0 1 0 7.5H6" />
    </svg>
  );
}

const textButton =
  "inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-xs font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-disabled:cursor-default aria-disabled:text-ink-faint aria-disabled:hover:bg-transparent";

const clock = (iso: string, language: string) =>
  new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(
    new Date(iso),
  );

export function HistoryPanel({
  page,
  onClose,
  headingRef,
  focus = null,
  onSeeQuestion,
  announce,
}: {
  page: ProductPageView;
  onClose: () => void;
  headingRef?: RefObject<HTMLDivElement | null>;
  /** 11b: la riga da aprire col fuoco (`?history=`, «See it in the history»). */
  focus?: HistoryFocus | null;
  /** 11b: «See the question» — i commenti sul filo della domanda, al posto della cronologia. */
  onSeeQuestion?: (rootId: string) => void;
  /** 11b: l'annuncio dopo «Undo» (vive nello spazio). */
  announce?: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { space, project } = useProductSpaceContext();
  const revisions = useProductRevisions(page.id);
  const people = usePeople().data ?? [];
  const [limit, setLimit] = useState(FIRST);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const listId = useId();
  const rowName = useRowName();

  const all = revisions.data ?? [];
  const hasFirstVersion = all.some((r) => r.kind === "first_version");
  const firstVersion = useProductFirstVersion(project.id, { enabled: hasFirstVersion }).data ?? null;

  // La riga chiesta da fuori: aperta, a vista, col fuoco (una volta per richiesta).
  const followed = useRef<number | null>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || followed.current === focus.n || !revisions.data) return;
    const index = revisions.data.findIndex((r) => r.id === focus.revisionId);
    followed.current = focus.n;
    if (index === -1) return;
    if (index >= limit) setLimit(index + 1);
    setOpenRows((prev) => new Set(prev).add(focus.revisionId));
    setFocusRow(focus.revisionId);
  }, [focus, revisions.data, limit]);
  // Il fuoco dopo un «Undo» resta sulla riga: sul suo testo nuovo («Undone by …»).
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  useEffect(() => {
    if (focusRow) {
      const el = document.getElementById(`${listId}-${focusRow}`);
      if (el) {
        el.focus();
        el.scrollIntoView?.({ block: "nearest" });
        setFocusRow(null);
      }
    }
    if (focusAfter) {
      const el = document.querySelector<HTMLElement>(`[data-undone="${focusAfter}"]`);
      if (el) {
        el.focus();
        setFocusAfter(null);
      }
    }
  });
  /**
   * «Undid: …» porta alla riga annullata e la evidenzia per 1,5 s; col
   * movimento ridotto la tinta è fissa e resta finché la riga ha il fuoco (§7).
   */
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash || reducedMotion) return;
    const timer = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(timer);
  }, [flash, reducedMotion]);
  const shown = all.slice(0, limit);
  const today = now().slice(0, 10);
  const rowId = (r: ProductRevisionView) => `${listId}-${r.id}`;
  const toggle = (id: string, to?: boolean) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (to ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  // Le righe sono bottoni che aprono il loro dettaglio (un elenco a
  // tendina, non un `listbox`: il dettaglio, coi suoi bottoni, non è
  // un'opzione). Ogni riga è un punto di Tab, come i bottoni del dettaglio
  // che segue (fix round 2: niente fuoco itinerante senza un ruolo composito);
  // Invio o Spazio aprono e chiudono, → apre, ← chiude.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const r = shown[index];
    if (r && e.key === "ArrowRight") {
      e.preventDefault();
      toggle(r.id, true);
    } else if (r && e.key === "ArrowLeft") {
      e.preventDefault();
      toggle(r.id, false);
    }
  };


  // Raggruppate per giorno (OGGI, NOV 3).
  const days: { key: string; label: string; rows: ProductRevisionView[] }[] = [];
  for (const r of shown) {
    const key = r.at.slice(0, 10);
    const last = days.at(-1);
    if (last && last.key === key) last.rows.push(r);
    else days.push({ key, label: key === today ? t("productDocs.history.today") : formatDate(r.at, i18n.language), rows: [r] });
  }

  return (
    <section aria-label={t("productDocs.history.title")} className="flex min-h-full flex-col">
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b border-rule bg-surface pr-2 pl-4"
      >
        <h2 className="heading-group">{t("productDocs.history.title")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("productDocs.history.close")}
          title={t("productDocs.history.close")}
          className="ml-auto grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          <CloseIcon />
        </button>
      </div>
      {revisions.isPending && <RowSkeletons />}
      {revisions.isError && (
        <p role="alert" className="flex flex-wrap items-center gap-x-1.5 px-4 pt-3 text-sm text-critical">
          <span>{t("productDocs.history.loadError")}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => void revisions.refetch()} className="font-medium underline underline-offset-2">
            {t("productDocs.history.retry")}
          </button>
        </p>
      )}
      {revisions.data && (
        <div className="flex flex-col pb-6">
          <ul aria-label={t("productDocs.history.list")} className="flex flex-col">
            {days.map((day) => (
              <li key={day.key} className="flex flex-col pt-3">
                <h3 className="heading-group px-4 pb-1">{day.label}</h3>
                <ul aria-label={day.label} className="flex flex-col">
                  {day.rows.map((r) => {
                    const index = shown.indexOf(r);
                    const isOpen = openRows.has(r.id);
                    const person = people.find((p) => p.id === r.actorId);
                    const claude = r.via === "claude" && !r.answerOf;
                    return (
                      <li
                        key={r.id}
                        className="flex flex-col"
                        // Col movimento ridotto la tinta resta finché il fuoco è nella
                        // riga: anche su un suo bottone («Undo», «Undo all»), non solo
                        // sul nome (revisione finale).
                        onBlur={(e) => {
                          if (reducedMotion && flash === r.id && !e.currentTarget.contains(e.relatedTarget as Node | null))
                            setFlash(null);
                        }}
                      >
                        <button
                          type="button"
                          id={rowId(r)}
                          data-history-row=""
                          aria-expanded={isOpen}
                          aria-controls={`${rowId(r)}-details`}
                          onKeyDown={(e) => onKeyDown(e, index)}
                          onClick={() => toggle(r.id)}
                          data-flash={flash === r.id ? "" : undefined}
                          className={`mx-1.5 flex cursor-default items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/5 aria-expanded:bg-ink/6 ${flash === r.id ? "!bg-ink/10" : ""}`}
                        >
                          <span
                            aria-hidden="true"
                            data-claude-ring={person?.isClaude ? "" : undefined}
                            className={`mt-px grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                              // Il Claude collega: il suo avatar ad anello tratteggiato ([CT 6], come `Avatar`).
                              person?.isClaude
                                ? "border-[1.5px] border-dashed border-claude text-ink"
                                : "border border-rule-strong text-ink-muted"
                            }`}
                          >
                            {person?.initials ?? r.actorName.slice(0, 1)}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span data-row-name="" className="font-semibold text-ink [overflow-wrap:anywhere]">
                              {rowName(r)}
                            </span>
                            <span className="text-ink-muted [overflow-wrap:anywhere]">{summaryOf(r, space.tree, t)}</span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-ink-faint">
                            <span className="flex items-center gap-1">
                            <time dateTime={r.at} className="num">
                              {clock(r.at, i18n.language)}
                            </time>
                            <svg
                              viewBox="0 0 16 16"
                              width={12}
                              height={12}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={1.5}
                              aria-hidden="true"
                              focusable="false"
                              className={`transition-transform duration-[var(--duration-fast)] ease-out ${isOpen ? "rotate-90" : ""}`}
                            >
                              <path d="m6 3.5 4.5 4.5L6 12.5" />
                            </svg>
                            </span>
                            {/* Sotto l'ora, l'anello di Claude ([CT 3]); non per la risposta a una domanda. */}
                            {claude && <ClaudeMark label={t("productDocs.history.madeWithClaude")} />}
                          </span>
                        </button>
                        <RowExtras
                          revision={r}
                          all={all}
                          rowName={rowName}
                          summary={(x) => summaryOf(x, space.tree, t)}
                          firstVersion={
                            firstVersion && firstVersion.groupId === r.groupId
                              ? { sources: firstVersion.sources, atTop: firstVersion.bannerPageIds.includes(page.id) }
                              : null
                          }
                          onSeeQuestion={onSeeQuestion}
                          onShowUndone={(id) => {
                            const target = all.findIndex((x) => x.id === id);
                            if (target === -1) return;
                            if (target >= limit) setLimit(target + 1);
                            setFocusRow(id);
                            setFlash(id);
                          }}
                          onUndone={(key, text) => {
                            announce?.(text);
                            setFocusAfter(key);
                          }}
                        />
                        <div id={`${rowId(r)}-details`} hidden={!isOpen}>
                          {isOpen && (
                            <RevisionDetails
                              revision={r}
                              onUndone={(key, text) => {
                                announce?.(text);
                                setFocusAfter(key);
                              }}
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          {all.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + FIRST)}
              className="mx-4 mt-2 inline-flex h-7 items-center self-start rounded-md px-1.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              {t("productDocs.history.showOlder")}
            </button>
          )}
        </div>
      )}

    </section>
  );
}

function RevisionDetails({
  revision,
  onUndone,
}: {
  revision: ProductRevisionView;
  onUndone: (focusKey: string, announce: string) => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const details = revision.changes.flatMap((c) => detailsOf(c, t));
  // La prima versione è l'intera pagina: non si elencano i blocchi (§3.6).
  if (revision.kind === "first_version") {
    return <p className="pt-1 pr-4 pb-3 pl-[50px] text-xs text-ink-muted">{t("productDocs.history.wholePage")}</p>;
  }
  if (details.length === 0) return null;
  const shown = all ? details : details.slice(0, ANCHORS);
  // Una sola ancora coi soli segni cambiati: la riga dice già «Formatting
  // changed», il dettaglio non lo ripete (Impeccable 13).
  const sayKind = (d: Detail) => d.kind !== "changed" && !(details.length === 1 && d.kind === "formatting");
  return (
    <div className="flex flex-col gap-3 pt-1 pr-4 pb-3 pl-[50px]">
      {shown.map((d) => (
        <div key={d.key} className="flex flex-col gap-1">
          {(d.label || sayKind(d)) && (
            <p className="flex flex-wrap gap-x-1.5 text-xs text-ink-muted">
              {d.label && <span>{d.label}</span>}
              {d.label && sayKind(d) && <span aria-hidden="true">·</span>}
              {sayKind(d) && <span>{t(`productDocs.history.${d.kind}`)}</span>}
            </p>
          )}
          {(d.kind === "changed" || d.kind === "removed") && (
            <Version label={t("productDocs.history.before")} side={d.before} muted />
          )}
          {d.kind !== "removed" && (
            <Version
              label={t("productDocs.history.after")}
              side={d.after}
              trailing={
                revision.undoByAnchor?.[d.key] ? (
                  <AnchorUndo
                    revisionId={revision.id}
                    anchorId={d.key}
                    undo={revision.undoByAnchor[d.key]!}
                    onUndone={onUndone}
                  />
                ) : null
              }
            />
          )}
        </div>
      ))}
      {details.length > ANCHORS && !all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="inline-flex h-6 items-center self-start rounded-md px-1.5 text-xs font-medium text-ink-muted hover:bg-ink/6 hover:text-ink"
        >
          {t("productDocs.history.showMore", { count: details.length - ANCHORS })}
        </button>
      )}
    </div>
  );
}

function Version({
  label,
  side,
  muted = false,
  trailing = null,
}: {
  label: string;
  side: Side;
  muted?: boolean;
  /** 11b: l'«Undo» dell'ancora, accanto all'etichetta «After». */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <p className="text-xs font-semibold text-ink-muted">{label}</p>
        {trailing}
      </div>
      <div className={`text-sm leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere] ${muted ? "text-ink-muted" : "text-ink"}`}>
        {side === null ? null : typeof side === "string" ? side : <RichView content={side} />}
      </div>
    </div>
  );
}

function RowSkeletons() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-3 px-4 pt-4">
      <span role="status" className="sr-only">
        {t("productDocs.history.loading")}
      </span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="size-5 shrink-0 rounded-full bg-ink/8" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className={`h-3.5 w-2/5 ${bar}`} />
            <span className={`h-3 w-3/5 ${bar}`} />
          </span>
        </div>
      ))}
    </div>
  );
}

// --- 11b: le righe di Claude -------------------------------------------------------

/** Un gesto d'annullamento che non scrive due volte (un doppio clic: una scrittura). */
function useUndoOnce(onUndone: (focusKey: string, announce: string) => void) {
  const { t } = useTranslation();
  const undo = useUndoProductChange();
  const inflight = useRef(false);
  const [failed, setFailed] = useState(false);
  const run = (revisionId: string, anchorId: string | undefined, focusKey: string) => {
    if (inflight.current) return;
    inflight.current = true;
    setFailed(false);
    undo.mutateAsync({ revisionId, anchorId }).then(
      () => onUndone(focusKey, t("productDocs.mark.undone")),
      () => {
        inflight.current = false;
        setFailed(true);
      },
    );
  };
  return { run, pending: undo.isPending, failed };
}

function UndoFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return <GestureFailed text={t("productDocs.mark.undoFailed")} onRetry={onRetry} />;
}

/** «Undone», «Undone by …»: il testo nuovo della riga, dove resta il fuoco dopo un «Undo». */
function UndoneText({ focusKey, children }: { focusKey: string; children: ReactNode }) {
  return (
    <span
      tabIndex={-1}
      data-undone={focusKey}
      className="inline-flex items-center gap-1 rounded-sm text-xs text-ink-muted outline-none focus-visible:outline-2 focus-visible:outline-focus"
    >
      <UndoGlyph />
      {children}
    </span>
  );
}

/** L'«Undo» di un'ancora nella riga aperta: acceso, spento col suo perché, o «Undone». */
function AnchorUndo({
  revisionId,
  anchorId,
  undo,
  onUndone,
}: {
  revisionId: string;
  anchorId: string;
  undo: ProductUndoView;
  onUndone: (focusKey: string, announce: string) => void;
}) {
  const { t } = useTranslation();
  const reasonId = useId();
  const key = `${revisionId}:${anchorId}`;
  const once = useUndoOnce(onUndone);
  if (!undo.enabled && undo.reason === "no_permission") return null;
  if (!undo.enabled && undo.reason === "already_undone") {
    return <UndoneText focusKey={key}>{t("productDocs.history.undoneAnchor")}</UndoneText>;
  }
  const off = undo.enabled ? null : undo;
  // Nella riga di «After» (che va a capo): il bottone a destra, la frase e
  // l'errore sotto, a tutta larghezza.
  return (
    <>
      <button
        type="button"
        aria-disabled={off || once.pending ? true : undefined}
        aria-describedby={off ? reasonId : undefined}
        onClick={() => !off && !once.pending && once.run(revisionId, anchorId, key)}
        className={`${textButton} -mr-1.5`}
      >
        {once.pending ? t("productDocs.mark.undoing") : t("productDocs.history.undo")}
      </button>
      {off && (
        <span className="basis-full">
          <UndoReason undo={off} id={reasonId} />
        </span>
      )}
      {once.failed && (
        <span className="basis-full">
          <UndoFailed onRetry={() => once.run(revisionId, anchorId, key)} />
        </span>
      )}
    </>
  );
}

/**
 * Sotto il bottone della riga: la fonte (o le fonti della prima versione),
 * «Undo» / «Undo all» o «Undone by …», «Undid: …» di un annullamento,
 * «See the question» di una risposta.
 */
function RowExtras({
  revision: r,
  all,
  rowName,
  summary,
  firstVersion,
  onSeeQuestion,
  onShowUndone,
  onUndone,
}: {
  revision: ProductRevisionView;
  all: readonly ProductRevisionView[];
  rowName: (r: ProductRevisionView) => string;
  summary: (r: ProductRevisionView) => string;
  /** La prima versione di questa riga: le sue fonti, e se la riga in cima alla pagina c'è ancora. */
  firstVersion: { sources: ProductRevisionView["sourceView"][]; atTop: boolean } | null;
  onSeeQuestion?: (rootId: string) => void;
  onShowUndone: (revisionId: string) => void;
  onUndone: (focusKey: string, announce: string) => void;
}) {
  const { t } = useTranslation();
  const nameOf = usePersonName();
  const reasonId = useId();
  const once = useUndoOnce(onUndone);
  const lines: ReactNode[] = [];

  const sources =
    r.kind === "first_version"
      ? (firstVersion?.sources ?? []).filter((x): x is NonNullable<typeof x> => !!x)
      : r.sourceView && !r.answerOf
        ? [r.sourceView]
        : [];

  // Lo stato di «Undo» / «Undo all» della riga, dal dato.
  /** Il bottone, a destra della fonte. */
  let control: ReactNode = null;
  /** Uno stato che si legge («Undone by …», «Undo it from the line…»): la sua riga. */
  let status: ReactNode = null;
  let reason: ReactNode = null;
  const count = r.undoneCount?.count ?? 0;
  const done = r.undoneCount?.done ?? 0;
  if (r.undo && done > 0) {
    const by = r.undoneById ? nameOf(r.undoneById) : null;
    const text =
      done >= count
        ? by
          ? t("productDocs.history.undoneBy", { name: by })
          : t("productDocs.history.undoneByNobody")
        : by
          ? t("productDocs.history.undonePart", { done, count, name: by })
          : t("productDocs.history.undonePartNobody", { done, count });
    status = <UndoneText focusKey={r.id}>{text}</UndoneText>;
  } else if (r.undo && !(r.undo.enabled === false && r.undo.reason === "no_permission")) {
    const off = r.undo.enabled ? null : r.undo;
    control = (
      <button
        type="button"
        aria-disabled={off || once.pending ? true : undefined}
        aria-describedby={off ? reasonId : undefined}
        onClick={() => !off && !once.pending && once.run(r.id, undefined, r.id)}
        className={textButton}
      >
        {once.pending
          ? t("productDocs.mark.undoing")
          : count > 1
            ? t("productDocs.history.undoAll")
            : t("productDocs.history.undo")}
      </button>
    );
    if (off && count > 1 && off.reason === "changed_after") {
      reason = (
        <span id={reasonId} className="text-xs text-ink-muted">
          {off.byId ? (
            <Trans
              i18nKey="productDocs.history.changedOne"
              values={{ name: nameOf(off.byId) }}
              components={{ b: <strong className="font-semibold text-ink" /> }}
            />
          ) : (
            t("productDocs.history.changedOneNobody")
          )}
        </span>
      );
    } else if (off) {
      reason = <UndoReason undo={off} id={reasonId} />;
    }
  } else if (r.kind === "first_version" && firstVersion?.atTop) {
    status = <span className="text-xs text-ink-faint">{t("productDocs.history.undoAtTop")}</span>;
  }

  if (sources.length > 0 || control) {
    lines.push(
      <div key="source" className="flex items-start justify-between gap-2">
        {sources.length > 0 ? <SourceLine sources={sources} className="flex-1" /> : <span />}
        {control}
      </div>,
    );
  }
  if (status) lines.push(<p key="status">{status}</p>);
  if (reason) lines.push(<p key="reason">{reason}</p>);
  if (once.failed) lines.push(<UndoFailed key="failed" onRetry={() => once.run(r.id, undefined, r.id)} />);

  if (r.kind === "undo" && r.undoOf) {
    const undone = all.find((x) => x.id === r.undoOf);
    if (undone) {
      lines.push(
        <p key="undid" className="text-xs text-ink-muted [overflow-wrap:anywhere]">
          <span className="mr-1 inline-block align-[-2px]">
            <UndoGlyph />
          </span>
          <span>
            {t("productDocs.history.undidLabel")} {rowName(undone)}
            <span aria-hidden="true"> · </span>
            {summary(undone)}
            <span aria-hidden="true"> · </span>
          </span>
          <button
            type="button"
            onClick={() => onShowUndone(undone.id)}
            aria-label={`${t("productDocs.history.showUndone")} · ${t("productDocs.mark.at", { date: Date.parse(undone.at) })}`}
            className="num rounded-[3px] font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("productDocs.mark.at", { date: Date.parse(undone.at) })}
          </button>
        </p>,
      );
    }
  }
  if (r.answerOf && onSeeQuestion) {
    const rootId = r.answerOf;
    lines.push(
      <p key="question">
        <button type="button" onClick={() => onSeeQuestion(rootId)} className={`${textButton} -ml-1.5`}>
          {t("productDocs.history.seeQuestion")}
        </button>
      </p>,
    );
  }
  if (lines.length === 0) return null;
  return <div className="flex flex-col gap-1 pr-4 pb-1.5 pl-[50px]">{lines}</div>;
}
