import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { inputClass } from "../../tasks-ui/Dialog";
import { smallSecondary } from "../task/parts";

/** Un campo corto (numeri): come quelli dei dialoghi, ma della larghezza che gli si dà. */
export const shortInput = inputClass.replace("w-full ", "");

// Una parte del dettaglio di un server (shape servers.md §3): titolo
// `headline`, azione a destra, e l'ancora per l'indice agganciato (lo
// `scroll-margin` lascia posto all'indice). Come le parti delle Releases.

export function Part({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={`server-${id}`}
      data-part={id}
      aria-labelledby={`server-${id}-title`}
      className="flex scroll-mt-12 flex-col gap-3"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <h2 id={`server-${id}-title`} className="text-xl font-semibold text-ink">
          {title}
        </h2>
        {action && <span className="ml-auto flex flex-wrap items-center gap-2">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** L'errore di una parte: le altre restano. */
export function PartError({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-center gap-3 border-t border-rule py-3 pl-3">
      <p className="text-md text-ink">{message}</p>
      <button type="button" className={smallSecondary} onClick={retry}>
        {t("taskUi.states.retry")}
      </button>
    </div>
  );
}

/** «Saved»: compare solo dopo la conferma del livello dati, sparisce alla prima modifica. */
export function SavedNote({ shown }: { shown: boolean }) {
  const { t } = useTranslation();
  return (
    <span role="status" className="text-sm text-ink-muted">
      {shown ? t("servers.saved") : ""}
    </span>
  );
}
