import { useId } from "react";
import { useTranslation } from "react-i18next";
import { primaryButton } from "../../tasks/controls";

// La conferma del costo della prova (area 7, F3, D4 e F3-3 = a): la prova si
// ferma al primo passo di Claude e dice quante volte gli chiederà e quanto
// costa, stimato, sul budget mensile dell'istanza. Una conferma vale per
// tutta la prova. Nel prototipo Claude è finto e non costa: non compare.

export function CostConfirm({
  cost,
  busy,
  onConfirm,
}: {
  /** `estimateUsd: null`: un modello senza tariffa nota, il costo non si stima. */
  cost: { claudeSteps: number; estimateUsd: number | null; model: string };
  busy: boolean;
  onConfirm: () => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const usd =
    cost.estimateUsd === null
      ? null
      : new Intl.NumberFormat(i18n.language, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: cost.estimateUsd < 0.01 ? 4 : 2,
        }).format(cost.estimateUsd);
  return (
    <section
      aria-labelledby={titleId}
      data-test-cost
      className="flex flex-col gap-2 rounded-md border border-rule bg-surface px-4 py-3"
    >
      <h2 id={titleId} className="text-md font-semibold text-ink">
        {t("automations.test.cost.title")}
      </h2>
      <p className="text-sm text-ink-muted">
        {usd === null
          ? t("automations.test.cost.bodyUnknown", { count: cost.claudeSteps })
          : t("automations.test.cost.body", { count: cost.claudeSteps, usd })}
      </p>
      <button
        type="button"
        data-stop-primary
        className={`${primaryButton} self-start disabled:opacity-40`}
        disabled={busy}
        onClick={onConfirm}
      >
        {t("automations.test.cost.confirm")}
      </button>
    </section>
  );
}
