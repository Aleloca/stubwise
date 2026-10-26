import { useId } from "react";
import { useTranslation } from "react-i18next";
import { templateRefs } from "../../../domain/automations/validate";
import type { Step } from "../../../data/types";
import { Field, Segmented, smallInput } from "./controls";
import { DataText, FieldError } from "./DataText";
import type { FieldProblem } from "./issues";

// I pezzi comuni dei moduli del pannello: il problema di un campo, il campo
// con dati, la scadenza, i ruoli scelti nei menu, i tipi dei moduli.

/** Il problema di un campo, se c'è: id per `aria-describedby` e il paragrafo. */
export function useFieldProblem(problems: FieldProblem[], field: string) {
  const id = useId();
  const p = problems.find((x) => x.field === field);
  return {
    describedBy: p ? id : undefined,
    invalid: !!p,
    error: p ? <FieldError id={id}>{p.text}</FieldError> : null,
  };
}

export interface FormProps {
  step: Step;
  path: string;
  set: (next: Partial<Step>) => void;
  problems: FieldProblem[];
}

export type Of<K extends Step["kind"]> = Extract<Step, { kind: K }>;
export type KindProps<K extends Step["kind"]> = Omit<FormProps, "step"> & { step: Of<K> };

/** Un campo con dati e il suo problema. */
export function TextField({
  label,
  field,
  value,
  onChange,
  path,
  problems,
  required,
  multiline,
  rows,
  types,
}: {
  label: string;
  field: string;
  value: string;
  onChange: (v: string) => void;
  path: string;
  problems: FieldProblem[];
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  types?: Parameters<typeof DataText>[0]["types"];
}) {
  const id = useId();
  // Il problema del campo, e i dati che il campo cita e che qui non ci sono.
  const refs = templateRefs(value);
  const list = problems.filter(
    (x) => x.field === field || (x.ref !== undefined && refs.includes(x.ref)),
  );
  return (
    <Field label={label} required={required}>
      <DataText
        label={label}
        value={value}
        onChange={onChange}
        path={path}
        multiline={multiline}
        rows={rows}
        describedBy={list.length > 0 ? id : undefined}
        invalid={list.length > 0}
        types={types}
      />
      {list.length > 0 && (
        <div id={id}>
          {list.map((x, i) => (
            <FieldError key={i} id={`${id}-${i}`}>
              {x.text}
            </FieldError>
          ))}
        </div>
      )}
    </Field>
  );
}

export function DueField({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <Field label={t("automations.builder.panel.due")}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={t("automations.builder.panel.due")}
          value={value === null ? "none" : "days"}
          options={[
            { value: "none", label: t("automations.builder.panel.noDue") },
            { value: "days", label: t("automations.builder.panel.dueAfter") },
          ]}
          onChange={(v) => onChange(v === "none" ? null : 2)}
        />
        {value !== null && (
          <span className="flex items-center gap-1.5 text-sm text-ink-muted">
            <input
              id={id}
              type="number"
              min={0}
              aria-label={t("automations.builder.panel.dueDays")}
              className={`${smallInput} w-16`}
              value={value}
              onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
            />
            {t("automations.builder.panel.daysAfterCreated", { count: value })}
          </span>
        )}
      </div>
    </Field>
  );
}

export const ROLES = ["project_lead", "developer", "contributor"];
