import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../tasks-ui/Toast";
import { ghostButton } from "../task/parts";
import { Glyph } from "../automations/glyphs";
import { platformOf } from "./format";
import { ExternalGlyph } from "./glyphs";

// Il log di una run (shape releases.md [R 7], [R 18], [R 24]): si apre con
// le ultime 40 righe; «Show all» lo apre in posto, alto fino a 70vh,
// posizionato in fondo (dove c'è l'errore), con una finestra di righe
// disegnate: 5000 righe non bloccano la finestra perché se ne disegnano solo
// i blocchi vicini alla vista. «Find in log» (⌘F o `/` col fuoco nel log):
// corrispondenze sottolineate, la corrente con fondo ink/10 — mai solo
// colore. Nessuna evidenziazione inventata delle righe «di errore»: il passo
// fallito lo dice la piattaforma, il resto è testo.

/** Le righe con cui il log si apre. */
export const LOG_TAIL = 40;
/** Le righe di un blocco della finestra. */
const CHUNK = 200;
/** L'altezza stimata di una riga (12px/18px), finché il blocco non si misura. */
const LINE_PX = 18;
/** Quanti blocchi prima e dopo quello in vista si disegnano. */
const OVERSCAN = 1;

function Highlighted({
  text,
  query,
  current,
}: {
  text: string;
  query: string;
  current: boolean;
}): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  let i = lower.indexOf(q);
  while (i >= 0) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(
      <mark
        key={i}
        data-log-match
        className={`rounded-[2px] bg-transparent text-ink underline decoration-ink decoration-2 underline-offset-2 ${current ? "bg-ink/10" : ""}`}
      >
        {text.slice(i, i + q.length)}
      </mark>,
    );
    at = i + q.length;
    i = lower.indexOf(q, at);
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

function Line({
  n,
  text,
  query,
  current,
}: {
  n: number;
  text: string;
  query: string;
  current: boolean;
}) {
  return (
    <li
      data-log-line={n}
      className="grid grid-cols-[var(--log-gutter)_minmax(0,1fr)] gap-3 [overflow-wrap:anywhere] whitespace-pre-wrap"
    >
      <span aria-hidden="true" className="num text-right text-ink-faint select-none">
        {n}
      </span>
      <span>
        <Highlighted text={text} query={query} current={current} />
      </span>
    </li>
  );
}

export function RunLog({ runName, log, url }: { runName: string; log: string; url: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const lines = useMemo(() => log.split("\n"), [log]);
  const total = lines.length;
  const [all, setAll] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const chunks = Math.ceil(total / CHUNK);
  // Il blocco in vista: all'apertura l'ultimo (l'errore è in fondo).
  const [view, setView] = useState(chunks - 1);
  const heights = useRef(new Map<number, number>());

  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const q = query.toLowerCase();
    const out: number[] = [];
    lines.forEach((l, i) => {
      if (l.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [lines, query]);
  const currentLine = matches[at] ?? -1;

  const chunkTop = useCallback((c: number) => {
    let y = 0;
    for (let i = 0; i < c; i++) y += heights.current.get(i) ?? CHUNK * LINE_PX;
    return y;
  }, []);

  // Aperto: in fondo.
  useLayoutEffect(() => {
    if (!all) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [all]);

  // La corrispondenza corrente si porta in vista.
  useEffect(() => {
    if (!all || currentLine < 0) return;
    const c = Math.floor(currentLine / CHUNK);
    setView(c);
    requestAnimationFrame(() => {
      scroller.current
        ?.querySelector(`[data-log-line="${currentLine + 1}"]`)
        ?.scrollIntoView?.({ block: "center" });
    });
  }, [all, currentLine]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    let c = 0;
    while (c < chunks - 1 && chunkTop(c + 1) <= el.scrollTop) c++;
    if (c !== view) setView(c);
  };

  const measure = (c: number) => (el: HTMLOListElement | null) => {
    if (el && el.offsetHeight > 0) heights.current.set(c, el.offsetHeight);
  };

  const openFind = () => {
    if (!all) setAll(true);
    setFinding(true);
    requestAnimationFrame(() => findInput.current?.focus());
  };
  const onLogKey = (e: KeyboardEvent<HTMLElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT") return;
    if (e.key === "/" || (e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      openFind();
    }
  };
  const step = (d: number) => {
    if (matches.length === 0) return;
    setAt((i) => (i + d + matches.length) % matches.length);
  };

  const copy = () => {
    void navigator.clipboard?.writeText(log).then(
      () => toast.show(t("releases.log.copied")),
      () => toast.error(t("releases.log.copyError")),
    );
  };

  const format = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  const regionLabel = t("releases.log.region", { run: runName, total: format(total) });

  let body: ReactNode;
  if (!all) {
    const from = Math.max(0, total - LOG_TAIL);
    body = (
      <ol className="flex flex-col px-3 py-2">
        {lines.slice(from).map((l, i) => (
          <Line key={from + i} n={from + i + 1} text={l} query="" current={false} />
        ))}
      </ol>
    );
  } else {
    const first = Math.max(0, view - OVERSCAN);
    const last = Math.min(chunks - 1, view + OVERSCAN);
    const blocks: ReactNode[] = [];
    if (first > 0)
      blocks.push(<div key="top" style={{ height: chunkTop(first) }} aria-hidden="true" />);
    for (let c = first; c <= last; c++) {
      const start = c * CHUNK;
      blocks.push(
        <ol key={c} ref={measure(c)} start={start + 1} className="flex flex-col">
          {lines.slice(start, start + CHUNK).map((l, i) => (
            <Line
              key={start + i}
              n={start + i + 1}
              text={l}
              query={query}
              current={start + i === currentLine}
            />
          ))}
        </ol>,
      );
    }
    if (last < chunks - 1) {
      blocks.push(
        <div
          key="bottom"
          aria-hidden="true"
          style={{ height: chunkTop(chunks) - chunkTop(last + 1) }}
        />,
      );
    }
    body = (
      <div
        ref={scroller}
        onScroll={onScroll}
        data-log-scroller
        className="max-h-[70vh] overflow-y-auto px-3 py-2"
      >
        {blocks}
      </div>
    );
  }

  return (
    <section
      aria-label={regionLabel}
      onKeyDown={onLogKey}
      data-run-log
      className="flex flex-col rounded-md border border-rule [--log-gutter:48px] @max-[640px]:[--log-gutter:36px]"
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-rule px-3 py-1.5">
        <span className="num mr-auto text-sm text-ink-muted">
          {all
            ? t("releases.log.allLines", { total: format(total) })
            : t("releases.log.lastLines", { n: Math.min(LOG_TAIL, total), total: format(total) })}
        </span>
        {all && finding && (
          <span className="flex items-center gap-1">
            <input
              ref={findInput}
              type="search"
              aria-label={t("releases.log.find")}
              placeholder={t("releases.log.find")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setAt(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  step(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setFinding(false);
                  setQuery("");
                }
              }}
              className="h-7 w-44 rounded-md border border-rule-strong bg-transparent px-2 text-sm text-ink placeholder:text-ink-faint"
            />
            <span aria-live="polite" className="num min-w-14 pl-1 text-sm text-ink-muted">
              {query
                ? t("releases.log.matchOf", { i: matches.length ? at + 1 : 0, n: matches.length })
                : ""}
            </span>
            <button
              type="button"
              className={ghostButton}
              aria-label={t("releases.log.previous")}
              onClick={() => step(-1)}
            >
              <Glyph size={14}>
                <path d="m4 10 4-4 4 4" />
              </Glyph>
            </button>
            <button
              type="button"
              className={ghostButton}
              aria-label={t("releases.log.next")}
              onClick={() => step(1)}
            >
              <Glyph size={14}>
                <path d="m4 6 4 4 4-4" />
              </Glyph>
            </button>
          </span>
        )}
        {all && !finding && (
          <button type="button" className={ghostButton} onClick={openFind}>
            {t("releases.log.find")}
          </button>
        )}
        <button
          type="button"
          className={ghostButton}
          aria-expanded={all}
          onClick={() => {
            setAll((v) => !v);
            setFinding(false);
            setQuery("");
            setView(chunks - 1);
          }}
        >
          {all ? t("releases.log.showLess") : t("releases.log.showAll")}
        </button>
        <button type="button" className={ghostButton} onClick={copy}>
          {t("releases.log.copy")}
        </button>
        <a href={url} target="_blank" rel="noreferrer" className={ghostButton}>
          {t("releases.openOn", { platform: platformOf(url) })}
          <ExternalGlyph />
        </a>
      </div>
      <div className="font-code text-xs leading-[18px] text-ink">{body}</div>
    </section>
  );
}
