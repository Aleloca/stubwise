import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProductLinkedRequests } from "../../../data/queries";
import type { ProductLinkedRequest } from "../../../data/types";
import { CodeLink } from "../../../components/CodeLink";

// Le voci collegate in fondo alla pagina (11b, Task 12; shape
// product-claude-backlog.md §3.3, [PB 4]): le richieste nate da questa
// pagina, «From this page» col numero. Solo ciò che chi guarda vede
// (`listProductLinkedRequests`): nessuna voce visibile, la sezione non c'è.
// Sta fuori dall'editor (non è un blocco, non entra nell'esportazione, non
// si modifica da qui): la tastiera la raggiunge con Tab dopo il corpo. Le
// richieste confermate dalla scheda di Claude compaiono subito (la conferma
// rilegge l'area delle richieste), in dissolvenza.

/** Quante righe prima di «Show all N». */
const SHOWN = 10;
/** Quante task nate si nominano prima di «+N». */
const SHOWN_TASKS = 2;

export function LinkedRequests({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  const linked = useProductLinkedRequests(pageId);
  const [all, setAll] = useState(false);
  if (linked.isError) {
    return (
      <p className="mt-8 flex flex-wrap items-center gap-x-1.5 border-t border-rule pt-4 text-xs text-critical">
        <span>{t("productDocs.backlog.linked.loadError")}</span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => void linked.refetch()}
          className="font-medium underline underline-offset-2"
        >
          {t("productDocs.backlog.linked.retry")}
        </button>
      </p>
    );
  }
  const rows = linked.data ?? [];
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <section aria-labelledby={titleId} data-linked-requests="" className="mt-8 flex flex-col border-t border-rule pt-4">
      <h2 id={titleId} className="heading-group flex items-baseline gap-1.5 pb-1">
        {t("productDocs.backlog.linked.title")}
        <span className="num text-ink-faint">{rows.length}</span>
      </h2>
      <ul className="flex flex-col">
        {shown.map((row) => (
          <li key={row.id} className="event-enter flex min-h-8 min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0">
              <CodeLink code={row.code} />
            </span>
            <span className="min-w-0 flex-1 truncate text-ink" title={row.title}>
              {row.title}
            </span>
            <span className="num shrink-0 text-xs text-ink-faint">
              <Outcome row={row} />
            </span>
          </li>
        ))}
      </ul>
      {!all && rows.length > SHOWN && (
        <div>
          <button
            type="button"
            onClick={() => setAll(true)}
            className="mt-1 rounded-sm text-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink hover:decoration-ink"
          >
            {t("productDocs.backlog.linked.showAll", { count: rows.length })}
          </button>
        </div>
      )}
    </section>
  );
}

/** A destra: le task nate («→ ACQ-21, ACQ-22», al più 2 e «+N»), o lo stato della richiesta. */
function Outcome({ row }: { row: ProductLinkedRequest }) {
  const { t } = useTranslation();
  if (row.taskCodes.length > 0) {
    const extra = row.taskCodes.length - SHOWN_TASKS;
    return (
      <>
        <span aria-hidden="true">→ </span>
        {row.taskCodes.slice(0, SHOWN_TASKS).map((code, i) => (
          <span key={code}>
            {i > 0 && ", "}
            <CodeLink code={code} quiet />
          </span>
        ))}
        {extra > 0 && <span> {t("productDocs.backlog.linked.moreTasks", { count: extra })}</span>}
      </>
    );
  }
  if (row.status === "converted") return <>{t("productDocs.backlog.linked.converted")}</>;
  if (row.status === "archived") return <>{t("productDocs.backlog.linked.archived")}</>;
  return <>{t("productDocs.backlog.linked.open")}</>;
}
