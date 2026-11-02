import { useTranslation } from "react-i18next";
import { WithWho } from "../../../components/InstanceBlock";

/**
 * Il riquadro di Claude col budget mensile esaurito (area 10a, shape
 * claude-panel.md §6, [CP 12]): la casella è sostituita da questa fascia —
 * niente invita a scrivere un messaggio che non può partire. La frase porta
 * il «Who?» di chi gestisce le impostazioni d'istanza; il testo già scritto
 * resta qui in sola lettura, e torna nella casella quando il budget c'è.
 */
export function BudgetBand({ text }: { text: string }) {
  const { t } = useTranslation();
  const written = text.trim();
  return (
    <div className="px-4 pt-2 pb-3">
      <div
        data-budget-band
        className="flex min-w-0 flex-col gap-2 rounded-lg bg-ink/5 px-3 py-2.5 text-sm text-ink-muted"
      >
        <p className="flex gap-2">
          <span aria-hidden="true" className="shrink-0 text-warning">
            ▲
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <WithWho text={t("claude.panel.budget")} />
          </span>
        </p>
        {written && (
          <p className="border-t border-rule pt-2 whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
            <span className="sr-only">{t("claude.panel.budgetDraft")} </span>
            {written}
          </p>
        )}
      </div>
    </div>
  );
}
