import { useId, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../../data/dates";
import { usePeople, useProductRevisions } from "../../../data/queries";
import type {
  ProductBlock,
  ProductBlockChange,
  ProductPageView,
  ProductRevisionView,
  ProductTreeNode,
  RichText,
} from "../../../data/types";
import { formatDate } from "../../../notifications/time";
import { CloseIcon } from "../../task/parts";
import { blockLabel } from "../editor/BlockBody";
import { RichView } from "../editor/RichView";
import { useProductSpaceContext } from "../parts";

// La cronologia di una pagina (shape product-comments-history.md §3.7,
// [PC 9], [PC 10]): nella stessa colonna dei commenti, una alla volta.
// Righe dalla più recente (`lastSeq`), raggruppate per giorno: iniziali ·
// nome · cosa · ora. Aperta (clic, Invio o →; ← chiude), per ancora in
// verticale: l'etichetta del tipo quando non è un paragrafo, «Before» e
// «After» col testo coi suoi segni (`RichView`); una frase tolta solo
// «Before» con «Removed», una aggiunta solo «After» con «Added», un cambio
// di soli segni «Formatting changed» con «After». Più di 5 ancore: le prime
// 5 e «Show N more». Le parole cambiate non si evidenziano nel 11a. Si
// legge: niente «Restore» né «Undo» (l'«Annulla» delle modifiche di Claude
// è del 11b). Una revisione senza `via` né `sessionId`, o con blocchi senza
// `marks`, si disegna come le altre.

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
    case "move": {
      const to = r.parent?.afterId ?? null;
      if (to === null) return t("productDocs.history.moveTop");
      const parent = findTitle(tree, to);
      return parent ? t("productDocs.history.moveUnder", { parent }) : t("productDocs.history.moved");
    }
    default: {
      const details = r.changes.flatMap((c) => detailsOf(c, t));
      if (details.length > 0 && details.every((d) => d.kind === "formatting")) return t("productDocs.history.formatting");
      return t("productDocs.history.edit", { count: Math.max(details.length, 1) });
    }
  }
}

const clock = (iso: string, language: string) =>
  new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(
    new Date(iso),
  );

export function HistoryPanel({
  page,
  onClose,
  headingRef,
}: {
  page: ProductPageView;
  onClose: () => void;
  headingRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const { space } = useProductSpaceContext();
  const revisions = useProductRevisions(page.id);
  const people = usePeople().data ?? [];
  const [limit, setLimit] = useState(FIRST);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const listId = useId();

  const all = revisions.data ?? [];
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
                    return (
                      <li key={r.id} className="flex flex-col">
                        <button
                          type="button"
                          id={rowId(r)}
                          data-history-row=""
                          aria-expanded={isOpen}
                          aria-controls={`${rowId(r)}-details`}
                          onKeyDown={(e) => onKeyDown(e, index)}
                          onClick={() => toggle(r.id)}
                          className="mx-1.5 flex cursor-default items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/5 aria-expanded:bg-ink/6"
                        >
                          <span
                            aria-hidden="true"
                            className="mt-px grid size-6 shrink-0 place-items-center rounded-full border border-rule-strong text-xs font-semibold text-ink-muted"
                          >
                            {person?.initials ?? r.actorName.slice(0, 1)}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-semibold text-ink">{r.actorName}</span>
                            <span className="text-ink-muted [overflow-wrap:anywhere]">{summaryOf(r, space.tree, t)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1 text-xs text-ink-faint">
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
                        </button>
                        <div id={`${rowId(r)}-details`} hidden={!isOpen}>
                          {isOpen && <RevisionDetails revision={r} />}
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

function RevisionDetails({ revision }: { revision: ProductRevisionView }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const details = revision.changes.flatMap((c) => detailsOf(c, t));
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
          {d.kind !== "removed" && <Version label={t("productDocs.history.after")} side={d.after} />}
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

function Version({ label, side, muted = false }: { label: string; side: Side; muted?: boolean }) {
  return (
    <div className="flex flex-col">
      <p className="text-xs font-semibold text-ink-muted">{label}</p>
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
