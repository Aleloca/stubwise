import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ClaudeMark } from "../../../components/ClaudeMark";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useAcceptProductMark, useUndoProductChange } from "../../../data/queries";
import type { ProductMarkView, ProductUndoView } from "../../../data/types";
import { usePersonName, useProductSpaceContext, type MarksBridge } from "../parts";
import { SourceLine } from "./SourceLine";

// Il segno di Claude su un blocco (11b, Task 9; shape
// product-claude-mark.md §3.2–§3.5, [PM 1]–[PM 6]). Chiuso: nella corsia di
// 32 px FUORI dalla colonna di lettura, a destra (il glifo dei commenti sta
// dentro, nei 28 px del corpo), l'anello fermo all'altezza della prima riga
// e sotto un tratto tratteggiato lungo il blocco — una sigla a matita sul
// margine, nessun fondo sul testo. Aperto: una nota sotto il blocco, col
// filetto `rule` a sinistra, che dice chi, per conto di chi, quando, la
// fonte come la legge chi guarda (`SourceLine`), e i gesti: «Looks good»
// (una frase alla volta, maintainer 6 nov 2026) e «Undo», o per chi legge
// soltanto la frase col «Who?».
//
// Tutto dal dato (`ProductMarkView`): il segno c'è se `listProductMarks` lo
// dà, «Looks good» se `canAccept`, «Undo» se `undo.enabled`, il perché e il
// nome da `undo.reason` e `undo.byId`. La pagina non confronta revisioni.
// Dopo un gesto il fuoco va al blocco (o al blocco prima, se l'«Undo» l'ha
// tolto; all'h1 se era il primo), mai al body. Le righe «cambia sotto gli
// occhi» (§3.5) non ci sono: il dato non le deriva (ruling P45).

/** Il segno del blocco `blockId`, se il livello dati ne dà uno; altrimenti niente. */
export function ProductClaudeMark({ blockId }: { blockId: string }) {
  const { marks } = useProductSpaceContext();
  const list = marks?.byBlock.get(blockId);
  if (!marks || !list || list.length === 0) return null;
  return <Mark blockId={blockId} marks={list} bridge={marks} />;
}

/** Il blocco col suo gruppo: quello di chi scrive (`role="group"`), o quello letto. */
const blockEl = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[role="group"][data-block-id="${id}"]`) ??
  root.querySelector<HTMLElement>(`[data-block-id="${id}"]`);

/**
 * Il fuoco dopo «Looks good» o «Undo»: aspetta che la lettura nuova arrivi
 * (il segno se ne va, o il blocco), poi il blocco; se l'«Undo» l'ha tolto,
 * il blocco prima; se era il primo, l'h1. Mai il body.
 */
function focusAfter(button: HTMLElement | null, blockId: string) {
  const article = button?.closest("article") ?? document;
  const shell = button ? blockEl(article, blockId) : null;
  const blocks = [...article.querySelectorAll<HTMLElement>("[data-block-id]")].filter(
    (el) => el.parentElement === shell?.parentElement,
  );
  const prevId = shell ? (blocks[blocks.indexOf(shell) - 1]?.dataset.blockId ?? null) : null;
  let frames = 0;
  const step = () => {
    const settled =
      !document.querySelector(`[data-claude-mark-button="${blockId}"]`) || !blockEl(article, blockId);
    if (!settled && frames++ < 20) {
      requestAnimationFrame(step);
      return;
    }
    const target =
      blockEl(article, blockId) ??
      (prevId ? blockEl(article, prevId) : null) ??
      article.querySelector<HTMLElement>("h1");
    target?.focus({ preventScroll: false });
  };
  requestAnimationFrame(step);
}

function Mark({
  blockId,
  marks,
  bridge,
}: {
  blockId: string;
  marks: readonly ProductMarkView[];
  bridge: MarksBridge;
}) {
  const { t } = useTranslation();
  const nameOf = usePersonName();
  const noteId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLDivElement>(null);
  const firstLine = useRef<HTMLParagraphElement>(null);
  const [noteHeight, setNoteHeight] = useState(0);
  const isOpen = bridge.open?.blockId === blockId;
  const openN = isOpen ? bridge.open!.n : null;
  const first = marks[0]!;
  const date = Date.parse(first.at);
  const behalf = first.onBehalfOfId ? nameOf(first.onBehalfOfId) : null;

  // Il tratto finisce dove comincia la nota: lungo il blocco, non lungo la nota.
  useLayoutEffect(() => {
    const el = note.current;
    if (!isOpen || !el) {
      setNoteHeight(0);
      return;
    }
    const measure = () => setNoteHeight(el.offsetHeight + 8);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isOpen]);

  // Aperta, il fuoco va sulla sua prima riga e la nota scorre in vista.
  useEffect(() => {
    if (openN === null) return;
    const el = firstLine.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    note.current?.scrollIntoView?.({ block: "nearest" });
  }, [openN]);

  const close = () => {
    bridge.setOpen(null);
    button.current?.focus();
  };
  const onNoteKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const done = (text: string) => {
    bridge.announce(text);
    bridge.setOpen(null);
    focusAfter(button.current, blockId);
  };

  const table = marks.some((m) => m.cell);
  return (
    <>
      <button
        ref={button}
        type="button"
        data-claude-mark-button={blockId}
        aria-expanded={isOpen}
        aria-controls={noteId}
        aria-label={behalf ? t("productDocs.mark.name", { name: behalf }) : t("productDocs.mark.nameClaude")}
        title={t("productDocs.mark.tooltip", { date })}
        onClick={() => (isOpen ? bridge.setOpen(null) : bridge.setOpen(blockId))}
        onKeyDown={(e) => {
          if (e.key === "Escape" && isOpen) {
            e.preventDefault();
            e.stopPropagation();
            bridge.setOpen(null);
          }
        }}
        style={{ bottom: noteHeight + 4, minHeight: 24 }}
        className="group/mark absolute top-[var(--block-pt,0px)] -right-[54px] flex w-5 flex-col items-center rounded-md pt-[5px] pb-0.5 text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink focus-visible:bg-ink/6 focus-visible:text-ink aria-expanded:text-ink"
      >
        <ClaudeMark />
        <span
          aria-hidden="true"
          className="mt-1 w-0.5 flex-1 bg-[repeating-linear-gradient(to_bottom,currentColor_0_3px,transparent_3px_6px)]"
        />
      </button>
      <div
        ref={note}
        id={noteId}
        role="group"
        aria-label={t("productDocs.mark.note")}
        data-claude-note={isOpen ? blockId : undefined}
        hidden={!isOpen}
        onKeyDown={onNoteKey}
        className="event-enter mt-2 mb-1 flex max-w-[692px] flex-col gap-1 border-l border-rule pl-3"
      >
        {isOpen && (
          <>
            <p
              ref={firstLine}
              tabIndex={-1}
              className="flex flex-wrap items-center gap-x-1.5 rounded-sm text-[13px] leading-[18px] text-ink-muted outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <ClaudeMark />
              <span className="font-semibold text-ink">{t("productDocs.mark.updated")}</span>
              {behalf && (
                <span>
                  <span aria-hidden="true">· </span>
                  {t("productDocs.mark.onBehalfOf", { name: behalf })}
                </span>
              )}
              <span className="num text-ink-faint">
                <span aria-hidden="true">· </span>
                {t("productDocs.mark.at", { date })}
              </span>
            </p>
            <SourceLine sources={[first.source]} />
            {first.groupAnchors > 1 && (
              <p className="text-xs leading-4 text-ink-muted">
                {t("productDocs.mark.group", { count: first.groupAnchors })}
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  onClick={() => bridge.seeHistory(first.revisionId)}
                  className="rounded-[3px] font-semibold text-ink underline decoration-transparent underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink/60 focus-visible:decoration-ink/60"
                >
                  {t("productDocs.mark.seeHistory")}
                </button>
              </p>
            )}
            <div className={`flex flex-col ${table ? "gap-1.5" : ""} pt-1`}>
              {marks.map((m) => (
                <MarkActions key={m.anchorId} mark={m} pageId={bridge.pageId} onDone={done} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** La frase di un «Undo» spento ([PM 6]): il fatto col nome, mai un «Who?». */
export function UndoReason({ undo, id }: { undo: Extract<ProductUndoView, { enabled: false }>; id: string }) {
  const nameOf = usePersonName();
  const { t } = useTranslation();
  const text =
    undo.reason === "changed_after" ? (
      undo.byId ? (
        <Trans
          i18nKey="productDocs.mark.changedAfter"
          values={{ name: nameOf(undo.byId) }}
          components={{ b: <strong className="font-semibold text-ink" /> }}
        />
      ) : (
        t("productDocs.mark.changedAfterNobody")
      )
    ) : undo.byId ? (
      t("productDocs.mark.alreadyUndone", { name: nameOf(undo.byId) })
    ) : (
      t("productDocs.mark.alreadyUndoneNobody")
    );
  return (
    <span id={id} className="text-xs leading-4 text-ink-muted">
      {text}
    </span>
  );
}

/** I gesti di un'ancora (la frase, o una cella): «Looks good» · «Undo», o la sola lettura. */
function MarkActions({
  mark,
  pageId,
  onDone,
}: {
  mark: ProductMarkView;
  pageId: string;
  onDone: (announce: string) => void;
}) {
  const { t } = useTranslation();
  const { project } = useProductSpaceContext();
  const accept = useAcceptProductMark();
  const undo = useUndoProductChange();
  const reasonId = useId();
  /** Un gesto in volo: un secondo clic non fa una seconda scrittura. */
  const inflight = useRef(false);
  const [failed, setFailed] = useState<"accept" | "undo" | null>(null);
  const cell = mark.cell ? t("productDocs.mark.cell", { row: mark.cell.row, col: mark.cell.col }) : null;

  if (!mark.canAccept && !mark.undo.enabled && mark.undo.reason === "no_permission") {
    return (
      <p className="text-xs leading-4 text-ink-muted">
        {cell && (
          <>
            <span className="text-ink">{cell}</span>
            <span aria-hidden="true"> · </span>
          </>
        )}
        {t("productDocs.mark.readOnly", { code: project.code })}{" "}
        <span aria-hidden="true">· </span>
        <WhoCanLink action="editDocs" projectId={project.id} projectCode={project.code} />
      </p>
    );
  }

  const run = (kind: "accept" | "undo") => {
    if (inflight.current) return;
    inflight.current = true;
    setFailed(null);
    const write =
      kind === "accept"
        ? accept.mutateAsync({ pageId, anchorId: mark.anchorId })
        : undo.mutateAsync({ revisionId: mark.revisionId, anchorId: mark.anchorId });
    write.then(
      () => onDone(t(kind === "accept" ? "productDocs.mark.accepted" : "productDocs.mark.undone")),
      () => {
        inflight.current = false;
        setFailed(kind);
      },
    );
  };
  const busy = accept.isPending || undo.isPending;
  const off = mark.undo.enabled ? null : mark.undo;
  const smallSecondary =
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-2 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10 aria-disabled:cursor-default aria-disabled:text-ink-muted aria-disabled:hover:bg-transparent";
  const textButton =
    "inline-flex h-7 items-center rounded-md px-2 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-disabled:cursor-default aria-disabled:text-ink-faint aria-disabled:hover:bg-transparent";
  return (
    <div className="flex flex-col gap-1">
      <div className="-ml-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {cell && <span className="pl-1 text-xs leading-4 text-ink">{cell}</span>}
        {mark.canAccept && (
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => !busy && run("accept")}
            className={smallSecondary}
          >
            <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true" focusable="false">
              <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {accept.isPending ? t("productDocs.mark.saving") : t("productDocs.mark.accept")}
          </button>
        )}
        <button
          type="button"
          aria-disabled={off || busy ? true : undefined}
          aria-describedby={off ? reasonId : undefined}
          onClick={() => !off && !busy && run("undo")}
          className={textButton}
        >
          {undo.isPending ? t("productDocs.mark.undoing") : t("productDocs.mark.undo")}
        </button>
      </div>
      {off && off.reason !== "no_permission" && <UndoReason undo={off} id={reasonId} />}
      {failed && (
        <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-xs leading-4 text-critical">
          <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4.75v3.75M8 11h.01" strokeLinecap="round" />
          </svg>
          <span>{t(failed === "accept" ? "productDocs.mark.acceptFailed" : "productDocs.mark.undoFailed")}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => run(failed)} className="font-medium underline underline-offset-2">
            {t("productDocs.mark.retry")}
          </button>
        </p>
      )}
    </div>
  );
}
