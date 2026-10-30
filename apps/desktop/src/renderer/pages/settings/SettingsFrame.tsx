import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PageSkeleton } from "../../tasks-ui/PageStates";
import { smallSecondary } from "../task/parts";
import type { BlockState } from "../home/blocks/BlockSection";

// Il guscio di una sezione di Progetto → Settings (area 9a, [RM 4]): ogni
// sezione è una pagina, con il suo h1 da 28 px, una riga in prosa e, a
// destra, l'azione della pagina (Members: «Add member»). Fino a 880 px.

export function SettingsFrame({
  title,
  intro,
  action,
  children,
}: {
  title: string;
  intro?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-h-full flex-col pb-16 pl-8">
      <div className="flex w-full max-w-[880px] flex-1 flex-col pr-8">
        <header className="page-header flex shrink-0 flex-col gap-1.5 pb-5 [--page-header-pt:32px]">
          <div className="flex min-h-8 items-center gap-3">
            <h1 id={id} className="min-w-0 flex-1 text-2xl font-semibold tracking-[-0.01em] text-ink">
              {title}
            </h1>
            {action}
          </div>
          {intro && <p className="max-w-[72ch] text-md text-pretty text-ink-muted">{intro}</p>}
        </header>
        {children}
      </div>
    </section>
  );
}

/** Caricamento ed errore di una sezione, sotto la testata; pronta, il contenuto. */
export function SettingsState({
  state,
  error,
  children,
}: {
  state: BlockState;
  /** La frase dell'errore («Couldn't load the statuses.»). */
  error: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (state.status === "loading")
    return (
      <div className="border-t border-rule">
        <PageSkeleton rows={6} />
      </div>
    );
  if (state.status === "error")
    return (
      <div role="alert" className="flex items-center gap-3 border-t border-rule py-3">
        <p className="text-md text-ink">{error}</p>
        <button type="button" className={smallSecondary} onClick={state.retry}>
          {t("taskUi.states.retry")}
        </button>
      </div>
    );
  return <>{children}</>;
}
