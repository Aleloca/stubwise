import { useId } from "react";
import { useTranslation } from "react-i18next";
import { templateRefs } from "../../../domain/automations/validate";
import type { Step } from "../../../data/types";
import { availableFields } from "../../../domain/automations/fields";
import { usePeople } from "../../../data/queries";
import { useBuilder } from "./context";
import { Field, Segmented, selectClass, smallInput } from "./controls";
import { DataText, FieldError, tokenLabel } from "./DataText";
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

/**
 * Una persona: scelta fra le persone, o il dato Persona dell'inizio o di un
 * passo (prima i dati, che seguono l'evento; poi le persone). Il valore è
 * `{ personId }` o `{ personRef }`: mai un testo libero.
 */
export function PersonPicker({
  value,
  onChange,
  label,
  path,
  describedBy,
  invalid,
}: {
  value: { personId: string } | { personRef: string };
  onChange: (v: { personId: string } | { personRef: string }) => void;
  label: string;
  path: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const people = usePeople().data ?? [];
  const data = availableFields(b.flow, path, b.sources).filter((f) => f.type === "person");
  const ref = "personRef" in value ? value.personRef : null;
  const current =
    ref !== null
      ? `ref:${ref}`
      : "personId" in value && value.personId
        ? `id:${value.personId}`
        : "";
  const missing = ref !== null && ref !== "" && !data.some((f) => f.key === ref);
  return (
    <select
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      className={selectClass}
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v.startsWith("ref:") ? { personRef: v.slice(4) } : { personId: v.slice(3) });
      }}
    >
      <option value="" disabled>
        {t("automations.builder.panel.choosePerson")}
      </option>
      {(data.length > 0 || missing) && (
        <optgroup label={t("automations.builder.panel.fromData")}>
          {missing && <option value={current}>{tokenLabel(b.flow, ref, b.labels)}</option>}
          {data.map((f) => (
            <option key={f.key} value={`ref:${f.key}`}>
              {tokenLabel(b.flow, f.key, b.labels)}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label={t("automations.builder.panel.people")}>
        {people
          .filter((p) => !p.isClaude)
          .map((p) => (
            <option key={p.id} value={`id:${p.id}`}>
              {p.name}
            </option>
          ))}
      </optgroup>
    </select>
  );
}
