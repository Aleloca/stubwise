import { useState } from "react";
import { useTranslation } from "react-i18next";
import { availableFields } from "../../../domain/automations/fields";
import type { DataField, Step } from "../../../data/types";
import { Dialog } from "../../../tasks-ui/Dialog";
import { dangerSolidButton, secondaryButton } from "../../tasks/controls";
import { useBuilder } from "./context";
import { DataText, FieldError, tokenLabel } from "./DataText";
import { Note, Section, selectClass, smallInput } from "./controls";
import { innerCount, laneDepth, MAX_DEPTH, placeOf } from "./tree";
import type { FieldProblem } from "./issues";
import { useFieldProblem } from "./stepFields";

// Il passo di Claude (shape builder §6, regola 2 dell'anti-obiettivo): la
// riga fissa che dice che Claude sceglie solo fra le uscite disegnate e
// compila solo i campi dichiarati; l'istruzione; cosa può leggere; le uscite
// (0–6, ognuna una corsia, rinominabili sul posto); i campi (nome e tipo,
// «List of…» con al massimo 6 sottocampi, [A 17]). Nessuna approvazione: il
// passo non produce effetti. Nessun campo «cosa fare dopo».

type Claude = Extract<Step, { kind: "claude" }>;
const MAX = 6;
const FIELD_TYPES: DataField["type"][] = ["text", "number", "date", "email", "boolean", "list"];
const SUB_TYPES: DataField["type"][] = ["text", "number", "date", "email", "boolean"];

export function ClaudeForm({
  step,
  path,
  set,
  problems,
}: {
  step: Claude;
  path: string;
  set: (next: Partial<Step>) => void;
  problems: FieldProblem[];
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const [removing, setRemoving] = useState<string | null>(null);
  const instruction = useFieldProblem(problems, "instruction");
  const answer = useFieldProblem(problems, "answer");
  const outcomesP = useFieldProblem(problems, "outcomes");
  const readable = availableFields(b.flow, path, b.sources);
  const inputs = [...new Set([...readable.map((f) => f.key), ...step.inputs])];

  // Il nome che si sta scrivendo, per indice: diventa il nome dell'uscita (e
  // del suo ramo) solo quando è valido. Mai due rami con lo stesso nome, mai
  // un ramo senza nome: finché non va, l'uscita tiene il suo e il campo lo dice.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const depth = laneDepth(placeOf(path).lane);
  const clearDraft = (i: number) =>
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => Number(k) !== i)));
  const outcomeProblem = (i: number, name: string): string | null => {
    if (name.trim() === "") return t("automations.builder.claude.outcomeEmpty");
    if (/^\d+$/.test(name.trim())) return t("automations.builder.claude.outcomeDigits");
    if (step.outcomes.some((o, k) => k !== i && o === name))
      return t("automations.builder.claude.outcomeTaken");
    return null;
  };
  const typeOutcome = (i: number, name: string) => {
    if (outcomeProblem(i, name) === null) {
      renameOutcome(i, name);
      clearDraft(i);
    } else setDrafts((d) => ({ ...d, [i]: name }));
  };
  const renameOutcome = (i: number, name: string) => {
    const old = step.outcomes[i]!;
    const outcomes = step.outcomes.map((o, k) => (k === i ? name : o));
    const branches: Record<string, Step[]> = {};
    for (const [k, v] of Object.entries(step.branches)) branches[k === old ? name : k] = v;
    set({ outcomes, branches } as Partial<Step>);
  };
  const removeOutcome = (name: string) => {
    const branches = { ...step.branches };
    delete branches[name];
    set({ outcomes: step.outcomes.filter((o) => o !== name), branches } as Partial<Step>);
  };
  const nextOutcome = () => {
    let n = step.outcomes.length + 1;
    while (step.outcomes.includes(t("automations.builder.claude.outcomeN", { n }))) n += 1;
    return t("automations.builder.claude.outcomeN", { n });
  };
  const setFields = (fields: DataField[]) => set({ fields } as Partial<Step>);
  const nextKey = () => {
    let n = step.fields.length + 1;
    while (step.fields.some((f) => f.key === `${step.id}.f${n}`)) n += 1;
    return `${step.id}.f${n}`;
  };

  return (
    <>
      <div className="mx-5 mb-4 flex gap-3 rounded-md border border-dashed border-rule-strong px-3 py-2.5">
        <p data-claude-rule className="text-sm text-ink">
          {t("automations.builder.claude.rule")}
        </p>
      </div>
      <Section title={t("automations.builder.claude.instruction")}>
        <div className="flex min-w-0 flex-col gap-1.5">
          <DataText
            label={t("automations.builder.claude.instruction")}
            value={step.instruction}
            onChange={(v) => set({ instruction: v } as Partial<Step>)}
            path={path}
            multiline
            rows={4}
            describedBy={instruction.describedBy}
            invalid={instruction.invalid}
          />
          {instruction.error}
        </div>
      </Section>
      <Section title={t("automations.builder.claude.canRead")}>
        {inputs.length === 0 ? (
          <Note>{t("automations.builder.claude.nothingToRead")}</Note>
        ) : (
          <div className="flex flex-col">
            {inputs.map((key) => {
              const on = step.inputs.includes(key);
              const here = readable.some((f) => f.key === key);
              return (
                <label
                  key={key}
                  className={`flex min-h-8 items-center gap-2 text-md ${here ? "text-ink" : "text-critical line-through"}`}
                >
                  <input
                    type="checkbox"
                    className="accent-ink"
                    checked={on}
                    onChange={() =>
                      set({
                        inputs: on ? step.inputs.filter((k) => k !== key) : [...step.inputs, key],
                      } as Partial<Step>)
                    }
                  />
                  {tokenLabel(b.flow, key, b.labels)}
                </label>
              );
            })}
          </div>
        )}
      </Section>
      <Section title={t("automations.builder.claude.outcomes")}>
        <ul
          aria-describedby={outcomesP.describedBy ?? answer.describedBy}
          className="flex flex-col gap-1.5"
        >
          {step.outcomes.map((o, i) => {
            const value = drafts[i] ?? o;
            const problem = drafts[i] === undefined ? null : outcomeProblem(i, value);
            const errorId = `${path}-outcome-${i}`;
            return (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={t("automations.builder.claude.outcomeName", { n: i + 1 })}
                  aria-invalid={problem !== null || undefined}
                  aria-describedby={problem ? errorId : undefined}
                  className={`${smallInput} flex-1 ${problem ? "border-critical" : ""}`}
                  value={value}
                  onChange={(e) => typeOutcome(i, e.target.value.replace(/\//g, ""))}
                  onBlur={() => clearDraft(i)}
                />
                <span className="text-xs text-ink-faint">
                  {t("automations.builder.claude.branch")}
                </span>
                {!b.readOnly && (
                  <button
                    type="button"
                    aria-label={t("automations.builder.claude.removeOutcome", { name: o })}
                    className="h-7 rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
                    onClick={() =>
                      (step.branches[o]?.length ?? 0) > 0 ? setRemoving(o) : removeOutcome(o)
                    }
                  >
                    {t("automations.builder.claude.remove")}
                  </button>
                )}
                {problem && (
                  <span className="basis-full">
                    <FieldError id={errorId}>
                      {t("automations.builder.claude.outcomeKept", { problem, name: o })}
                    </FieldError>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {outcomesP.error}
        {!b.readOnly && depth >= MAX_DEPTH && step.outcomes.length === 0 && (
          <Note>{t("automations.builder.add.tooDeep")}</Note>
        )}
        {!b.readOnly && step.outcomes.length < MAX && depth < MAX_DEPTH && (
          <button
            type="button"
            className="h-7 w-fit rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
            onClick={() => set({ outcomes: [...step.outcomes, nextOutcome()] } as Partial<Step>)}
          >
            {t("automations.builder.claude.addOutcome")}
          </button>
        )}
      </Section>
      <Section title={t("automations.builder.claude.fields")}>
        <ul className="flex flex-col gap-2">
          {step.fields.map((f, i) => (
            <FieldRow
              key={f.key}
              field={f}
              n={i + 1}
              onChange={(next) => setFields(step.fields.map((x, k) => (k === i ? next : x)))}
              onRemove={() => setFields(step.fields.filter((_, k) => k !== i))}
            />
          ))}
        </ul>
        {!b.readOnly && (
          <button
            type="button"
            className="h-7 w-fit rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
            onClick={() => setFields([...step.fields, { key: nextKey(), label: "", type: "text" }])}
          >
            {t("automations.builder.claude.addField")}
          </button>
        )}
        {answer.error}
      </Section>
      <p className="px-5 pt-2 text-sm text-ink-muted">{t("automations.builder.claude.mismatch")}</p>
      {removing !== null && (
        <Dialog
          title={t("automations.builder.claude.removeTitle", { name: removing })}
          width={440}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setRemoving(null)}>
                {t("automations.actions.cancel")}
              </button>
              <button
                type="button"
                className={dangerSolidButton}
                onClick={() => {
                  removeOutcome(removing);
                  setRemoving(null);
                }}
              >
                {t("automations.actions.delete")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">
            {t("automations.builder.claude.removeBody", {
              count: (step.branches[removing] ?? []).reduce((n, s) => n + 1 + innerCount(s), 0),
            })}
          </p>
        </Dialog>
      )}
    </>
  );
}

function FieldRow({
  field,
  n,
  onChange,
  onRemove,
}: {
  field: DataField;
  n: number;
  onChange: (f: DataField) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const sub = field.of ?? [];
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          aria-label={t("automations.builder.claude.fieldName", { n })}
          placeholder={t("automations.builder.claude.fieldPlaceholder")}
          className={`${smallInput} min-w-0 flex-1 ${field.label.trim() === "" ? "border-critical" : ""}`}
          value={field.label}
          onChange={(e) => onChange({ ...field, label: e.target.value })}
        />
        <select
          aria-label={t("automations.builder.claude.fieldType", { n })}
          className={`${selectClass} w-36`}
          value={field.type}
          onChange={(e) => {
            const type = e.target.value as DataField["type"];
            onChange(
              type === "list"
                ? { ...field, type, of: field.of ?? [] }
                : { key: field.key, label: field.label, type },
            );
          }}
        >
          {FIELD_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`automations.builder.types.${x}`)}
            </option>
          ))}
        </select>
        {!b.readOnly && (
          <button
            type="button"
            aria-label={t("automations.builder.claude.removeField", { n })}
            className="h-7 rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
            onClick={onRemove}
          >
            {t("automations.builder.claude.remove")}
          </button>
        )}
      </div>
      {field.type === "list" && (
        <div className="ml-4 flex flex-col gap-1.5 border-l border-rule pl-3">
          {sub.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <input
                aria-label={t("automations.builder.claude.subName", { n: i + 1 })}
                className={`${smallInput} min-w-0 flex-1`}
                value={s.label}
                onChange={(e) =>
                  onChange({
                    ...field,
                    of: sub.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)),
                  })
                }
              />
              <select
                aria-label={t("automations.builder.claude.subType", { n: i + 1 })}
                className={`${selectClass} w-32`}
                value={s.type}
                onChange={(e) =>
                  onChange({
                    ...field,
                    of: sub.map((x, k) =>
                      k === i ? { ...x, type: e.target.value as DataField["type"] } : x,
                    ),
                  })
                }
              >
                {SUB_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`automations.builder.types.${x}`)}
                  </option>
                ))}
              </select>
              {!b.readOnly && (
                <button
                  type="button"
                  aria-label={t("automations.builder.claude.removeSub", { n: i + 1 })}
                  className="h-7 rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
                  onClick={() => onChange({ ...field, of: sub.filter((_, k) => k !== i) })}
                >
                  {t("automations.builder.claude.remove")}
                </button>
              )}
            </div>
          ))}
          {!b.readOnly && sub.length < MAX && (
            <button
              type="button"
              className="h-7 w-fit rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
              onClick={() => {
                let k = sub.length + 1;
                while (sub.some((x) => x.key === `c${k}`)) k += 1;
                onChange({ ...field, of: [...sub, { key: `c${k}`, label: "", type: "text" }] });
              }}
            >
              {t("automations.builder.claude.addSub")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
