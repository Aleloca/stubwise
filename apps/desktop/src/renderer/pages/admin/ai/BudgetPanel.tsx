import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { now } from "../../../data/dates";
import {
  useBudget,
  useSaveBudget,
  useSimulateBudgetReached,
  type BudgetSaveEffect,
  type BudgetView,
  type ContentLanguage,
} from "../../../data/queries";
import { useToast } from "../../../tasks-ui/Toast";
import { PrototypeBox } from "../../automations/shared";
import { RadioRow, smallInput } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { ReadError, refusalOf, useFlash } from "../../preferences/parts";
import { Switch } from "../../preferences/SubscriptionRow";
import { primaryButton } from "../../tasks/controls";
import { AiSkeleton, AiWhoCan, ReadOnlyLine, useAiRefusalWords, usd } from "./parts";

// Budget & language (shape admin-ai.md «Budget & language»): il budget
// mensile col misuratore («$412 spent in October · 69% of $600»), le righe
// che dicono COSA si ferma quando finisce (sempre visibili, prima di
// salvare), la lingua dei contenuti. Un Save unico («Saved»), senza
// riconferma; il livello dati scrive voci separate per budget e lingua. Il
// riquadro «Prototype only» simula il budget raggiunto, senza voce.

const LANGUAGES: ContentLanguage[] = ["en", "it"];

export function BudgetPanel({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const budget = useBudget();
  return (
    <>
      {!canWrite && (
        <div className="mb-4">
          <ReadOnlyLine scope="settings" />
        </div>
      )}
      {budget.isPending ? (
        <AiSkeleton rows={2} height={56} />
      ) : budget.isError ? (
        <ReadError message={t("admin.ai.budget.loadError")} onRetry={() => void budget.refetch()} />
      ) : (
        <BudgetForm view={budget.data} canWrite={canWrite} />
      )}
    </>
  );
}

const amountText = (n: number | null) => (n === null ? "" : String(n));

function BudgetForm({ view, canWrite }: { view: BudgetView; canWrite: boolean }) {
  const { t, i18n } = useTranslation();
  const save = useSaveBudget();
  const toast = useToast();
  const refusalWords = useAiRefusalWords();
  const [amount, setAmount] = useState(amountText(view.monthlyUsd));
  const [language, setLanguage] = useState<ContentLanguage>(view.contentLanguage);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, flash] = useFlash();
  const titleId = useId();
  const amountId = useId();
  const languageId = useId();

  const today = new Date(now());
  const month = new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" }).format(today);
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  const restart = new Intl.DateTimeFormat(i18n.language, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(nextMonth);
  const spent = Math.round(view.spentUsd);

  async function submit() {
    setFormError(null);
    const text = amount.trim();
    const value = text ? Number(text) : null;
    if (value !== null && !(Number.isFinite(value) && value >= 0))
      return setAmountError(t("admin.ai.budget.amountError"));
    setAmountError(null);
    setBusy(true);
    const result = await save.mutateAsync({ monthlyUsd: value, contentLanguage: language }).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) {
      if (refusal.error === "invalid" && refusal.reason === "amount")
        return setAmountError(t("admin.ai.budget.amountError"));
      return setFormError(refusalWords(refusal.error));
    }
    flash();
    // Cosa ha cambiato il salvataggio per chi lavora: lo dice il livello dati.
    const { effect, simulated, spentUsd } = result as BudgetSaveEffect & { ok: true };
    const words = { spent: usd(Math.round(spentUsd)), budget: value === null ? "" : usd(value) };
    if (effect === "released") toast.show(t("admin.ai.budget.savedBack"));
    else if (effect === "now_reached")
      toast.show(
        simulated ? t("admin.ai.budget.simulatedReached") : t("admin.ai.budget.nowReached", words),
      );
    else if (effect === "still_reached")
      toast.show(
        simulated ? t("admin.ai.budget.simulatedReached") : t("admin.ai.budget.stillReached", words),
      );
  }

  return (
    <>
      <section>
        <h2 id={titleId} className="text-xl font-semibold text-ink">
          {t("admin.ai.budget.title")}
        </h2>
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="relative flex w-fit items-center">
            <span aria-hidden="true" className="pointer-events-none absolute left-2.5 text-md text-ink-muted">
              $
            </span>
            <input
              id={amountId}
              aria-labelledby={titleId}
              inputMode="decimal"
              value={amount}
              disabled={!canWrite}
              placeholder={t("admin.ai.budget.noBudget")}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? `${amountId}-error` : undefined}
              onChange={(e) => setAmount(e.target.value)}
              className={`${smallInput} num w-44 pl-6 disabled:cursor-not-allowed`}
            />
          </span>
          {amountError && <ErrorLine id={`${amountId}-error`}>{amountError}</ErrorLine>}
        </div>
        <Meter view={view} month={month} spent={spent} />
        <ul className="mt-4 flex max-w-[72ch] flex-col gap-1.5 text-sm text-pretty text-ink-muted">
          <li>{t("admin.ai.budget.counts", { date: restart })}</li>
          <li>{t("admin.ai.budget.waits")}</li>
          <li>{t("admin.ai.budget.askStops")}</li>
        </ul>
      </section>

      <section aria-labelledby={languageId} className="mt-8 border-t border-rule pt-5">
        <h2 id={languageId} className="text-xl font-semibold text-ink">
          {t("admin.ai.budget.language")}
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-pretty text-ink-muted">
          {t("admin.ai.budget.languageHint")}
        </p>
        <div role="radiogroup" aria-labelledby={languageId} className="mt-3 flex max-w-[420px] flex-col gap-2">
          {LANGUAGES.map((lang) => (
            <RadioRow
              key={lang}
              checked={language === lang}
              label={t(`admin.ai.budget.languages.${lang}`)}
              body=""
              disabled={!canWrite}
              onSelect={() => setLanguage(lang)}
            />
          ))}
        </div>
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canWrite || busy}
          onClick={() => void submit()}
          className={`${primaryButton} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {t("admin.ai.save")}
        </button>
        {!canWrite && <AiWhoCan scope="settings" />}
        <span role="status" className="text-sm text-ink-muted">
          {saved ? t("admin.ai.saved") : ""}
        </span>
      </div>
      {formError && (
        <div className="mt-2">
          <ErrorLine>{formError}</ErrorLine>
        </div>
      )}

      {canWrite && <SimulateBox simulated={view.simulated} />}
    </>
  );
}

/**
 * Il misuratore: barra di 6 px in inchiostro su filetto, e la frase. Al
 * 100% la barra è `critical` e la frase dice cosa succede: il colore non è
 * mai il solo segnale. Senza budget, niente barra.
 */
function Meter({ view, month, spent }: { view: BudgetView; month: string; spent: number }) {
  const { t } = useTranslation();
  const budget = view.monthlyUsd;
  const pct = budget ? Math.round((view.spentUsd / budget) * 100) : budget === 0 ? 100 : 0;
  return (
    <div className="mt-4 flex max-w-[480px] flex-col gap-2">
      {budget !== null && (
        <span aria-hidden="true" className="relative h-1.5 overflow-hidden rounded-full bg-rule">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${view.reached ? "bg-critical" : "bg-ink"}`}
            style={{ width: `${Math.min(100, view.reached ? 100 : pct)}%` }}
          />
        </span>
      )}
      <p className="num text-sm text-ink">
        {budget === null
          ? t("admin.ai.budget.spentNoBudget", { amount: usd(spent), month })
          : t("admin.ai.budget.spent", { amount: usd(spent), month, pct, budget: usd(budget) })}
      </p>
      {view.reached && (
        <p role="status" className="flex items-start gap-2 text-sm font-medium text-critical">
          <span aria-hidden="true" className="mt-[6px] size-2 shrink-0 rounded-full bg-critical" />
          <span>{t("admin.ai.budget.reached")}</span>
        </p>
      )}
    </div>
  );
}

/** «Prototype only»: il budget raggiunto, per vedere cosa vedono tutti. */
function SimulateBox({ simulated }: { simulated: boolean }) {
  const { t } = useTranslation();
  const simulate = useSimulateBudgetReached();
  // Subito al clic; poi lo riallinea la lettura.
  const [on, setOn] = useState(simulated);
  useEffect(() => setOn(simulated), [simulated]);
  const hintId = useId();
  return (
    <div className="mt-8">
      <PrototypeBox label={t("admin.ai.prototype.label")}>
        <span className="flex items-center gap-2.5 text-md text-ink">
          <Switch
            checked={on}
            label={t("admin.ai.budget.simulate")}
            describedBy={hintId}
            onChange={(next) => {
              setOn(next);
              simulate.mutate(next);
            }}
          />
          <span aria-hidden="true">{t("admin.ai.budget.simulate")}</span>
        </span>
        <p id={hintId} className="text-sm text-ink-muted">
          {t("admin.ai.budget.simulateHint")}
        </p>
      </PrototypeBox>
    </div>
  );
}
