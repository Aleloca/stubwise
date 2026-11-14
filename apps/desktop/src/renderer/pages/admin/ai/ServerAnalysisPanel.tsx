import type { ServerAnalysisLimits } from "@stubwise/shared";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSaveServerAnalysisSettings, useServerAnalysisSettings } from "../../../data/queries";
import { smallInput } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { ReadError, refusalOf, useFlash } from "../../preferences/parts";
import { Switch } from "../../preferences/SubscriptionRow";
import { primaryButton } from "../../tasks/controls";
import { AiSkeleton, useAiRefusalWords } from "./parts";

// I tetti dell'analisi dei server (area 8, F4b, R0-C, R6), nella scheda
// Budget di Amministrazione → AI: l'interruttore (spenta, gli avvisi
// arrivano ma Claude non ci guarda) e quattro numeri. Forma, limiti e
// default sono di `@stubwise/shared`; il livello dati li riverifica. Solo
// con `settings.manage` (la rotta del server lo chiede anche per leggere).

type NumberField = Exclude<keyof ServerAnalysisLimits, "enabled">;
const FIELDS: NumberField[] = ["maxMinutes", "maxCostUsd", "maxSshReads", "maxAgentReads"];

export function ServerAnalysisPanel() {
  const { t } = useTranslation();
  const settings = useServerAnalysisSettings();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="mt-8 border-t border-rule pt-5">
      <h2 id={titleId} className="text-xl font-semibold text-ink">
        {t("admin.ai.serverAnalysis.title")}
      </h2>
      <p className="mt-1 max-w-[62ch] text-sm text-pretty text-ink-muted">
        {t("admin.ai.serverAnalysis.intro")}
      </p>
      {settings.isPending ? (
        <AiSkeleton rows={2} height={40} />
      ) : settings.isError ? (
        <ReadError
          message={t("admin.ai.budget.loadError")}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <LimitsForm value={settings.data} />
      )}
    </section>
  );
}

function LimitsForm({ value }: { value: ServerAnalysisLimits }) {
  const { t } = useTranslation();
  const save = useSaveServerAnalysisSettings();
  const refusalWords = useAiRefusalWords();
  const [enabled, setEnabled] = useState(value.enabled);
  const [draft, setDraft] = useState<Record<NumberField, string>>(() => ({
    maxMinutes: String(value.maxMinutes),
    maxCostUsd: String(value.maxCostUsd),
    maxSshReads: String(value.maxSshReads),
    maxAgentReads: String(value.maxAgentReads),
  }));
  const [fieldError, setFieldError] = useState<NumberField | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, flash] = useFlash();
  const baseId = useId();

  async function submit() {
    setFieldError(null);
    setFormError(null);
    const numbers = Object.fromEntries(FIELDS.map((f) => [f, Number(draft[f])])) as Record<
      NumberField,
      number
    >;
    const result = await save.mutateAsync({ enabled, ...numbers }).catch(() => null);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) {
      if (
        refusal.error === "invalid" &&
        "reason" in refusal &&
        FIELDS.includes(refusal.reason as NumberField)
      )
        return setFieldError(refusal.reason as NumberField);
      return setFormError(refusalWords(refusal.error));
    }
    flash();
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Switch
          checked={enabled}
          label={t("admin.ai.serverAnalysis.enabled")}
          onChange={setEnabled}
        />
        {!enabled && (
          <p className="max-w-[62ch] text-sm text-pretty text-ink-muted">
            {t("admin.ai.serverAnalysis.off")}
          </p>
        )}
      </div>
      <div className="grid max-w-[520px] grid-cols-2 gap-x-6 gap-y-3">
        {FIELDS.map((f) => {
          const id = `${baseId}-${f}`;
          return (
            <div key={f} className="flex flex-col gap-1">
              <label htmlFor={id} className="text-sm font-medium text-ink">
                {t(`admin.ai.serverAnalysis.${f}`)}
              </label>
              <input
                id={id}
                type="number"
                inputMode="decimal"
                step={f === "maxCostUsd" ? 0.1 : 1}
                value={draft[f]}
                disabled={!enabled}
                aria-invalid={fieldError === f ? true : undefined}
                aria-describedby={fieldError === f ? `${id}-error` : undefined}
                onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                className={`${smallInput} num w-32 disabled:cursor-not-allowed`}
              />
              {fieldError === f && (
                <ErrorLine id={`${id}-error`}>{t(`admin.ai.serverAnalysis.errors.${f}`)}</ErrorLine>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => void submit()}
          className={`${primaryButton} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {t("admin.ai.serverAnalysis.save")}
        </button>
        <span role="status" className="text-sm text-ink-muted">
          {saved ? t("admin.ai.saved") : ""}
        </span>
      </div>
      {formError && <ErrorLine>{formError}</ErrorLine>}
    </div>
  );
}
