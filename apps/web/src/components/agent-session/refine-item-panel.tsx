import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { backlogItemQueryOptions, backlogKeys } from "../../lib/queries";
import { BACKLOG_RISK_LABEL_KEYS, PRIORITY_LABEL_KEYS } from "../badges";
import { CollapsibleSection } from "../collapsible-section";
import { Markdown } from "../markdown";

/**
 * La voce di una sessione di refinement (design 2026-10-14 §6.1): titolo
 * (link alla voce), metadati, design e piano ATTUALI.
 *
 * Si rilegge quando l'agente SCRIVE, non a ogni dettaglio della sessione: lo
 * stream rimanda il dettaglio a ogni giro (`STREAM_POLL_MS`) anche quando non
 * è cambiato niente, mentre una scrittura dell'agente (`set_design`,
 * `set_plan`, `update_item`) è un tool_use/tool_result, quindi sposta
 * `lastEventAt`. `refreshKey` è quel valore: il primo giro dell'effetto si
 * salta (la query ha appena letto la voce, rileggerla sarebbe un doppio
 * fetch), ogni cambio dopo invalida la voce.
 *
 * Una voce che non si carica è una riga, mai la pagina: la sessione si guarda
 * e si scrive anche senza.
 */
export function RefineItemPanel({ itemId, refreshKey }: { itemId: string; refreshKey: string | null }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const item = useQuery(backlogItemQueryOptions(itemId));

  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(itemId) });
  }, [queryClient, itemId, refreshKey]);

  if (item.data === undefined) {
    return item.isError ? (
      <p className="font-mono text-[12px] text-fg-faint">{t("refineItem.loadError")}</p>
    ) : null;
  }
  const data = item.data;
  const none = t("refineItem.none");
  // Il web fa un cast, non un parse: un valore che questo bundle non conosce
  // non ha un'etichetta, e si mostra com'è invece di una chiave grezza.
  const risk = data.risk !== null ? t(BACKLOG_RISK_LABEL_KEYS[data.risk] ?? data.risk) : none;
  const urgency = data.urgency !== null ? t(PRIORITY_LABEL_KEYS[data.urgency] ?? data.urgency) : none;
  const plan = data.implementationPlan ?? null;

  return (
    <section aria-label={t("refineItem.label")} className="rounded-sm border border-line p-4">
      <p className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">{t("refineItem.label")}</p>
      <Link to="/backlog/$id" params={{ id: itemId }} className="mt-1 block font-medium text-fg hover:underline">
        {data.title}
      </Link>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-fg-muted">
        <div className="flex gap-1">
          <dt>{t("refineItem.effort")}:</dt>
          <dd className="text-fg">
            {data.effort !== null ? t("refineItem.effortValue", { value: data.effort }) : none}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>{t("refineItem.risk")}:</dt>
          <dd className="text-fg">
            {risk}
            {data.riskNote !== null && data.riskNote.trim() !== "" && (
              <span className="text-fg-muted"> — {data.riskNote}</span>
            )}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>{t("refineItem.urgency")}:</dt>
          <dd className="text-fg">{urgency}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-col gap-2">
        <CollapsibleSection title={t("refineItem.design")} defaultOpen>
          {data.document.trim() === "" ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("refineItem.noDesign")}</p>
          ) : (
            <Markdown source={data.document} />
          )}
        </CollapsibleSection>
        <CollapsibleSection title={t("refineItem.plan")} defaultOpen>
          {plan === null || plan.trim() === "" ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("refineItem.noPlan")}</p>
          ) : (
            <Markdown source={plan} />
          )}
        </CollapsibleSection>
      </div>
    </section>
  );
}
