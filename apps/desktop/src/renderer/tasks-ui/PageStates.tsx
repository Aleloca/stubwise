import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

// Larghezze dei titoli finti: fisse (non casuali), così lo scheletro non
// cambia a ogni render e somiglia a un elenco vero, con titoli diversi.
const TITLE_WIDTHS = ["62%", "48%", "71%", "40%", "56%", "67%", "44%", "52%", "60%", "36%"];

const bar = "rounded-sm bg-ink/8";

/** Una riga finta con la forma di `TaskRow`: striscia, codice, titolo, stato, persona. */
function SkeletonRow({ index }: { index: number }) {
  return (
    <div
      data-skeleton-row
      className="relative flex h-9 items-center gap-3 border-b border-rule pr-3 pl-4"
    >
      <span className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-[1px] bg-ink/10" />
      <span className={`h-2.5 w-12 shrink-0 ${bar}`} />
      <span className="min-w-0 flex-1">
        <span
          className={`block h-2.5 ${bar}`}
          style={{ width: TITLE_WIDTHS[index % TITLE_WIDTHS.length] }}
        />
      </span>
      <span className={`h-2.5 w-[88px] shrink-0 ${bar}`} />
      <span className="flex w-[120px] shrink-0 items-center gap-2">
        <span className="size-5 rounded-full bg-ink/8" />
        <span className={`h-2.5 w-16 ${bar}`} />
      </span>
    </div>
  );
}

/** Una colonna finta della board: intestazione e qualche carta. */
function SkeletonColumn({ index }: { index: number }) {
  return (
    <div data-skeleton-column className="flex w-[264px] shrink-0 flex-col gap-2">
      <span className={`mb-1 h-3 w-24 ${bar}`} />
      {Array.from({ length: 4 - (index % 2) }, (_, i) => (
        <div key={i} className="flex h-[76px] flex-col gap-2 rounded-md border border-rule p-3">
          <span className={`h-2.5 w-12 ${bar}`} />
          <span className={`h-2.5 ${bar}`} style={{ width: TITLE_WIDTHS[(index + i) % 10] }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Caricamento con la forma vera della pagina: righe di elenco (`rows`) o
 * colonne di board (`columns`). Respira piano (opacità), fermo con
 * movimento ridotto; per i lettori di schermo dice «Loading…».
 */
export function PageSkeleton({
  shape = "rows",
  rows = 8,
  columns = 4,
}: {
  shape?: "rows" | "columns";
  rows?: number;
  columns?: number;
}) {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {shape === "rows" ? (
        Array.from({ length: rows }, (_, i) => <SkeletonRow key={i} index={i} />)
      ) : (
        <div className="flex gap-4 overflow-hidden px-4 py-3">
          {Array.from({ length: columns }, (_, i) => (
            <SkeletonColumn key={i} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

const secondaryButton =
  "inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10";

/**
 * Errore al posto del corpo (la testata della pagina resta): cosa non è
 * riuscito e «Retry». Il messaggio lo scrive la pagina («Couldn't load tasks»).
 */
export function PageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex flex-col items-start gap-3 px-4 py-10">
      <p className="text-md text-ink">{message}</p>
      <button type="button" onClick={onRetry} className={secondaryButton}>
        {t("taskUi.states.retry")}
      </button>
    </div>
  );
}

/**
 * Vuoto: un titolo, la frase (chi può riempirlo, se chi guarda non può) e
 * l'azione che lo riempie quando c'è il permesso. Allineato a sinistra, dove
 * comincerebbe l'elenco: niente illustrazioni.
 */
export function PageEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex max-w-[60ch] flex-col items-start gap-2 px-4 py-10">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {body && <p className="text-md text-ink-muted">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
