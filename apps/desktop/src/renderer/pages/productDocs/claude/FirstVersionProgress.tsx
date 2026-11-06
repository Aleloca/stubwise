import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenProductQuestions } from "../../../data/queries";
import type { ProductFirstVersionView } from "../../../data/types";
import { DocCode } from "../../docs/parts";
import { productPageLink } from "../parts";

// L'avanzamento della prima versione (11b, Task 11; shape
// product-claude-questions.md §3.6, [PQ 8]): al posto dello stato vuoto,
// nell'indice, lo vede chiunque legge lo spazio. Il titolo con l'anello che
// pulsa, «3 of 10 pages · for Laura Costa», poi le pagine nell'ordine
// dell'albero: scritta (✓, codice, titolo che apre la pagina), in scrittura
// (l'anello, «writing…»), in attesa (tenue). Alla fine «Claude wrote the
// first version», le pagine e le domande da chiudere, «Open the first
// page». Un copione interrotto (una pagina tolta, il permesso perso) si
// ferma dov'è e lo dice, senza errore: non è «finita». Ogni pagina scritta
// e la fine si annunciano; il fuoco non si sposta da solo (solo all'avvio
// dalla finestra, `focusRequest`). Lo stato lo dà tutto il livello dati.

const MAX_INDENT = 4;

/** L'anello di Claude: fermo, o che pulsa mentre scrive («Claude working»). */
export function ClaudeRing({ size, pulse }: { size: 12 | 16; pulse: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`inline-block shrink-0 rounded-full border-[1.5px] border-dashed border-claude ${pulse ? "rail-pulse" : ""}`}
    />
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true" focusable="false" className="shrink-0 text-ink">
      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FirstVersionProgress({
  view,
  projectCode,
  focusRequest,
  onFocused,
}: {
  view: ProductFirstVersionView;
  projectCode: string;
  /** L'avvio dalla finestra: il fuoco al titolo, poi la finestra si chiude. */
  focusRequest: boolean;
  onFocused: () => void;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  const writing = view.status === "writing";
  const stopped = !writing && view.interrupted;
  const questions = useOpenProductQuestions(view.projectId, { enabled: !writing }).data?.count ?? 0;

  useLayoutEffect(() => {
    if (!focusRequest) return;
    heading.current?.focus();
    onFocused();
  }, [focusRequest, onFocused]);

  // L'annuncio: ogni pagina scritta, poi la fine (o l'interruzione).
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef<{ done: number; status: string } | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = { done: view.pagesDone, status: view.status };
    if (!before) return;
    if (before.status === "writing" && view.status !== "writing") {
      setAnnouncement(
        t(view.interrupted ? "productDocs.firstVersion.progress.stoppedTitle" : "productDocs.firstVersion.progress.doneTitle"),
      );
      return;
    }
    if (view.pagesDone > before.done) {
      const page = view.pages[view.pagesDone - 1];
      if (page) setAnnouncement(t("productDocs.firstVersion.progress.written", { title: page.title }));
    }
  }, [view, t]);

  const titleKey = writing
    ? "productDocs.firstVersion.progress.title"
    : stopped
      ? "productDocs.firstVersion.progress.stoppedTitle"
      : "productDocs.firstVersion.progress.doneTitle";
  const first = view.pages.find((p) => p.code !== null);
  const written = view.pages.filter((p) => p.state === "written").length;
  const summary = writing
    ? [
        t("productDocs.firstVersion.progress.count", { done: view.pagesDone, total: view.pagesTotal }),
        ...(view.byName ? [t("productDocs.firstVersion.progress.for", { name: view.byName })] : []),
      ]
    : [
        stopped
          ? t("productDocs.firstVersion.progress.stoppedCount", { done: written, total: view.pagesTotal })
          : t("productDocs.firstVersion.progress.pages", { count: view.pagesTotal }),
        ...(questions > 0 ? [t("productDocs.firstVersion.progress.questions", { count: questions })] : []),
      ];

  return (
    <section className="flex flex-col gap-2 pt-10">
      <span aria-live="polite" data-first-version-announce="" className="sr-only">
        {announcement}
      </span>
      <div className="flex items-center gap-2.5">
        <ClaudeRing size={16} pulse={writing} />
        <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
          {t(titleKey)}
        </h2>
      </div>
      <p className="num text-md text-ink-muted">{summary.join(" · ")}</p>
      {!writing && first?.code && (
        <div className="pt-2">
          <Link
            {...productPageLink(projectCode, first.code)}
            className="inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
          >
            {t("productDocs.firstVersion.progress.openFirst")}
          </Link>
        </div>
      )}
      <ul aria-label={t("productDocs.firstVersion.progress.list")} className="mt-4 border-t border-rule">
        {view.pages.map((page, i) => {
          // Il rientro sta dentro la riga, così la tinta del passaggio la copre tutta.
          const indent = { paddingLeft: 8 + Math.min(page.depth, MAX_INDENT) * 16 };
          const row = "flex min-h-8 min-w-0 items-center gap-3 py-1 pr-2";
          return (
            <li key={i} className="border-b border-rule">
              {page.state === "written" && page.code ? (
                <Link
                  {...productPageLink(projectCode, page.code)}
                  style={indent}
                  className={`${row} outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus`}
                >
                  <Check />
                  <DocCode code={page.code} />
                  <span className="min-w-0 flex-1 truncate text-md text-ink" title={page.title}>
                    {page.title}
                  </span>
                </Link>
              ) : page.state === "writing" ? (
                <div style={indent} className={row}>
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <ClaudeRing size={12} pulse />
                  </span>
                  <span className="min-w-0 truncate text-md text-ink" title={page.title}>
                    {page.title}
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">{t("productDocs.firstVersion.progress.writing")}</span>
                </div>
              ) : (
                <div style={indent} className={row}>
                  <span aria-hidden="true" className="w-3.5 shrink-0" />
                  <span className="min-w-0 truncate text-md text-ink-faint" title={page.title}>
                    {page.title}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
