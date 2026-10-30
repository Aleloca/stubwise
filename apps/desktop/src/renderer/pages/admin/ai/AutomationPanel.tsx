import { useBlocker } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAiAutomation,
  useSaveAiAutomation,
  type AutomationRule,
  type AutomationSettings,
} from "../../../data/queries";
import { ErrorLine } from "../../entry/parts";
import { ReadError, refusalOf, useFlash } from "../../preferences/parts";
import { Switch } from "../../preferences/SubscriptionRow";
import { InlineConfirm } from "../../task/parts";
import { primaryButton, quietButton } from "../../tasks/controls";
import { selectClass, smallInput } from "../../automations/builder/controls";
import { SaveBar } from "../parts";
import { AiSkeleton, AiWhoCan, ReadOnlyLine, useAiRefusalWords } from "./parts";

// Automation (shape admin-ai.md «Automation»): per tipo di task se Claude
// parte da solo e fin dove, più la revisione delle PR. Nel prototipo si
// salvano e basta, e la scheda lo dice una volta [AI 6]. Le modifiche sono
// una bozza con la barra di salvataggio in fondo («3 changes · Discard ·
// Save»), senza riconferma; lasciare la scheda con modifiche chiede prima.
// Gli importi sono testo finché non si salva: l'errore sta sotto il campo.

type Effort = AutomationRule["maxEffort"];
const EFFORTS: Effort[] = [1, 2, 3, 4, 5];

interface RuleDraft {
  taskType: AutomationRule["taskType"];
  autoFix: boolean;
  maxEffort: Effort;
  planApprovalMinEffort: Effort | null;
  cost: string;
}
interface Draft {
  rules: RuleDraft[];
  review: { enabled: boolean; cost: string };
}

const costText = (n: number | null): string => (n === null ? "" : String(n));

function draftOf(a: AutomationSettings): Draft {
  return {
    rules: a.rules.map((r) => ({
      taskType: r.taskType,
      autoFix: r.autoFix,
      maxEffort: r.maxEffort,
      planApprovalMinEffort: r.planApprovalMinEffort,
      cost: costText(r.maxCostUsd),
    })),
    review: { enabled: a.prReview.enabled, cost: costText(a.prReview.maxCostUsd) },
  };
}

/** Quanti campi sono cambiati rispetto al salvato. */
function changesOf(draft: Draft, saved: Draft): number {
  let n = 0;
  draft.rules.forEach((r, i) => {
    const s = saved.rules[i]!;
    if (r.autoFix !== s.autoFix) n++;
    if (r.maxEffort !== s.maxEffort) n++;
    if (r.planApprovalMinEffort !== s.planApprovalMinEffort) n++;
    if (r.cost.trim() !== s.cost) n++;
  });
  if (draft.review.enabled !== saved.review.enabled) n++;
  if (draft.review.cost.trim() !== saved.review.cost) n++;
  return n;
}

/** Un importo scritto: vuoto = nessun tetto, un numero da 0 in su, altrimenti `undefined`. */
function parseCost(text: string): number | null | undefined {
  const v = text.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function AutomationPanel({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const automation = useAiAutomation();

  return (
    <>
      <p className="max-w-[62ch] text-md text-pretty text-ink">{t("admin.ai.automation.intro")}</p>
      <p className="mt-1 text-xs text-ink-faint">{t("admin.ai.automation.prototypeNote")}</p>
      {!canWrite && (
        <div className="mt-3">
          <ReadOnlyLine scope="settings" />
        </div>
      )}
      {automation.isPending ? (
        <AiSkeleton rows={3} height={52} />
      ) : automation.isError ? (
        <ReadError
          message={t("admin.ai.automation.loadError")}
          onRetry={() => void automation.refetch()}
        />
      ) : (
        <AutomationForm saved={automation.data} canWrite={canWrite} />
      )}
    </>
  );
}

function AutomationForm({ saved, canWrite }: { saved: AutomationSettings; canWrite: boolean }) {
  const { t } = useTranslation();
  const save = useSaveAiAutomation();
  const refusalWords = useAiRefusalWords();
  const [edits, setEdits] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, flash] = useFlash();
  const base = draftOf(saved);
  const draft = edits ?? base;
  const changes = changesOf(draft, base);
  const reviewId = useId();

  const dirtyRef = useRef(changes > 0);
  dirtyRef.current = changes > 0;
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current,
    enableBeforeUnload: false,
    withResolver: true,
  });

  const patchRule = (type: string, change: Partial<RuleDraft>) =>
    setEdits({
      ...draft,
      rules: draft.rules.map((r) => (r.taskType === type ? { ...r, ...change } : r)),
    });
  const patchReview = (change: Partial<Draft["review"]>) =>
    setEdits({ ...draft, review: { ...draft.review, ...change } });

  function discard() {
    setEdits(null);
    setErrors({});
    setFormError(null);
  }

  async function submit() {
    const found: Record<string, string> = {};
    const message = t("admin.ai.automation.costError");
    const rules: AutomationRule[] = draft.rules.map((r) => {
      const cost = parseCost(r.cost);
      if (cost === undefined) found[r.taskType] = message;
      return {
        taskType: r.taskType,
        autoFix: r.autoFix,
        maxEffort: r.maxEffort,
        planApprovalMinEffort: r.planApprovalMinEffort,
        maxCostUsd: cost ?? null,
      };
    });
    const reviewCost = parseCost(draft.review.cost);
    if (reviewCost === undefined) found.review = message;
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    const result = await save
      .mutateAsync({ rules, prReview: { enabled: draft.review.enabled, maxCostUsd: reviewCost ?? null } })
      .catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setFormError(refusalWords(refusal.error));
    dirtyRef.current = false;
    setEdits(null);
    flash();
  }

  return (
    <>
      <section className="@container mt-6">
        {/* Le intestazioni, larghe: le etichette vere stanno sui controlli. */}
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(0,1fr)_88px_120px_168px_140px] items-end gap-4 pb-1.5 text-xs text-ink-muted @min-[720px]:grid"
        >
          <span>{t("admin.ai.automation.columns.type")}</span>
          <span>{t("admin.ai.automation.columns.autoFix")}</span>
          <span>{t("admin.ai.automation.columns.maxEffort")}</span>
          <span>{t("admin.ai.automation.columns.planApproval")}</span>
          <span>{t("admin.ai.automation.columns.maxCost")}</span>
        </div>
        <ul className="border-t border-rule">
          {draft.rules.map((rule) => (
            <RuleLine
              key={rule.taskType}
              rule={rule}
              canWrite={canWrite}
              error={errors[rule.taskType]}
              onChange={(change) => patchRule(rule.taskType, change)}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby={reviewId} className="mt-8 border-t border-rule pt-5">
        <h2 id={reviewId} className="text-xl font-semibold text-ink">
          {t("admin.ai.automation.prReview.title")}
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-pretty text-ink-muted">
          {t("admin.ai.automation.prReview.body")}
        </p>
        <div className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-3">
          <span className="flex h-8 items-center gap-2.5 text-md text-ink">
            <Switch
              checked={draft.review.enabled}
              label={t("admin.ai.automation.prReview.switch")}
              disabledReason={canWrite ? undefined : t("admin.ai.readOnly.settings")}
              onChange={(enabled) => patchReview({ enabled })}
            />
            <span aria-hidden="true">{t("admin.ai.automation.prReview.switch")}</span>
          </span>
          <CostField
            label={t("admin.ai.automation.prReview.maxCost")}
            visibleLabel
            value={draft.review.cost}
            disabled={!canWrite}
            error={errors.review}
            onChange={(cost) => patchReview({ cost })}
          />
        </div>
      </section>

      {canWrite && (changes > 0 || justSaved) && (
        <div className="-ml-8 mt-8">
          <SaveBar width={880}>
            {changes === 0 ? (
              <p role="status" className="text-sm text-ink">
                {t("admin.ai.saved")}
              </p>
            ) : blocker.status === "blocked" ? (
              <InlineConfirm
                message={t("admin.ai.automation.leave", { count: changes })}
                confirm={t("admin.ai.automation.discard")}
                cancelLabel={t("admin.ai.automation.keep")}
                onConfirm={() => blocker.proceed?.()}
                onCancel={() => blocker.reset?.()}
              />
            ) : (
              <>
                {formError && <ErrorLine>{formError}</ErrorLine>}
                <div className="flex flex-wrap items-center gap-3">
                  <p className="num min-w-0 flex-1 text-sm text-ink">
                    {t("admin.ai.automation.changes", { count: changes })}
                  </p>
                  <button type="button" className={quietButton} onClick={discard}>
                    {t("admin.ai.automation.discard")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`${primaryButton} disabled:opacity-40`}
                    onClick={() => void submit()}
                  >
                    {t("admin.ai.save")}
                  </button>
                </div>
              </>
            )}
          </SaveBar>
        </div>
      )}
      {!canWrite && (
        <p className="mt-6 flex items-center gap-2 text-sm text-ink-muted">
          <button type="button" disabled className={`${primaryButton} disabled:opacity-40`}>
            {t("admin.ai.save")}
          </button>
          <AiWhoCan scope="settings" />
        </p>
      )}
    </>
  );
}

/**
 * Un tipo di task. Largo: una riga di tabella a cinque colonne. Stretto
 * (1024): un blocco a due righe, «Bug · Auto-fix» sopra e i tre controlli
 * sotto con l'etichetta accanto.
 */
function RuleLine({
  rule,
  canWrite,
  error,
  onChange,
}: {
  rule: RuleDraft;
  canWrite: boolean;
  error?: string;
  onChange: (change: Partial<RuleDraft>) => void;
}) {
  const { t } = useTranslation();
  const typeId = useId();
  const effortId = useId();
  const approvalId = useId();
  const type = t(`admin.ai.automation.types.${rule.taskType}`);
  const label = "text-xs text-ink-muted @min-[720px]:sr-only";
  return (
    <li
      role="group"
      aria-labelledby={typeId}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 border-b border-rule py-2.5 last:border-b-0 @min-[720px]:grid-cols-[minmax(0,1fr)_88px_120px_168px_140px] @min-[720px]:items-center"
    >
      <span id={typeId} className="flex h-8 items-center text-md font-medium text-ink">
        {type}
      </span>
      <span className="flex h-8 items-center gap-2">
        <span aria-hidden="true" className="text-sm text-ink-muted @min-[720px]:hidden">
          {t("admin.ai.automation.columns.autoFix")}
        </span>
        <Switch
          checked={rule.autoFix}
          label={t("admin.ai.automation.autoFixFor", { type })}
          disabledReason={canWrite ? undefined : t("admin.ai.readOnly.settings")}
          onChange={(autoFix) => onChange({ autoFix })}
        />
      </span>
      <span className="col-span-2 flex flex-wrap items-start gap-x-6 gap-y-2 @min-[720px]:contents">
        <span className="flex flex-col gap-1">
          <label htmlFor={effortId} className={label}>
            {t("admin.ai.automation.columns.maxEffort")}
          </label>
          <select
            id={effortId}
            value={rule.maxEffort}
            disabled={!canWrite}
            onChange={(e) => onChange({ maxEffort: Number(e.target.value) as Effort })}
            className={`${selectClass} w-[120px] disabled:cursor-not-allowed`}
          >
            {EFFORTS.map((n) => (
              <option key={n} value={n}>
                {t("admin.ai.automation.effortOf", { n })}
              </option>
            ))}
          </select>
        </span>
        <span className="flex flex-col gap-1">
          <label htmlFor={approvalId} className={label}>
            {t("admin.ai.automation.columns.planApproval")}
          </label>
          <select
            id={approvalId}
            value={rule.planApprovalMinEffort ?? ""}
            disabled={!canWrite}
            onChange={(e) =>
              onChange({
                planApprovalMinEffort: e.target.value ? (Number(e.target.value) as Effort) : null,
              })
            }
            className={`${selectClass} w-[168px] disabled:cursor-not-allowed`}
          >
            <option value="">{t("admin.ai.automation.never")}</option>
            {EFFORTS.map((n) => (
              <option key={n} value={n}>
                {t("admin.ai.automation.effortOf", { n })}
              </option>
            ))}
          </select>
          {!rule.autoFix && (
            <span className="max-w-[168px] text-xs text-ink-muted">
              {t("admin.ai.automation.handOnly")}
            </span>
          )}
        </span>
        <CostField
          label={t("admin.ai.automation.columns.maxCost")}
          value={rule.cost}
          disabled={!canWrite}
          error={error}
          onChange={(cost) => onChange({ cost })}
        />
      </span>
    </li>
  );
}

/** Un importo in dollari: vuoto = «No cap». L'errore sotto il campo. */
function CostField({
  label,
  visibleLabel = false,
  value,
  disabled,
  error,
  onChange,
}: {
  label: string;
  /** Sempre visibile (la revisione delle PR); nella tabella solo da stretta. */
  visibleLabel?: boolean;
  value: string;
  disabled: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <span className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className={visibleLabel ? "text-xs text-ink-muted" : "text-xs text-ink-muted @min-[720px]:sr-only"}
      >
        {label}
      </label>
      <span className="relative flex items-center">
        <span aria-hidden="true" className="pointer-events-none absolute left-2.5 text-md text-ink-muted">
          $
        </span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          placeholder={t("admin.ai.automation.noCap")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${smallInput} num w-[140px] pl-6 disabled:cursor-not-allowed`}
        />
      </span>
      {error && (
        <span className="max-w-[260px]">
          <ErrorLine id={errorId}>{error}</ErrorLine>
        </span>
      )}
    </span>
  );
}
