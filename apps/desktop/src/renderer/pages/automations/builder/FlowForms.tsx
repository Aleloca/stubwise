import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AUTOMATION_LIMITS, availableFields, scopeAt } from "../../../domain/automations/fields";
import { ConditionEditor } from "./ConditionEditor";
import { useBuilder } from "./context";
import { Field, Note, Section, Segmented, selectClass, smallInput } from "./controls";
import { tokenLabel } from "./DataText";
import { useFieldProblem, type KindProps } from "./stepFields";

// I moduli dei passi che guidano il flusso (shape builder §6): attesa,
// condizione, «Per ogni», «Ripeti finché».

export function WaitForm({ step, path, set, problems }: KindProps<"wait">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const w = step.for;
  const mode = "days" in w ? "days" : "replyTo" in w ? "reply" : "task";
  const before = scopeAt(b.flow, path, b.sources).preceding;
  const emails = before.filter((s) => s.kind === "sendEmail");
  const tasks = before.filter((s) => s.kind === "createTask");
  const ref = useFieldProblem(problems, mode === "reply" ? "replyTo" : "taskClosed");
  const days = useFieldProblem(problems, mode === "days" ? "days" : "maxDays");
  const refId = "replyTo" in w ? w.replyTo : "taskClosed" in w ? w.taskClosed : "";
  const options = mode === "reply" ? emails : tasks;
  const num = (id: string) => b.numbers.get(b.paths.get(id) ?? "");
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Segmented
        label={t("automations.builder.panel.waitFor")}
        value={mode}
        options={[
          { value: "days", label: t("automations.builder.panel.someTime") },
          { value: "reply", label: t("automations.builder.panel.aReply") },
          { value: "task", label: t("automations.builder.panel.aTask") },
        ]}
        onChange={(m) =>
          set({
            for:
              m === "days"
                ? { days: 3 }
                : m === "reply"
                  ? { replyTo: emails.at(-1)?.id ?? "", maxDays: 5 }
                  : { taskClosed: tasks.at(-1)?.id ?? "", maxDays: 5 },
          })
        }
      />
      {mode !== "days" && (
        <Field
          label={
            mode === "reply"
              ? t("automations.builder.panel.replyTo")
              : t("automations.builder.panel.taskToClose")
          }
          required
        >
          <select
            aria-label={
              mode === "reply"
                ? t("automations.builder.panel.replyTo")
                : t("automations.builder.panel.taskToClose")
            }
            aria-describedby={ref.describedBy}
            aria-invalid={ref.invalid || undefined}
            className={selectClass}
            value={refId}
            onChange={(e) =>
              set({
                for:
                  mode === "reply"
                    ? { replyTo: e.target.value, maxDays: (w as { maxDays: number }).maxDays }
                    : { taskClosed: e.target.value, maxDays: (w as { maxDays: number }).maxDays },
              })
            }
          >
            <option value="" disabled>
              {t("automations.builder.panel.chooseStep")}
            </option>
            {refId && !options.some((s) => s.id === refId) && (
              <option value={refId}>
                {t("automations.builder.panel.stepNotBefore", { n: num(refId) ?? "" })}
              </option>
            )}
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {mode === "reply"
                  ? t("automations.builder.panel.emailFrom", { n: num(s.id) })
                  : t("automations.builder.panel.taskFrom", { n: num(s.id) })}
              </option>
            ))}
          </select>
          {options.length === 0 && (
            <Note>
              {mode === "reply"
                ? t("automations.builder.panel.noEmailBefore")
                : t("automations.builder.panel.noTaskBefore")}
            </Note>
          )}
          {ref.error}
        </Field>
      )}
      <Field
        label={
          mode === "days"
            ? t("automations.builder.panel.howLong")
            : t("automations.builder.panel.stopAfter")
        }
        required
      >
        <span className="flex items-center gap-1.5 text-sm text-ink-muted">
          <input
            type="number"
            min={1}
            aria-label={
              mode === "days"
                ? t("automations.builder.panel.howLong")
                : t("automations.builder.panel.stopAfter")
            }
            aria-describedby={days.describedBy}
            aria-invalid={days.invalid || undefined}
            className={`${smallInput} w-16`}
            value={"days" in w ? w.days : w.maxDays}
            onChange={(e) => {
              const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
              set({ for: "days" in w ? { days: v } : { ...w, maxDays: v } });
            }}
          />
          {t("automations.builder.panel.daysWord", { count: "days" in w ? w.days : w.maxDays })}
        </span>
        {days.error}
      </Field>
      {mode === "reply" && <Note>{t("automations.builder.panel.replyData")}</Note>}
    </Section>
  );
}

export function ConditionForm({ step, path, set, problems }: KindProps<"condition">) {
  const { t } = useTranslation();
  const p = useFieldProblem(problems, "condition");
  return (
    <Section title={t("automations.builder.panel.when")}>
      <ConditionEditor
        value={step.when}
        onChange={(when) => set({ when })}
        path={path}
        label={t("automations.builder.panel.when")}
        describedBy={p.describedBy}
      />
      {p.error}
      <Note>{t("automations.builder.panel.conditionNote")}</Note>
    </Section>
  );
}

export function ForEachForm({ step, path, set, problems }: KindProps<"forEach">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const listP = useFieldProblem(problems, "list");
  const asP = useFieldProblem(problems, "as");
  const lists = availableFields(b.flow, path, b.sources).filter((f) => f.type === "list");
  const asId = useId();
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Field label={t("automations.builder.panel.list")} required>
        <select
          aria-label={t("automations.builder.panel.list")}
          aria-describedby={listP.describedBy}
          aria-invalid={listP.invalid || undefined}
          className={selectClass}
          value={step.list}
          onChange={(e) => {
            const f = lists.find((x) => x.key === e.target.value);
            set({ list: e.target.value, as: step.as || singular(f?.label ?? "") });
          }}
        >
          <option value="" disabled>
            {t("automations.builder.panel.chooseList")}
          </option>
          {step.list && !lists.some((l) => l.key === step.list) && (
            <option value={step.list}>{tokenLabel(b.flow, step.list, b.labels)}</option>
          )}
          {lists.map((l) => (
            <option key={l.key} value={l.key}>
              {tokenLabel(b.flow, l.key, b.labels)}
            </option>
          ))}
        </select>
        {lists.length === 0 && <Note>{t("automations.builder.panel.noLists")}</Note>}
        {listP.error}
      </Field>
      <Field label={t("automations.builder.panel.callEach")} required htmlFor={asId}>
        <input
          id={asId}
          className={`${smallInput} w-48`}
          aria-describedby={asP.describedBy}
          aria-invalid={asP.invalid || undefined}
          value={step.as}
          onChange={(e) => set({ as: e.target.value.replace(/[./]/g, "") })}
        />
        {asP.error}
      </Field>
      <Note>
        {t("automations.builder.panel.forEachNote", { count: AUTOMATION_LIMITS.forEachRounds })}
      </Note>
    </Section>
  );
}

/** Il nome dell'elemento precompilato dall'etichetta dell'elenco («Task di attivazione» → «task»). */
export function singular(label: string): string {
  const first = label.trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/[./]/g, "").replace(/s$/, "");
}

export function RepeatForm({ step, path, set, problems }: KindProps<"repeatUntil">) {
  const { t } = useTranslation();
  const until = useFieldProblem(problems, "until");
  const max = useFieldProblem(problems, "max");
  const id = useId();
  return (
    <Section title={t("automations.builder.panel.what")}>
      <Field label={t("automations.builder.panel.until")} required>
        <ConditionEditor
          value={step.until}
          onChange={(u) => set({ until: u })}
          path={path}
          label={t("automations.builder.panel.until")}
          describedBy={until.describedBy}
        />
        {until.error}
      </Field>
      <Field label={t("automations.builder.panel.atMost")} required htmlFor={id}>
        <span className="flex items-center gap-1.5 text-sm text-ink-muted">
          <input
            id={id}
            type="number"
            min={1}
            max={AUTOMATION_LIMITS.repeatMax}
            aria-describedby={max.describedBy}
            aria-invalid={max.invalid || undefined}
            className={`${smallInput} w-16`}
            value={step.max}
            onChange={(e) => set({ max: Math.floor(Number(e.target.value) || 0) })}
          />
          {t("automations.builder.panel.timesWord", { count: step.max })}
        </span>
        {max.error}
      </Field>
      <Note>{t("automations.builder.panel.repeatNote")}</Note>
    </Section>
  );
}
