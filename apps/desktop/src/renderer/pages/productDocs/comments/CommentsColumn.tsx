import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  useAddProductComment,
  useProductComments,
  useReopenProductComment,
  useResolveProductComment,
} from "../../../data/queries";
import type { ProductCommentThread, ProductPageView, Project } from "../../../data/types";
import { anchorIdsOf } from "../../../domain/productDocs/blocks";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useToast } from "../../../tasks-ui/Toast";
import { CloseIcon } from "../../task/parts";
import type { CommentDraft, ThreadFocus } from "../SideColumn";
import { CommentComposer, type CommentComposerHandle } from "./CommentComposer";
import { CommentThread } from "./CommentThread";

// La colonna dei commenti (shape product-comments-history.md §3.3, [PC 4],
// [PC 5]): una `region` dopo il corpo nell'ordine di Tab. Testata 40 px
// «COMMENTS» col numero degli aperti e ×. Poi, per chi legge soltanto, la
// riga del perché con «Who?» ([PC 8]). I fili aperti con l'ancora viva
// stanno accanto al loro blocco (agganciata: il bordo alto alla prima riga
// del blocco, il successivo 8 px sotto se il primo è più lungo, il filo
// attivo esattamente al suo blocco e gli altri che si spostano, 200 ms);
// sotto un filetto quelli con «Sentence deleted», per `seq`; in fondo,
// chiuso, «N resolved» ▸. Sovrapposta (1024) i fili stanno in fila.
//
// La casella di un commento nuovo è un filo in più, al posto del suo blocco.
// Dopo l'invio il fuoco va sul filo nuovo; «Resolve» lo porta al filo dopo
// (o a «N resolved»); «Reopen» al «Resolve» del filo riaperto ([PC 13]).

const GAP = 8;

type Pending = { kind: "thread"; id: string } | { kind: "resolved" } | { kind: "action"; id: string };

export function CommentsColumn({
  page,
  project,
  mode,
  draft,
  focus,
  active,
  onClose,
  onEndDraft,
  onActive,
  onFocusThread,
  headingRef,
}: {
  page: ProductPageView;
  project: Project;
  mode: "docked" | "overlay";
  draft: CommentDraft | null;
  focus: ThreadFocus | null;
  active: string | null;
  onClose: () => void;
  onEndDraft: () => void;
  onActive: (rootId: string | null) => void;
  onFocusThread: (rootId: string) => void;
  headingRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const comments = useProductComments(page.id);
  const add = useAddProductComment();
  const resolve = useResolveProductComment();
  const reopen = useReopenProductComment();
  const canComment = page.permissions.edit;
  const [showResolved, setShowResolved] = useState(false);
  const [stale, setStale] = useState(false);
  const [announce, setAnnounce] = useState("");
  const threads = useRef(new Map<string, HTMLElement>());
  const actions = useRef(new Map<string, HTMLButtonElement>());
  const resolvedButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<CommentComposerHandle>(null);
  const pending = useRef<Pending | null>(null);
  const handled = useRef<number | null>(null);

  const open = comments.data?.open ?? [];
  const resolved = comments.data?.resolved ?? [];
  const live = open.filter((th) => !th.anchorGone);
  const gone = open.filter((th) => th.anchorGone);

  // `?comment=`, il segno, un filo appena scritto: la colonna su quel filo.
  useEffect(() => {
    if (!focus || !comments.data || handled.current === focus.n) return;
    const inResolved = resolved.some((th) => th.root.id === focus.rootId);
    const found = inResolved || open.some((th) => th.root.id === focus.rootId);
    // Un filo appena scritto può arrivare con la rilettura: si aspetta quella.
    if (!found && comments.isFetching) return;
    handled.current = focus.n;
    setStale(!found);
    if (!found) return;
    if (inResolved) setShowResolved(true);
    pending.current = { kind: "thread", id: focus.rootId };
  });

  // Il fuoco chiesto, appena il suo bersaglio è disegnato.
  useEffect(() => {
    const want = pending.current;
    if (!want) return;
    let el: HTMLElement | null | undefined = null;
    if (want.kind === "thread") el = threads.current.get(want.id);
    else if (want.kind === "action") el = actions.current.get(want.id);
    else el = resolvedButton.current;
    if (!el) return;
    pending.current = null;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "nearest" });
    if (want.kind !== "resolved") {
      const root = want.id;
      onActive(root);
    }
  });

  // --- l'allineamento ai blocchi (agganciata) -------------------------------------

  const order = new Map(page.blocks.flatMap(anchorIdsOf).map((id, i) => [id, i]));
  type Item = { key: string; anchorId: string; thread: ProductCommentThread | null };
  const items: Item[] = live.map((th) => ({ key: th.root.id, anchorId: th.root.anchorId, thread: th }));
  if (draft && canComment) {
    const at = order.get(draft.anchorId) ?? Number.MAX_SAFE_INTEGER;
    const index = items.findIndex((it) => (order.get(it.anchorId) ?? 0) > at);
    items.splice(index < 0 ? items.length : index, 0, { key: `draft-${draft.n}`, anchorId: draft.anchorId, thread: null });
  }
  const list = useRef<HTMLDivElement>(null);
  const boxes = useRef(new Map<string, HTMLElement>());
  const [layout, setLayout] = useState<{ tops: Record<string, number>; height: number } | null>(null);
  const activeKey = draft && canComment ? `draft-${draft.n}` : active;
  const aligned = mode === "docked";
  useLayoutEffect(() => {
    if (!aligned) return;
    const host = list.current;
    if (!host) return;
    const origin = host.getBoundingClientRect().top;
    const anchorTop = (anchorId: string) => {
      const el =
        document.querySelector<HTMLElement>(`[data-editor-body] [data-anchor-id="${CSS.escape(anchorId)}"]`) ??
        document.querySelector<HTMLElement>(`[data-editor-body] [data-block-id="${CSS.escape(anchorId)}"]`);
      if (!el) return 0;
      const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
      return el.getBoundingClientRect().top - origin + (el.hasAttribute("data-block-id") ? pad : 0);
    };
    const want = items.map((it) => Math.max(0, anchorTop(it.anchorId)));
    const heights = items.map((it) => boxes.current.get(it.key)?.offsetHeight ?? 0);
    const tops = placeThreads(want, heights, items.findIndex((it) => it.key === activeKey));
    const next = {
      tops: Object.fromEntries(items.map((it, i) => [it.key, tops[i]!])),
      height: items.length ? Math.max(...tops.map((top, i) => top + heights[i]!)) : 0,
    };
    setLayout((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });
  // Il testo o un filo cambiano altezza (si scrive, una risposta si allarga
  // al fuoco, la finestra si stringe): si rimisura.
  const [, remeasure] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  if (observer.current === null && typeof ResizeObserver !== "undefined") {
    observer.current = new ResizeObserver(() => remeasure((n) => n + 1));
  }
  useEffect(() => {
    const body = document.querySelector("[data-editor-body]");
    if (!aligned || !body) return;
    observer.current?.observe(body);
    return () => observer.current?.unobserve(body);
  }, [aligned, page.id]);
  useEffect(() => () => observer.current?.disconnect(), []);

  // --- i gesti ------------------------------------------------------------------

  const post = (anchorId: string, quote: string) => (body: string) =>
    add.mutateAsync({ pageId: page.id, anchorId, quote, body }).then((made) => {
      setAnnounce(t("productDocs.comments.posted"));
      onEndDraft();
      onFocusThread(made.id);
      return made;
    });
  const reply = (rootId: string, anchorId: string, quote: string) => (body: string) =>
    add.mutateAsync({ pageId: page.id, anchorId, quote, body, replyToId: rootId }).then(() =>
      setAnnounce(t("productDocs.comments.posted")),
    );

  const backToBlock = (anchorId: string) => {
    const el =
      document.querySelector<HTMLElement>(`[data-editor-body] [data-block-text="${CSS.escape(anchorId)}"]`) ??
      document.querySelector<HTMLElement>(`[data-editor-body] [data-block-id="${CSS.escape(anchorId)}"]`);
    el?.focus();
  };

  // Un filo alla volta: un doppio clic su «Resolve» / «Reopen» scrive una volta sola.
  const writing = useRef(new Set<string>());
  // La promessa di OGNI chiamata si chiude: un secondo `mutate` sullo stesso
  // hook staccherebbe le callback per-chiamata del primo (TanStack Query 5),
  // e il suo filo resterebbe bloccato. `mutateAsync(...).finally` no.
  // Un rifiuto non tace: l'avviso lo dice, con «Retry» (revisione finale F2).
  const once = (rootId: string, run: () => Promise<unknown>, failed: string, retry: () => void) => {
    if (writing.current.has(rootId)) return;
    writing.current.add(rootId);
    run()
      .catch(() => {
        toast.error(t(failed), { action: { label: t("productDocs.comments.retry"), run: retry } });
      })
      .finally(() => writing.current.delete(rootId));
  };
  const doResolve = (rootId: string) => {
    const i = live.findIndex((th) => th.root.id === rootId);
    const next = live[i + 1] ?? gone.find((th) => th.root.id !== rootId) ?? null;
    once(
      rootId,
      () =>
        resolve.mutateAsync(rootId).then(() => {
          setAnnounce(t("productDocs.comments.resolved"));
          pending.current = next ? { kind: "thread", id: next.root.id } : { kind: "resolved" };
          if (active === rootId) onActive(null);
        }),
      "productDocs.comments.resolveFailed",
      () => doResolve(rootId),
    );
  };
  const doReopen = (rootId: string) =>
    once(
      rootId,
      () =>
        reopen.mutateAsync(rootId).then(() => {
          setAnnounce(t("productDocs.comments.reopened"));
          pending.current = { kind: "action", id: rootId };
        }),
      "productDocs.comments.reopenFailed",
      () => doReopen(rootId),
    );


  const threadProps = (th: ProductCommentThread, isResolved: boolean) => ({
    thread: th,
    projectId: project.id,
    projectCode: project.code,
    canComment,
    active: active === th.root.id,
    resolved: isResolved,
    onResolve: () => doResolve(th.root.id),
    onReopen: () => doReopen(th.root.id),
    onReply: reply(th.root.id, th.root.anchorId, th.root.quote),
    onActive: () => onActive(th.root.id),
    actionRef: (el: HTMLButtonElement | null) => {
      if (el) actions.current.set(th.root.id, el);
      else actions.current.delete(th.root.id);
    },
  });
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) threads.current.set(id, el);
    else threads.current.delete(id);
  };

  const empty = comments.data && open.length === 0 && resolved.length === 0 && !(draft && canComment);

  return (
    <section
      aria-label={t("productDocs.comments.title")}
      className="flex min-h-full flex-col"
      data-comments-column=""
    >
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 border-b border-rule bg-surface pr-2 pl-4"
      >
        <h2 className="heading-group flex items-baseline gap-1.5">
          {t("productDocs.comments.title")}
          {open.length > 0 && <span className="num text-ink-faint">{open.length}</span>}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("productDocs.comments.close")}
          title={t("productDocs.comments.close")}
          className="ml-auto grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex flex-col gap-3 px-3 pt-3 pb-6">
        {!canComment && (
          <p className="text-sm text-pretty text-ink-muted">
            {t("productDocs.comments.readOnly", { code: project.code })}{" "}
            · <WhoCanLink action="editDocs" projectId={project.id} projectCode={project.code} />
          </p>
        )}
        {stale && <p className="text-xs text-ink-faint">{t("productDocs.comments.stale")}</p>}
        {comments.isPending && <ThreadSkeletons />}
        {comments.isError && (
          <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-sm text-critical">
            <span>{t("productDocs.comments.loadError")}</span>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => void comments.refetch()} className="font-medium underline underline-offset-2">
              {t("productDocs.comments.retry")}
            </button>
          </p>
        )}
        {empty && (
          <p className="text-sm text-pretty text-ink-muted">
            {t(canComment ? "productDocs.comments.emptyWrite" : "productDocs.comments.emptyRead")}
          </p>
        )}
        {items.length > 0 && (
          <div
            ref={list}
            className={aligned ? "relative" : "flex flex-col gap-2"}
            style={aligned ? { height: layout?.height ?? undefined } : undefined}
          >
            {items.map((it) => {
              const style = aligned
                ? {
                    position: "absolute" as const,
                    left: 0,
                    right: 0,
                    top: layout?.tops[it.key] ?? 0,
                    transition: "top 200ms cubic-bezier(0.16, 1, 0.3, 1)",
                  }
                : undefined;
              const measure = (el: HTMLElement | null) => {
                const was = boxes.current.get(it.key);
                if (was && was !== el) observer.current?.unobserve(was);
                if (el) {
                  boxes.current.set(it.key, el);
                  if (aligned) observer.current?.observe(el);
                } else boxes.current.delete(it.key);
              };
              if (!it.thread) {
                return (
                  <div
                    key={it.key}
                    ref={measure}
                    style={style}
                    className="side-thread flex flex-col gap-2 rounded-lg border border-rule-strong bg-surface p-3"
                  >
                    <p title={draft!.quote} className="line-clamp-2 text-xs leading-4 text-ink-muted [overflow-wrap:anywhere]">
                      {`“${draft!.quote}”`}
                    </p>
                    <CommentComposer
                      ref={composer}
                      autoFocus
                      projectId={project.id}
                      projectCode={project.code}
                      placeholder={t("productDocs.comments.placeholder")}
                      sendLabel={t("productDocs.comments.comment")}
                      onSubmit={post(draft!.anchorId, draft!.quote)}
                      onCancel={() => {
                        const anchor = draft!.anchorId;
                        onEndDraft();
                        backToBlock(anchor);
                      }}
                    />
                  </div>
                );
              }
              const th = it.thread;
              return (
                <div key={it.key} ref={measure} style={style} className="side-thread">
                  <CommentThread ref={register(th.root.id)} {...threadProps(th, false)} />
                </div>
              );
            })}
          </div>
        )}
        {gone.length > 0 && (
          <div className={`flex flex-col gap-2 ${items.length > 0 ? "border-t border-rule pt-3" : ""}`}>
            {gone.map((th) => (
              <CommentThread key={th.root.id} ref={register(th.root.id)} {...threadProps(th, false)} />
            ))}
          </div>
        )}
        {resolved.length > 0 && (
          <div className={`flex flex-col gap-2 ${items.length > 0 || gone.length > 0 ? "border-t border-rule pt-2" : ""}`}>
            <button
              ref={resolvedButton}
              type="button"
              aria-expanded={showResolved}
              onClick={() => setShowResolved((v) => !v)}
              className="inline-flex h-7 items-center gap-1 self-start rounded-md px-1.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              {t("productDocs.comments.resolvedCount", { count: resolved.length })}
              <svg
                viewBox="0 0 16 16"
                width={12}
                height={12}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
                focusable="false"
                className={`transition-transform duration-[var(--duration-fast)] ease-out ${showResolved ? "rotate-90" : ""}`}
              >
                <path d="m6 3.5 4.5 4.5L6 12.5" />
              </svg>
            </button>
            {showResolved &&
              resolved.map((th) => (
                <CommentThread key={th.root.id} ref={register(th.root.id)} {...threadProps(th, true)} />
              ))}
          </div>
        )}
      </div>
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </section>
  );
}

/**
 * Dove stanno i fili accanto ai blocchi: ognuno vorrebbe stare a `want`;
 * mai sovrapposti (8 px fra due). Il filo attivo sta esattamente al suo
 * blocco e gli altri si spostano: sopra di lui risalgono, sotto scendono.
 */
export function placeThreads(want: readonly number[], heights: readonly number[], activeIndex: number): number[] {
  const n = want.length;
  const tops = [...want];
  const forward = (from: number) => {
    for (let i = Math.max(from, 1); i < n; i++) tops[i] = Math.max(tops[i]!, tops[i - 1]! + heights[i - 1]! + GAP);
  };
  if (activeIndex < 0 || activeIndex >= n) {
    tops[0] = Math.max(0, tops[0] ?? 0);
    forward(1);
    return tops;
  }
  for (let i = activeIndex - 1; i >= 0; i--) tops[i] = Math.min(tops[i]!, tops[i + 1]! - heights[i]! - GAP);
  if ((tops[0] ?? 0) < 0) {
    // Non c'è posto sopra: si riparte dall'alto, e anche l'attivo scende.
    tops[0] = 0;
    forward(1);
    return tops;
  }
  forward(activeIndex + 1);
  return tops;
}

function ThreadSkeletons() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2">
      <span role="status" className="sr-only">
        {t("productDocs.comments.loading")}
      </span>
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-rule p-3">
          <span className={`h-3 w-3/5 ${bar}`} />
          <span className={`h-3.5 w-2/5 ${bar}`} />
          <span className={`h-3.5 w-full ${bar}`} />
        </div>
      ))}
    </div>
  );
}
