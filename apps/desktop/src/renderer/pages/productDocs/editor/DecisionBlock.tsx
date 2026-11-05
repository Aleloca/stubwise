import { useTranslation } from "react-i18next";
import type { ProductBlock, ProductPageView } from "../../../data/types";
import { formatDate } from "../../../notifications/time";
import { selectOnMouseDown } from "./ImageBlock";

// Una decisione del registro citata in una pagina (shape product-editor.md
// §3.8, [PE 11]): riga di 52 px, bordo 1 px `rule`, raggio 8 — in alto
// «Decision · from the register», sotto il titolo e «decided by Laura Costa
// · Oct 21», a destra «Open in the register». Il blocco CITA il registro:
// non si modifica da qui. Ciò che dice lo legge da `page.decisions`, risolto
// per chi guarda dal livello dati: `null` = una decisione che non vede, e
// allora nessun titolo, data o nome entra nel DOM (R-G5); assente = la
// lettura della pagina non l'ha ancora risolta (appena scelta).

type Decision = Extract<ProductBlock, { type: "decision" }>;

const rowClass = "flex min-h-[52px] min-w-0 items-center gap-3 rounded-lg border border-rule px-3 py-2";

export function DecisionBlock({
  block,
  decisions,
  projectCode,
  onSelect,
}: {
  block: Decision;
  decisions: ProductPageView["decisions"];
  projectCode: string;
  onSelect?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const entry = decisions[block.decisionId];

  if (entry === undefined) {
    return (
      <div aria-busy="true" onMouseDown={selectOnMouseDown(onSelect)} className={`${rowClass} skeleton-breathe`}>
        <span className="sr-only" role="status">
          {t("productDocs.blocks.decision.loading")}
        </span>
        <span aria-hidden="true" className="h-2.5 w-56 rounded-sm bg-ink/8" />
      </div>
    );
  }
  if (entry === null) {
    return (
      <div onMouseDown={selectOnMouseDown(onSelect)} className={rowClass}>
        <span className="text-md text-ink-muted">{t("productDocs.blocks.decision.hidden")}</span>
      </div>
    );
  }
  const date = formatDate(entry.decidedAt, i18n.language);
  return (
    <div onMouseDown={selectOnMouseDown(onSelect)} className={rowClass}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-ink-muted">{t("productDocs.blocks.decision.label")}</span>
        <span className="text-md font-semibold text-pretty text-ink">{entry.title}</span>
        <span className="num text-xs text-ink-muted">
          {entry.decidedByName
            ? t("productDocs.blocks.decision.decidedBy", { name: entry.decidedByName, date })
            : t("productDocs.blocks.decision.decidedOn", { date })}
        </span>
      </div>
      <a
        href={`#/p/${entry.projectCode ?? projectCode}/overview?decision=${encodeURIComponent(block.decisionId)}`}
        className="shrink-0 rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink"
      >
        {t("productDocs.blocks.decision.open")}
      </a>
    </div>
  );
}
