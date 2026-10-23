import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageSkeleton } from "../../../tasks-ui/PageStates";
import { ghostButton, smallSecondary } from "../../task/parts";

// Il guscio comune dei blocchi della Home (shape home.md §3): ogni blocco è
// una sezione della colonna di lettura, separata dalla precedente da un
// filetto, con titolo `headline`, conteggio in cifre tabellari e l'azione a
// destra. Niente riquadri: il blocco è titolo + filetto. Quattro stati, tutti
// DENTRO il blocco: l'errore di uno non abbatte la Home.

export type BlockState =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "empty"; text: string; body?: string }
  | { status: "ready" };

export function BlockSection({
  title,
  count,
  meta,
  action,
  state,
  children,
}: {
  title: string;
  /** Quante voci ha il blocco (si mostra solo se > 0 e il blocco è pronto). */
  count?: number;
  /** Una riga breve accanto al titolo (es. la settimana). */
  meta?: ReactNode;
  action?: ReactNode;
  state: BlockState;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} data-home-block className="border-t border-rule pt-5 pb-7">
      <div className="flex min-h-8 items-center gap-3 pb-3">
        <h2 id={id} className="min-w-0 truncate text-xl font-semibold text-ink">
          {title}
        </h2>
        {state.status === "ready" && count !== undefined && count > 0 && (
          <span className="num text-md text-ink-faint">{count}</span>
        )}
        {meta && <span className="min-w-0 truncate text-sm text-ink-muted">{meta}</span>}
        {action && <span className="ml-auto flex shrink-0 items-center gap-1">{action}</span>}
      </div>
      {state.status === "loading" && (
        <div className="border-t border-rule">
          <PageSkeleton rows={3} />
        </div>
      )}
      {state.status === "error" && (
        <div role="alert" className="flex items-center gap-3 border-t border-rule py-3 pl-4">
          <p className="text-md text-ink">{t("home.block.error", { title })}</p>
          <button type="button" className={smallSecondary} onClick={state.retry}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      )}
      {state.status === "empty" && (
        <div className="flex flex-col gap-0.5 border-t border-rule py-3 pl-4">
          <p className="text-md text-ink">{state.text}</p>
          {state.body && <p className="text-sm text-ink-muted">{state.body}</p>}
        </div>
      )}
      {state.status === "ready" && children}
    </section>
  );
}

/** Il guscio di un blocco da una o più query: caricamento, errore (Riprova le sole fallite) o pronto. */
export function queryState(
  queries: { isError: boolean; data?: unknown; refetch: () => unknown }[],
  empty?: { when: boolean; text: string; body?: string },
): BlockState {
  if (queries.some((q) => q.isError)) {
    return {
      status: "error",
      retry: () => {
        for (const q of queries) if (q.isError) void q.refetch();
      },
    };
  }
  if (queries.some((q) => q.data === undefined)) return { status: "loading" };
  if (empty?.when) return { status: "empty", text: empty.text, body: empty.body };
  return { status: "ready" };
}

/** Quante righe mostra un gruppo prima di «Show N more» (shape home.md §5). */
export const BLOCK_CAP = 5;

/**
 * Un elenco che mostra le prime `BLOCK_CAP` voci e poi «Show N more», che
 * espande sul posto (e «Show fewer» richiude). Il fuoco resta sul bottone.
 */
export function Capped<T>({
  items,
  render,
  label,
  closing,
}: {
  items: T[];
  render: (item: T) => ReactNode;
  /** Il nome dell'elenco, per i lettori di schermo. */
  label?: string;
  /** Le voci che si stanno chiudendo: restano per l'animazione ma non contano. */
  closing?: (item: T) => boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  let counted = 0;
  const shown = items.filter((item) => {
    if (closing?.(item)) return open || counted < BLOCK_CAP;
    counted += 1;
    return open || counted <= BLOCK_CAP;
  });
  const hidden = counted - BLOCK_CAP;
  return (
    <>
      <ul aria-label={label} className="border-t border-rule">
        {shown.map(render)}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={open}
          className={`${ghostButton} mt-1 ml-2`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("home.block.showFewer") : t("home.block.showMore", { count: hidden })}
        </button>
      )}
    </>
  );
}

/**
 * La legenda dei reparti della Home dice solo i reparti delle strisce che si
 * vedono (DESIGN.md, «Task row and department strip»): ogni blocco con righe
 * di task dichiara i suoi, la pagina ne fa l'unione.
 */
export const DepartmentsReport = createContext<(block: string, ids: string[]) => void>(() => {});

export function useReportDepartments(block: string, tasks: readonly { departmentId: string }[]) {
  const report = useContext(DepartmentsReport);
  const ids = [...new Set(tasks.map((t) => t.departmentId))].sort().join(",");
  useEffect(() => {
    report(block, ids ? ids.split(",") : []);
    return () => report(block, []);
  }, [report, block, ids]);
}

/** Apre una task nel pannello (`?task=`), restando sulla Home. */
export function useOpenTask(): (code: string) => void {
  const navigate = useNavigate();
  return (code) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, task: code }),
    } as never);
}
