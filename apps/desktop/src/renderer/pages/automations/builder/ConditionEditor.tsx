import { useId } from "react";
import { useTranslation } from "react-i18next";
import { availableFields } from "../../../domain/automations/fields";
import type { Condition, DataField, Operand } from "../../../data/types";
import { useBuilder } from "./context";
import { tokenLabel } from "./DataText";
import { selectClass, smallInput } from "./controls";

// Il costruttore di condizioni (shape builder §6, [A 18]): righe «[dato]
// [operatore] [valore]», unite da «All of these» / «Any of these». Un solo
// livello di gruppo nell'interfaccia, anche se il modello ne ammette di più;
// niente espressioni scritte. Gli operatori sono parole secondo il tipo del
// dato; un sì/no si confronta con «yes»/«no» (R-J6).

type Op = NonNullable<Condition["op"]>;

const OPS: Record<DataField["type"], Op[]> = {
  text: ["is", "is_not", "contains", "empty", "not_empty"],
  email: ["is", "is_not", "contains", "empty", "not_empty"],
  person: ["is", "is_not", "empty", "not_empty"],
  list: ["contains", "empty", "not_empty"],
  file: ["empty", "not_empty"],
  number: ["is", "is_not", "gt", "lt", "empty", "not_empty"],
  date: ["is", "is_not", "lt", "gt", "empty", "not_empty"],
  boolean: ["is", "is_not"],
};

/** La condizione come gruppo di un livello: `all` o `any` di confronti. */
export function asGroup(c: Condition): { mode: "all" | "any"; rows: Condition[] } {
  if (c.any) return { mode: "any", rows: c.any };
  if (c.all) return { mode: "all", rows: c.all };
  return { mode: "all", rows: [c] };
}

export function ConditionEditor({
  value,
  onChange,
  path,
  label,
  describedBy,
}: {
  value: Condition;
  onChange: (c: Condition) => void;
  /** Il percorso del passo: i dati sono quelli che vede lì. */
  path: string;
  label: string;
  describedBy?: string;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const id = useId();
  const fields = availableFields(b.flow, path, b.sources);
  const { mode, rows } = asGroup(value);
  const write = (m: "all" | "any", next: Condition[]) =>
    onChange(m === "all" ? { all: next } : { any: next });
  const setRow = (i: number, row: Condition) =>
    write(
      mode,
      rows.map((r, k) => (k === i ? row : r)),
    );

  return (
    <fieldset
      aria-label={label}
      aria-describedby={describedBy}
      disabled={b.readOnly}
      className="flex min-w-0 flex-col gap-2"
    >
      {rows.length > 1 && (
        <select
          aria-label={t("automations.builder.condition.join")}
          className={`${selectClass} w-fit`}
          value={mode}
          onChange={(e) => write(e.target.value as "all" | "any", rows)}
        >
          <option value="all">{t("automations.builder.condition.all")}</option>
          <option value="any">{t("automations.builder.condition.any")}</option>
        </select>
      )}
      {rows.map((row, i) => (
        <Row
          key={i}
          n={i + 1}
          row={row}
          fields={fields}
          id={`${id}-${i}`}
          onChange={(r) => setRow(i, r)}
          onRemove={
            rows.length > 1
              ? () =>
                  write(
                    mode,
                    rows.filter((_, k) => k !== i),
                  )
              : undefined
          }
        />
      ))}
      {!b.readOnly && (
        <button
          type="button"
          className="h-7 w-fit rounded-md px-1.5 text-sm text-ink-muted hover:bg-ink/6 hover:text-ink"
          onClick={() => write(mode, [...rows, {}])}
        >
          {t("automations.builder.condition.add")}
        </button>
      )}
    </fieldset>
  );
}

function Row({
  n,
  row,
  fields,
  id,
  onChange,
  onRemove,
}: {
  n: number;
  row: Condition;
  fields: DataField[];
  id: string;
  onChange: (c: Condition) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const b = useBuilder();
  const leftKey = row.left && "ref" in row.left ? row.left.ref : "";
  const left = fields.find((f) => f.key === leftKey);
  const missing = leftKey !== "" && !left;
  const ops = left ? OPS[left.type] : OPS.text;
  const op = row.op && ops.includes(row.op) ? row.op : undefined;
  const unary = op === "empty" || op === "not_empty";
  const right = row.right;
  const rightRef = right && "ref" in right ? right.ref : null;
  const sameType = fields.filter((f) => left && f.type === left.type && f.key !== leftKey);
  const opWord = (o: Op) =>
    t(
      `automations.builder.condition.op.${left?.type === "date" && (o === "gt" || o === "lt") ? `date_${o}` : o}`,
    );

  const setRight = (r: Operand | undefined) => onChange({ ...row, right: r });
  return (
    <div
      role="group"
      aria-label={t("automations.builder.condition.row", { n })}
      className="flex flex-wrap items-center gap-1.5"
    >
      <select
        aria-label={t("automations.builder.condition.data")}
        aria-invalid={missing || undefined}
        className={`${selectClass} max-w-48 ${missing ? "border-critical text-critical line-through" : ""}`}
        value={leftKey}
        onChange={(e) =>
          onChange({ left: { ref: e.target.value }, op: undefined, right: undefined })
        }
      >
        <option value="" disabled>
          {t("automations.builder.condition.chooseData")}
        </option>
        {missing && <option value={leftKey}>{tokenLabel(b.flow, leftKey, b.labels)}</option>}
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {tokenLabel(b.flow, f.key, b.labels)}
          </option>
        ))}
      </select>
      <select
        aria-label={t("automations.builder.condition.operator")}
        className={`${selectClass} max-w-40`}
        value={op ?? ""}
        disabled={!left}
        onChange={(e) => {
          const next = e.target.value as Op;
          const u = next === "empty" || next === "not_empty";
          onChange({
            ...row,
            op: next,
            right: u
              ? undefined
              : (row.right ?? (left?.type === "boolean" ? { value: true } : undefined)),
          });
        }}
      >
        <option value="" disabled>
          {t("automations.builder.condition.chooseOp")}
        </option>
        {ops.map((o) => (
          <option key={o} value={o}>
            {opWord(o)}
          </option>
        ))}
      </select>
      {left && op && !unary && (
        <>
          {left.type === "boolean" ? (
            <select
              aria-label={t("automations.builder.condition.value")}
              className={`${selectClass} w-24`}
              value={right && "value" in right && right.value === false ? "false" : "true"}
              onChange={(e) => setRight({ value: e.target.value === "true" })}
            >
              <option value="true">{t("automations.condition.true")}</option>
              <option value="false">{t("automations.condition.false")}</option>
            </select>
          ) : (
            <>
              {sameType.length > 0 && (
                <select
                  aria-label={t("automations.builder.condition.valueKind")}
                  className={`${selectClass} max-w-40`}
                  value={rightRef ?? ""}
                  onChange={(e) =>
                    setRight(e.target.value ? { ref: e.target.value } : { value: "" })
                  }
                >
                  <option value="">{t("automations.builder.condition.typeValue")}</option>
                  {sameType.map((f) => (
                    <option key={f.key} value={f.key}>
                      {tokenLabel(b.flow, f.key, b.labels)}
                    </option>
                  ))}
                </select>
              )}
              {rightRef === null && (
                <input
                  id={id}
                  aria-label={t("automations.builder.condition.value")}
                  type={left.type === "number" ? "number" : left.type === "date" ? "date" : "text"}
                  className={`${smallInput} w-40`}
                  value={
                    right && "value" in right && right.value !== null ? String(right.value) : ""
                  }
                  onChange={(e) =>
                    setRight({
                      value:
                        left.type === "number" && e.target.value !== ""
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              )}
            </>
          )}
        </>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={t("automations.builder.condition.remove", { n })}
          className="grid size-7 place-items-center rounded-md text-ink-faint hover:bg-ink/6 hover:text-ink"
          onClick={onRemove}
        >
          <svg
            viewBox="0 0 16 16"
            width={14}
            height={14}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}
